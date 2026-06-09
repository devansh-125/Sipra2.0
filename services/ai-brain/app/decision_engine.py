"""
Decision engine.

Takes a PredictResponse + open anomalies + organ urgency, runs an
explicit rule pipeline, and emits a Decision with a rule_path so every
output is traceable to the rules that produced it.

Rules in order of precedence (first match wins for terminal actions):

  R1 ABORT
     - Critical anomaly that contradicts the prediction
       (route deviation > 5 km AND no progress in last 5 min).
     - The ambulance is not on the trip we think it is on.

  R2 DISPATCH_DRONE
     - breach_probability >= drone threshold from active model, OR
     - urgency_tier == CRITICAL AND will_breach == TRUE.
     The drone is the failsafe for the golden hour.

  R3 ACTIVATE_CORRIDOR
     - breach_probability >= boost threshold AND no corridor active yet.
     - The dashboard's CorridorMap subscribes to this.

  R4 REROUTE
     - Deviation anomaly open AND backbone == google_routes_gnn
     - We trust Google's reroute over the original plan once the
       ambulance has visibly diverged.

  R5 REQUEST_BOUNTY_BOOST
     - breach_probability >= boost threshold (and a corridor exists).
     - Surfaces to the bounty engine to raise partner-fleet incentives.

  R6 CONTINUE
     - Default.

Confidence is taken from the prediction's ai_confidence and lowered if
contradictory anomalies are present (open critical anomaly halves it).

The decision references the prediction_id so the full lineage —
inputs → factors → prediction → decision — is queryable in one join.
"""
from __future__ import annotations

from typing import Optional
from uuid import UUID

from .domain import (
    Anomaly, AnomalyKind, AnomalySeverity, Decision, DecisionAction, Factor,
    PredictResponse, UrgencyTier,
)
from .predictor import ModelParams


def _factor(name: str, value: float, unit: str, desc: str, cite: str) -> Factor:
    return Factor(name=name, value=value, unit=unit, description=desc, citation=cite)


def decide(
    prediction:    PredictResponse,
    *,
    anomalies:     list[Anomaly],
    mp:            ModelParams,
    corridor_active: bool,
    prediction_id: Optional[UUID] = None,
) -> Decision:
    rule_path: list[str] = []
    factors:   list[Factor] = []
    confidence = float(prediction.ai_confidence)

    open_anoms = [a for a in anomalies if True]
    crit_open  = [a for a in open_anoms if a.severity is AnomalySeverity.CRITICAL]
    deviation  = next((a for a in open_anoms if a.kind is AnomalyKind.ROUTE_DEVIATION), None)
    no_prog    = next((a for a in open_anoms if a.kind is AnomalyKind.NO_PROGRESS), None)

    if crit_open:
        confidence = max(0.0, confidence * 0.5)
        factors.append(_factor(
            "critical_anomaly_present",
            float(len(crit_open)),
            "count",
            "One or more critical anomalies open against this trip.",
            "Sipra anomaly engine.",
        ))

    # R1 ABORT
    if deviation and no_prog:
        rule_path.append("R1:abort_deviation_and_no_progress")
        return Decision(
            trip_id=prediction.trip_id,
            action=DecisionAction.ABORT,
            confidence=max(0.5, confidence),
            rule_path=rule_path,
            factors=factors + [_factor(
                "abort_reason", 1.0, "flag",
                "Route deviation + no-progress: trip cannot be safely continued under current plan.",
                "Sipra rule R1.",
            )],
            prediction_id=prediction_id,
        )

    # R2 DISPATCH_DRONE
    # Both branches require ai_confidence >= drone_min_confidence to avoid
    # firing the failsafe off a handful of ramp-up pings. The predictor
    # attenuates ai_confidence by sample adequacy, so warm-up windows
    # naturally fail this gate even when breach_probability is mathematically 1.0.
    has_confidence = prediction.ai_confidence >= mp.recommendation_drone_min_confidence
    drone_by_prob  = (
        prediction.breach_probability >= mp.recommendation_drone_threshold
        and has_confidence
    )
    drone_by_organ = (
        (prediction.urgency_tier is UrgencyTier.CRITICAL)
        and prediction.will_breach
        and has_confidence
    )
    if drone_by_prob or drone_by_organ:
        rule_path.append(
            "R2:dispatch_drone_by_prob" if drone_by_prob
            else "R2:dispatch_drone_by_critical_organ"
        )
        factors.append(_factor(
            "drone_threshold",
            mp.recommendation_drone_threshold,
            "probability",
            "Drone-dispatch threshold from active model.",
            "Sipra rule R2.",
        ))
        factors.append(_factor(
            "drone_min_confidence",
            mp.recommendation_drone_min_confidence,
            "probability",
            "Minimum AI confidence required to commit to the irreversible drone failsafe.",
            "Sipra rule R2 — guard against small-sample false positives.",
        ))
        return Decision(
            trip_id=prediction.trip_id,
            action=DecisionAction.DISPATCH_DRONE,
            confidence=confidence,
            rule_path=rule_path,
            factors=factors,
            prediction_id=prediction_id,
        )

    # R3 ACTIVATE_CORRIDOR
    if (
        prediction.breach_probability >= mp.recommendation_boost_threshold
        and not corridor_active
    ):
        rule_path.append("R3:activate_corridor")
        factors.append(_factor(
            "boost_threshold",
            mp.recommendation_boost_threshold,
            "probability",
            "Boost threshold from active model — first crossing activates the corridor.",
            "Sipra rule R3.",
        ))
        return Decision(
            trip_id=prediction.trip_id,
            action=DecisionAction.ACTIVATE_CORRIDOR,
            confidence=confidence,
            rule_path=rule_path,
            factors=factors,
            prediction_id=prediction_id,
        )

    # R4 REROUTE
    if deviation and prediction.backbone == "google_routes_traffic_aware_optimal":
        rule_path.append("R4:reroute_after_deviation")
        factors.append(_factor(
            "deviation_reroute", 1.0, "flag",
            "Route deviation open and backbone is live Routes; trust Google's reroute.",
            "Sipra rule R4.",
        ))
        return Decision(
            trip_id=prediction.trip_id,
            action=DecisionAction.REROUTE,
            confidence=confidence,
            rule_path=rule_path,
            factors=factors,
            prediction_id=prediction_id,
        )

    # R5 REQUEST_BOUNTY_BOOST
    if prediction.breach_probability >= mp.recommendation_boost_threshold:
        rule_path.append("R5:bounty_boost")
        return Decision(
            trip_id=prediction.trip_id,
            action=DecisionAction.REQUEST_BOUNTY_BOOST,
            confidence=confidence,
            rule_path=rule_path,
            factors=factors,
            prediction_id=prediction_id,
        )

    # R6 CONTINUE
    rule_path.append("R6:continue")
    return Decision(
        trip_id=prediction.trip_id,
        action=DecisionAction.CONTINUE,
        confidence=confidence,
        rule_path=rule_path,
        factors=factors,
        prediction_id=prediction_id,
    )
