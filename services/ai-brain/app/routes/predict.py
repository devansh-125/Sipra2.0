"""
POST /predict — primary inference endpoint.

Locked wire contract. Extensions are additive (factors, model_version,
backbone, urgency_tier, prediction_id) so existing core-go callers keep
working without coordinated rollouts.

Side effects (best-effort, never fail the response):
  - persist the full input + factors + outputs to ai.predictions
  - update ai.trip_state with the latest recommendation
  - append to ai.audit_log
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Request

from ..db import pool
from ..domain import PredictRequest, PredictResponse
from ..predictor import params_from_active, run_prediction
from ..repos import AuditRepo, ModelRegistry, PredictionsRepo, TripStateRepo

router = APIRouter()


@router.post("/predict", response_model=PredictResponse)
async def predict(req: PredictRequest, request: Request) -> PredictResponse:
    p = pool()
    registry     = ModelRegistry(p)
    predictions  = PredictionsRepo(p)
    state        = TripStateRepo(p)
    audit        = AuditRepo(p)

    active = await registry.get_active()
    mp     = params_from_active(active)

    outcome = await run_prediction(req, mp)
    resp    = outcome.response

    # Persist (best-effort). Failures here must not fail the API call.
    try:
        prediction_id = await predictions.insert(
            trip_id=req.trip_id,
            model_version=mp.version,
            inputs=req.model_dump(mode="json"),
            factors=outcome.explanation.factors,
            backbone=outcome.explanation.backbone,
            predicted_eta_seconds=resp.predicted_eta_seconds,
            deadline_seconds_remaining=resp.deadline_seconds_remaining,
            breach_probability=resp.breach_probability,
            will_breach=resp.will_breach,
            recommendation=resp.recommendation,
            ai_confidence=resp.ai_confidence,
            latency_ms=outcome.latency_ms,
        )
        if prediction_id is not None:
            resp.prediction_id = prediction_id

        await state.upsert_after_predict(
            trip_id=req.trip_id,
            organ_type=req.organ_type.value if req.organ_type else None,
            recommendation=resp.recommendation,
            breach_prob=resp.breach_probability,
            last_predict_at=datetime.now(tz=timezone.utc),
        )

        request_id = request.headers.get("x-request-id")
        await audit.append(
            actor="ai-brain",
            action="predict",
            trip_id=req.trip_id,
            request_id=request_id,
            payload={
                "model_version":  mp.version,
                "recommendation": resp.recommendation,
                "backbone":       outcome.explanation.backbone,
                "latency_ms":     outcome.latency_ms,
            },
        )
    except Exception:
        # Persistence is best-effort; the prediction itself already exists
        # in the response. Keep the API resilient to DB hiccups.
        pass

    return resp
