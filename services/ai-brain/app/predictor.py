"""
Predictor — base ETA + residual correction, model-versioned.

Architecture mirrors the production pattern published by Uber and Google:

  Base ETA from a traffic-aware routing engine
  + thin residual correction layered on top
  = predicted ETA

Backbone: Google Routes API v2 `computeRoutes` with TRAFFIC_AWARE_OPTIMAL.
The duration this returns is produced by Google's GNN ETA model:
  Derrow-Pinion et al., "ETA Prediction with Graph Neural Networks in
  Google Maps", CIKM 2021 — https://arxiv.org/abs/2108.11482

Residual correction follows Uber DeepETA (Uber Engineering, 2022). DeepETA
is a transformer that learns the residual between the routing engine's base
ETA and the realised time. We approximate that with a small set of explicit,
citation-backed correction factors. Each factor is published in the response
as a Factor object so a clinician can audit the prediction without reading
any model weights.

Constants live in the active model_runs row so the calibration loop can
update them without a redeploy.
"""
from __future__ import annotations

import math
import statistics
import time
from dataclasses import dataclass
from typing import Any, Optional

from .domain import (
    Explanation, Factor, LatLng, OrganType, PredictRequest, PredictResponse,
    UrgencyTier, urgency_tier,
)
from .integrations import fetch_route, fetch_weather, haversine_meters


# ---------------------------------------------------------------------
# Model-parameter view
# ---------------------------------------------------------------------

@dataclass(frozen=True)
class ModelParams:
    version: str
    ambulance_priority_factor:        float
    free_flow_density:                int
    density_penalty_per_vehicle:      float
    density_penalty_cap:              float
    breach_sigmoid_scale_seconds:     int
    recommendation_boost_threshold:   float
    recommendation_drone_threshold:   float
    recommendation_drone_min_confidence: float
    min_observations_for_full_confidence: int
    road_distance_multiplier_fallback: float
    weather_factors:                  dict[str, float]


# Bootstrap params if DB is unreachable (matches the seed in migrations.sql).
BOOTSTRAP_PARAMS = ModelParams(
    version="v0-bootstrap",
    ambulance_priority_factor=0.80,
    free_flow_density=5,
    density_penalty_per_vehicle=0.015,
    density_penalty_cap=1.30,
    breach_sigmoid_scale_seconds=300,
    recommendation_boost_threshold=0.40,
    recommendation_drone_threshold=0.85,
    recommendation_drone_min_confidence=0.70,
    min_observations_for_full_confidence=5,
    road_distance_multiplier_fallback=1.4,
    weather_factors={
        "clear":      1.00,
        "light_rain": 1.10,
        "heavy_rain": 1.25,
        "fog":        1.20,
        "storm":      1.40,
        "snow":       1.40,
    },
)


def params_from_active(active: Optional[dict[str, Any]]) -> ModelParams:
    if not active:
        return BOOTSTRAP_PARAMS
    p = active["parameters"]
    return ModelParams(
        version=active["version"],
        ambulance_priority_factor=float(p["ambulance_priority_factor"]),
        free_flow_density=int(p["free_flow_density"]),
        density_penalty_per_vehicle=float(p["density_penalty_per_vehicle"]),
        density_penalty_cap=float(p["density_penalty_cap"]),
        breach_sigmoid_scale_seconds=int(p["breach_sigmoid_scale_seconds"]),
        recommendation_boost_threshold=float(p["recommendation_boost_threshold"]),
        recommendation_drone_threshold=float(p["recommendation_drone_threshold"]),
        recommendation_drone_min_confidence=float(
            p.get("recommendation_drone_min_confidence", 0.70)
        ),
        min_observations_for_full_confidence=int(
            p.get("min_observations_for_full_confidence", 5)
        ),
        road_distance_multiplier_fallback=float(p["road_distance_multiplier_fallback"]),
        weather_factors={k: float(v) for k, v in p["weather_factors"].items()},
    )


# ---------------------------------------------------------------------
# Pure math
# ---------------------------------------------------------------------

def fleet_penalty_for_density(density: int, mp: ModelParams) -> float:
    excess = max(0, density - mp.free_flow_density)
    penalty = 1.0 + mp.density_penalty_per_vehicle * excess
    return min(penalty, mp.density_penalty_cap)


def breach_probability(buffer_seconds: int, mp: ModelParams) -> float:
    return round(1.0 / (1.0 + math.exp(buffer_seconds / mp.breach_sigmoid_scale_seconds)), 4)


def recommend(prob: float, mp: ModelParams) -> str:
    if prob >= mp.recommendation_drone_threshold:
        return "DISPATCH_DRONE"
    if prob >= mp.recommendation_boost_threshold:
        return "REQUEST_BOUNTY_BOOST"
    return "CONTINUE"


def robust_speed_kph(speeds: list[float]) -> tuple[float, str]:
    """
    Outlier-robust speed estimator used as the residual signal.

    A handful of ramp-up samples (e.g. ambulance accelerating from rest)
    drag the mean down and create false-positive breach predictions. We
    drop the min/max once the sample has 5+ points and take the median;
    smaller samples fall back to the simple median or mean. Returns
    (kph, label) for the audit factor.
    """
    if not speeds:
        return 1.0, "no_observations"
    if len(speeds) >= 5:
        ordered = sorted(speeds)
        trimmed = ordered[1:-1]  # drop one min + one max
        return max(1.0, statistics.median(trimmed)), "trimmed_median"
    if len(speeds) >= 3:
        return max(1.0, statistics.median(speeds)), "median"
    return max(1.0, statistics.fmean(speeds)), "fmean_warmup"


# ---------------------------------------------------------------------
# Prediction pipeline
# ---------------------------------------------------------------------

@dataclass
class PredictionOutcome:
    response:    PredictResponse
    explanation: Explanation
    latency_ms:  int


async def run_prediction(req: PredictRequest, mp: ModelParams) -> PredictionOutcome:
    t0 = time.monotonic()
    factors: list[Factor] = []

    # 1) Backbone — Google's GNN duration if reachable, else haversine fallback.
    route = await fetch_route(req.current_position, req.destination,
                              fallback_multiplier=mp.road_distance_multiplier_fallback)
    road_m = float(route["distance_meters"])
    backbone_source = route["source"]

    factors.append(Factor(
        name="backbone_distance_m",
        value=road_m,
        unit="m",
        description="Routing-engine road distance, or haversine × 1.4 fallback.",
        citation="Google Routes API v2; haversine 1.4 multiplier — empirical urban-India road factor.",
    ))

    # 2) Live weather → FHWA category → multiplier from active model.
    weather_condition, _wsource = await fetch_weather(req.current_position)
    weather_factor = mp.weather_factors.get(weather_condition, 1.0)
    factors.append(Factor(
        name="weather_factor",
        value=weather_factor,
        unit="multiplier",
        description=f"Weather category {weather_condition!r}; multiplier from FHWA road-impact table.",
        citation="FHWA, How Do Weather Events Impact Roads, ops.fhwa.dot.gov/weather/q1_roadimpact.htm.",
    ))

    # 3) Observed-speed signal. Trimmed-median rejects ramp-up outliers
    # (e.g. first 2 pings during acceleration from rest) that would
    # otherwise pull the residual far below realised flow.
    observed_avg_kph, speed_estimator = robust_speed_kph(req.recent_speeds_kph)
    factors.append(Factor(
        name="observed_avg_speed_kph",
        value=observed_avg_kph,
        unit="kph",
        description=(
            f"{speed_estimator} of last {len(req.recent_speeds_kph)} ambulance pings "
            f"(robust to ramp-up outliers)."
        ),
        citation="Uber DeepETA — observed-speed residual; trimmed estimator from robust stats.",
    ))

    # 4) Fleet density penalty.
    fp = fleet_penalty_for_density(req.fleet_density_in_corridor, mp)
    factors.append(Factor(
        name="fleet_penalty",
        value=fp,
        unit="multiplier",
        description=(
            f"Density {req.fleet_density_in_corridor} vehicles in 2 km corridor; "
            f"+{mp.density_penalty_per_vehicle*100:.1f}%/vehicle above {mp.free_flow_density}, "
            f"capped at +{(mp.density_penalty_cap-1)*100:.0f}%."
        ),
        citation="Highway Capacity Manual (TRB) density-vs-speed curve.",
    ))

    # 5) Effective speed (used only when no backbone duration).
    #
    # During the warm-up window (few pings), a single slow ramp-up sample can
    # collapse `observed_avg_kph` to ~20 kph and make the ETA wildly pessimistic
    # over a 100 km route. Blend the observed signal with a cruise-speed prior
    # using sample_adequacy = n_obs / target as the weight. With 1 ping
    # (adequacy 0.2), the prior dominates (80 % cruise + 20 % observed); once
    # the AI has its full 5-ping sample, the observed median takes over.
    #
    # The cruise prior is a conservative ambulance-with-priority cruise on
    # NH-class roads in our demo region — slow enough not to mask a real
    # breach, fast enough to absorb a single accelerating-from-rest sample.
    CRUISE_PRIOR_KPH = 60.0
    n_obs = len(req.recent_speeds_kph)
    sample_adequacy_for_speed = min(
        1.0, n_obs / max(1, mp.min_observations_for_full_confidence)
    )
    blended_observed_kph = (
        observed_avg_kph * sample_adequacy_for_speed
        + CRUISE_PRIOR_KPH * (1.0 - sample_adequacy_for_speed)
    )
    effective_kph = (
        blended_observed_kph * (1.0 / mp.ambulance_priority_factor)
    ) / (weather_factor * fp)

    # 6) Predicted ETA.
    if route["duration_seconds"] is not None:
        base_eta_s = float(route["duration_seconds"])
        deviation_residual = observed_avg_kph / max(
            1.0, road_m / max(1.0, base_eta_s) * 3.6
        )
        deviation_residual = max(0.5, min(1.5, deviation_residual))
        predicted_eta_s = int(
            base_eta_s
            * mp.ambulance_priority_factor
            * weather_factor
            * fp
            / deviation_residual
        )
        backbone = "google_routes_gnn"
        factors.append(Factor(
            name="ambulance_priority_factor",
            value=mp.ambulance_priority_factor,
            unit="multiplier",
            description="Emergency-vehicle traversal time vs civilian flow.",
            citation="Pons & Markovchick, J Emerg Med 2002, 23(1):43-48.",
        ))
        factors.append(Factor(
            name="speed_deviation_residual",
            value=round(deviation_residual, 3),
            unit="ratio",
            description="Observed ambulance speed ÷ Google's expected civilian speed; clamped 0.5-1.5.",
            citation="Uber DeepETA — observed-vs-expected residual.",
        ))
    else:
        predicted_eta_s = int(road_m / (effective_kph / 3.6))
        backbone = "haversine_fallback"

    factors.append(Factor(
        name="predicted_eta_seconds",
        value=float(predicted_eta_s),
        unit="s",
        description="Final predicted ETA after all residual corrections.",
        citation="Sipra residual model.",
    ))

    # 7) Breach math.
    buffer_s = req.deadline_seconds_remaining - predicted_eta_s
    bp = breach_probability(buffer_s, mp)
    decision_label = recommend(bp, mp)
    will_breach = predicted_eta_s >= req.deadline_seconds_remaining

    factors.append(Factor(
        name="breach_probability",
        value=bp,
        unit="probability",
        description=f"Logistic sigmoid centred at zero buffer, scale {mp.breach_sigmoid_scale_seconds}s.",
        citation="Sipra breach model.",
    ))

    # 8) Confidence — distance from the 50/50 sigmoid midpoint, attenuated
    # by sample adequacy. A tiny sample of ramp-up pings can drive bp to 1.0
    # mathematically but the AI's belief in that signal must scale with how
    # much real data it has seen. Sample adequacy = n_obs / target_n.
    base_confidence = abs(0.5 - bp) * 2
    sample_adequacy = min(
        1.0, len(req.recent_speeds_kph) / max(1, mp.min_observations_for_full_confidence)
    )
    ai_confidence = round(base_confidence * sample_adequacy, 3)
    factors.append(Factor(
        name="sample_adequacy",
        value=round(sample_adequacy, 3),
        unit="ratio",
        description=(
            f"n_obs={len(req.recent_speeds_kph)} / "
            f"target={mp.min_observations_for_full_confidence}; "
            "scales confidence so warm-up pings don't trigger high-stakes actions."
        ),
        citation="Sipra residual model — Bayesian shrinkage with sample-size prior.",
    ))

    # 9) Urgency tier.
    organ = req.organ_type or OrganType.OTHER
    tier: UrgencyTier = urgency_tier(organ, req.deadline_seconds_remaining)

    # 10) Deterministic English reasoning (no LLM in this path).
    reasoning = (
        f"Backbone={backbone} (road {road_m / 1000:.1f} km). "
        f"Observed speed {observed_avg_kph:.1f} kph from {speed_estimator} of "
        f"last {len(req.recent_speeds_kph)} pings "
        f"(sample adequacy {sample_adequacy:.2f}). "
        f"Ambulance priority factor {mp.ambulance_priority_factor} (Pons & Markovchick 2002). "
        f"Weather {weather_condition} ×{weather_factor:.2f} (FHWA road-impact table). "
        f"Fleet density {req.fleet_density_in_corridor} → penalty ×{fp:.3f} (HCM). "
        f"Effective speed {effective_kph:.1f} kph → predicted ETA {predicted_eta_s} s. "
        f"Deadline in {req.deadline_seconds_remaining} s, buffer {buffer_s} s → "
        f"breach_prob {bp:.3f} (sigmoid scale={mp.breach_sigmoid_scale_seconds}s). "
        f"AI confidence {ai_confidence:.2f}. Urgency tier {tier.value}. "
        f"Recommendation: {decision_label}."
    )

    response = PredictResponse(
        trip_id=req.trip_id,
        predicted_eta_seconds=predicted_eta_s,
        deadline_seconds_remaining=req.deadline_seconds_remaining,
        breach_probability=bp,
        will_breach=will_breach,
        recommendation=decision_label,  # type: ignore[arg-type]
        weather_condition=weather_condition,
        weather_factor=weather_factor,
        fleet_density_in_corridor=req.fleet_density_in_corridor,
        fleet_penalty=round(fp, 3),
        effective_speed_kph=round(effective_kph, 1),
        ai_confidence=ai_confidence,
        reasoning=reasoning,
        model_version=mp.version,
        backbone=backbone_source,
        urgency_tier=tier,
        factors=factors,
    )

    explanation = Explanation(
        backbone=backbone_source,
        factors=factors,
        reasoning=reasoning,
        model_version=mp.version,
    )

    latency_ms = int((time.monotonic() - t0) * 1000)
    return PredictionOutcome(response=response, explanation=explanation, latency_ms=latency_ms)


__all__ = [
    "ModelParams",
    "BOOTSTRAP_PARAMS",
    "params_from_active",
    "fleet_penalty_for_density",
    "breach_probability",
    "recommend",
    "robust_speed_kph",
    "run_prediction",
    "PredictionOutcome",
    "haversine_meters",
    "LatLng",
]
