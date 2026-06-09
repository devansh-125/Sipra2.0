"""
Trip report generator.

Two outputs always ship together:

  - structured: a JSON timeline with predictions, decisions, anomalies,
    and prediction-accuracy metrics. Deterministic. Source of truth.
  - summary_md: a Markdown rendering. Always available; the deterministic
    body is built first, then optionally augmented with a Vertex AI
    Gemini-narrated executive summary at the top.

The narrative is purely additive — Gemini never *replaces* a deterministic
field. If Vertex is unconfigured or down, the structured + Markdown outputs
still ship; only the executive summary is omitted.

Hospital-ready: every prediction's factor list and rule path is included
in the structured output so a transplant coordinator can audit any
specific decision.
"""
from __future__ import annotations

import json
import statistics
from datetime import datetime
from typing import Any
from uuid import UUID

from .integrations import vertex_narrate
from .repos import (
    AnomaliesRepo, ActualsRepo, DecisionsRepo, PredictionsRepo, ReportsRepo,
    TripStateRepo,
)


def _percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    if len(values) == 1:
        return values[0]
    s = sorted(values)
    k = (len(s) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


async def assemble_structured(
    trip_id: UUID,
    *,
    predictions_repo: PredictionsRepo,
    decisions_repo:   DecisionsRepo,
    anomalies_repo:   AnomaliesRepo,
    actuals_repo:     ActualsRepo,
    state_repo:       TripStateRepo,
) -> dict[str, Any]:
    preds      = await predictions_repo.list_for_trip(trip_id)
    decisions  = await decisions_repo.list_for_trip(trip_id)
    anomalies  = await anomalies_repo.list_for_trip(trip_id)
    state      = await state_repo.get(trip_id)

    # Prediction-accuracy section: requires an `actuals` row.
    accuracy: dict[str, Any] = {}
    actual = None
    if state is not None:
        # No direct API; we can pull the actual via the repo helper if present.
        pass

    # Lightweight: query actuals via raw pool through one of the repos.
    if actuals_repo._pool is not None:  # pylint: disable=protected-access
        async with actuals_repo._pool.acquire() as conn:  # pylint: disable=protected-access
            row = await conn.fetchrow(
                "SELECT actual_eta_seconds, arrived_at, completion_status FROM ai.actuals WHERE trip_id = $1",
                trip_id,
            )
            if row:
                actual = dict(row)

    if actual and preds:
        actual_s = int(actual["actual_eta_seconds"])
        residuals = [
            int(p["predicted_eta_seconds"]) - actual_s
            for p in preds
        ]
        abs_res = [abs(r) for r in residuals]
        accuracy = {
            "actual_eta_seconds": actual_s,
            "completion_status":  actual["completion_status"],
            "arrived_at":         actual["arrived_at"].isoformat() if isinstance(actual["arrived_at"], datetime) else actual["arrived_at"],
            "n_predictions":      len(preds),
            "mae_seconds":        round(statistics.fmean(abs_res), 1) if abs_res else 0.0,
            "rmse_seconds":       round((statistics.fmean([r * r for r in residuals])) ** 0.5, 1) if residuals else 0.0,
            "bias_seconds":       round(statistics.fmean(residuals), 1) if residuals else 0.0,
            "p95_abs_seconds":    round(_percentile(abs_res, 0.95), 1) if abs_res else 0.0,
        }

    # Build a unified, ordered timeline.
    timeline: list[dict[str, Any]] = []
    for p in preds:
        timeline.append({
            "kind": "prediction",
            "at":   p["requested_at"].isoformat() if isinstance(p["requested_at"], datetime) else p["requested_at"],
            "data": {
                "id":                          str(p["id"]),
                "model_version":               p["model_version"],
                "backbone":                    p["backbone"],
                "predicted_eta_seconds":       p["predicted_eta_seconds"],
                "deadline_seconds_remaining":  p["deadline_seconds_remaining"],
                "breach_probability":          p["breach_probability"],
                "will_breach":                 p["will_breach"],
                "recommendation":              p["recommendation"],
                "ai_confidence":               p["ai_confidence"],
                "factors":                     p["factors"],
            },
        })
    for d in decisions:
        timeline.append({
            "kind": "decision",
            "at":   d["decided_at"].isoformat() if isinstance(d["decided_at"], datetime) else d["decided_at"],
            "data": {
                "id":            str(d["id"]),
                "prediction_id": str(d["prediction_id"]) if d["prediction_id"] else None,
                "action":        d["action"].value if hasattr(d["action"], "value") else d["action"],
                "confidence":    d["confidence"],
                "rule_path":     d["rule_path"],
                "factors":       d["factors"],
            },
        })
    for a in anomalies:
        timeline.append({
            "kind": "anomaly",
            "at":   a.detected_at.isoformat(),
            "data": {
                "kind":     a.kind.value,
                "severity": a.severity.value,
                "evidence": a.evidence,
            },
        })
    timeline.sort(key=lambda x: x["at"])

    return {
        "trip_id":   str(trip_id),
        "state":     state,
        "timeline":  timeline,
        "summary": {
            "n_predictions": len(preds),
            "n_decisions":   len(decisions),
            "n_anomalies":   len(anomalies),
            "actions_taken": sorted({
                (d["action"].value if hasattr(d["action"], "value") else d["action"])
                for d in decisions
            }),
        },
        "accuracy": accuracy,
    }


def render_markdown(structured: dict[str, Any], narrative: str | None) -> str:
    parts: list[str] = []
    parts.append(f"# Sipra Trip Report — `{structured['trip_id']}`")
    parts.append("")
    if narrative:
        parts.append("## Executive Summary (AI-narrated)")
        parts.append("")
        parts.append(narrative.strip())
        parts.append("")

    s = structured["summary"]
    parts.append("## Trip Summary")
    parts.append("")
    parts.append(f"- Predictions issued: **{s['n_predictions']}**")
    parts.append(f"- Decisions taken:    **{s['n_decisions']}**")
    parts.append(f"- Anomalies observed: **{s['n_anomalies']}**")
    parts.append(f"- Actions: {', '.join(s['actions_taken']) or '_none_'}")
    parts.append("")

    if structured.get("accuracy"):
        a = structured["accuracy"]
        parts.append("## Prediction Accuracy")
        parts.append("")
        parts.append(f"- Actual ETA:       **{a['actual_eta_seconds']} s** ({a['completion_status']})")
        parts.append(f"- Predictions:      {a['n_predictions']}")
        parts.append(f"- MAE:              {a['mae_seconds']} s")
        parts.append(f"- RMSE:             {a['rmse_seconds']} s")
        parts.append(f"- Bias:             {a['bias_seconds']} s (positive = over-estimated)")
        parts.append(f"- p95 abs error:    {a['p95_abs_seconds']} s")
        parts.append("")

    parts.append("## Timeline")
    parts.append("")
    for ev in structured["timeline"]:
        kind = ev["kind"]
        d = ev["data"]
        if kind == "prediction":
            parts.append(
                f"- **{ev['at']}** · prediction `{d['model_version']}` · "
                f"ETA {d['predicted_eta_seconds']} s vs deadline "
                f"{d['deadline_seconds_remaining']} s · breach "
                f"{d['breach_probability']:.3f} → **{d['recommendation']}**"
            )
        elif kind == "decision":
            parts.append(
                f"- **{ev['at']}** · decision **{d['action']}** "
                f"(confidence {d['confidence']:.2f}) · rules {d['rule_path']}"
            )
        elif kind == "anomaly":
            parts.append(
                f"- **{ev['at']}** · anomaly `{d['kind']}` "
                f"({d['severity']}) — {json.dumps(d['evidence'])}"
            )
    return "\n".join(parts) + "\n"


def _build_narrative_prompt(structured: dict[str, Any]) -> str:
    return (
        "You are writing a one-paragraph executive summary for a hospital "
        "transplant coordinator reviewing the post-trip report of a medical "
        "transport mission. Use only the facts in the JSON; do not invent "
        "anything. Be concrete: name the actions taken, the breach risk, "
        "and the prediction accuracy if available. Keep it under 120 words.\n\n"
        f"{json.dumps(structured, default=str, indent=2)}"
    )


async def generate_report(
    trip_id: UUID,
    *,
    predictions_repo: PredictionsRepo,
    decisions_repo:   DecisionsRepo,
    anomalies_repo:   AnomaliesRepo,
    actuals_repo:     ActualsRepo,
    state_repo:       TripStateRepo,
    reports_repo:     ReportsRepo,
    model_version:    str,
) -> dict[str, Any]:
    structured = await assemble_structured(
        trip_id,
        predictions_repo=predictions_repo,
        decisions_repo=decisions_repo,
        anomalies_repo=anomalies_repo,
        actuals_repo=actuals_repo,
        state_repo=state_repo,
    )

    narrative = await vertex_narrate(_build_narrative_prompt(structured))
    summary_md = render_markdown(structured, narrative)
    narrative_src = "vertex_ai_gemini" if narrative else "deterministic_only"

    await reports_repo.upsert(
        trip_id=trip_id,
        model_version=model_version,
        summary_md=summary_md,
        structured=structured,
        narrative_src=narrative_src,
    )

    return {
        "trip_id":       str(trip_id),
        "summary_md":    summary_md,
        "structured":    structured,
        "narrative_src": narrative_src,
    }
