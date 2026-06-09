"""
Continuous learning — residual calibration loop.

This is the *real, defensible, auditable* version of "the brain learns".
We do not retrain a black-box neural network. Instead, on a schedule (or
on-demand via /internal/learning/retrain) we:

  1. Pull every prediction that has a paired actual_eta from ai.actuals.
  2. Compute residuals: predicted - actual.
  3. Compute MAE, RMSE, bias.
  4. If bias is consistently positive (over-estimating ETA), we *gently*
     decrease the ambulance_priority_factor. If consistently negative
     (under-estimating, i.e. arriving later than predicted), we *gently*
     increase the density_penalty_per_vehicle to widen the residual.
  5. Insert a new ai.model_runs row with the new parameters and the
     metrics that motivated the change. Activate it.

Why this approach:

  - The old constants are citation-backed, so we never drift far from
    them. We bound updates to ±10% per cycle.
  - Every change is a versioned row with the metrics that justified it,
    so the audit trail is complete: which trips informed the change,
    what the error looked like before, what we changed, and when it
    activated.
  - Upgrade path: replace the heuristic adjustment in `recalibrate()`
    with a fitted regression (LightGBM, sklearn) without touching the
    surrounding loop or DB schema.
"""
from __future__ import annotations

import statistics
import uuid
from typing import Any

from .config import SETTINGS
from .repos import ModelRegistry, PredictionsRepo


CAL_LIMIT = 1000  # cap rows per cycle to bound DB load


def _bound(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _adjust(parameters: dict[str, Any], bias_s: float, mae_s: float) -> dict[str, Any]:
    """
    Heuristic, bounded parameter adjustment. Replace with a fitted model
    once we have enough labelled trips to train one.
    """
    new = dict(parameters)
    new["weather_factors"] = dict(parameters["weather_factors"])

    apf = float(new["ambulance_priority_factor"])
    dpv = float(new["density_penalty_per_vehicle"])

    # Strength of adjustment scales with bias magnitude vs MAE.
    if mae_s <= 0:
        return new
    intensity = _bound(abs(bias_s) / mae_s, 0.0, 1.0)

    if bias_s > SETTINGS.learning_drift_seconds:
        # Over-estimating ETA → ambulance moves *faster* than the model says.
        # Lower the priority factor (multiplier on base ETA) within ±10%.
        new["ambulance_priority_factor"] = round(_bound(apf * (1 - 0.05 * intensity), apf * 0.9, apf), 4)
    elif bias_s < -SETTINGS.learning_drift_seconds:
        # Under-estimating ETA → trips run longer than predicted.
        # Density penalty has been too gentle; raise per-vehicle slope ±10%.
        new["density_penalty_per_vehicle"] = round(
            _bound(dpv * (1 + 0.05 * intensity), dpv, dpv * 1.10), 5
        )
    return new


def _next_version(prev_version: str) -> str:
    if "-" in prev_version:
        head, _ = prev_version.rsplit("-", 1)
    else:
        head = prev_version
    return f"{head}-{uuid.uuid4().hex[:8]}"


async def recalibrate(
    *,
    registry: ModelRegistry,
    predictions: PredictionsRepo,
) -> dict[str, Any]:
    active = await registry.get_active()
    if not active:
        return {"status": "skipped", "reason": "no active model"}

    rows = await predictions.calibration_window(limit=CAL_LIMIT)
    n = len(rows)
    if n < SETTINGS.learning_min_samples:
        return {
            "status":  "skipped",
            "reason":  "not enough labelled trips",
            "samples": n,
            "min_samples": SETTINGS.learning_min_samples,
        }

    residuals = [int(r["predicted_eta_seconds"]) - int(r["actual_eta_seconds"]) for r in rows]
    abs_res   = [abs(x) for x in residuals]
    mae  = statistics.fmean(abs_res)
    rmse = (statistics.fmean([x * x for x in residuals])) ** 0.5
    bias = statistics.fmean(residuals)

    if abs(bias) < SETTINGS.learning_drift_seconds:
        return {
            "status":  "no_change",
            "reason":  "bias within tolerance",
            "samples": n,
            "mae":     round(mae, 1),
            "rmse":    round(rmse, 1),
            "bias":    round(bias, 1),
        }

    new_params  = _adjust(active["parameters"], bias_s=bias, mae_s=mae)
    new_version = _next_version(active["version"])

    rid = await registry.insert_run(
        version=new_version,
        parameters=new_params,
        sample_count=n,
        mae=mae,
        rmse=rmse,
        bias=bias,
        activate=True,
    )

    return {
        "status":      "activated",
        "new_run_id":  str(rid),
        "version":     new_version,
        "samples":     n,
        "mae":         round(mae, 1),
        "rmse":        round(rmse, 1),
        "bias":        round(bias, 1),
        "parameters":  new_params,
    }
