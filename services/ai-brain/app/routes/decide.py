"""
POST /decide — runs predict then decision_engine in one shot, persists
the decision, and returns both. This is the endpoint the Go core's risk
monitor will move to once /predict's caller wants the full pipeline.
"""
from __future__ import annotations

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Request
from pydantic import BaseModel

from ..db import pool
from ..decision_engine import decide as run_decide
from ..domain import Decision, PredictRequest, PredictResponse
from ..predictor import params_from_active, run_prediction
from ..repos import (
    AnomaliesRepo, AuditRepo, DecisionsRepo, ModelRegistry,
    PredictionsRepo, TripStateRepo,
)

router = APIRouter()


class DecideRequest(PredictRequest):
    corridor_active: bool = False


class DecideResponse(BaseModel):
    prediction: PredictResponse
    decision:   Decision


@router.post("/decide", response_model=DecideResponse)
async def decide(req: DecideRequest, request: Request) -> DecideResponse:
    p = pool()
    registry     = ModelRegistry(p)
    predictions  = PredictionsRepo(p)
    decisions    = DecisionsRepo(p)
    anomalies    = AnomaliesRepo(p)
    state        = TripStateRepo(p)
    audit        = AuditRepo(p)

    active = await registry.get_active()
    mp     = params_from_active(active)

    outcome = await run_prediction(
        PredictRequest(**{k: v for k, v in req.model_dump().items() if k != "corridor_active"}),
        mp,
    )

    open_anoms = await anomalies.list_for_trip(req.trip_id)
    prediction_id: Optional[UUID] = None
    try:
        prediction_id = await predictions.insert(
            trip_id=req.trip_id,
            model_version=mp.version,
            inputs=req.model_dump(mode="json"),
            factors=outcome.explanation.factors,
            backbone=outcome.explanation.backbone,
            predicted_eta_seconds=outcome.response.predicted_eta_seconds,
            deadline_seconds_remaining=outcome.response.deadline_seconds_remaining,
            breach_probability=outcome.response.breach_probability,
            will_breach=outcome.response.will_breach,
            recommendation=outcome.response.recommendation,
            ai_confidence=outcome.response.ai_confidence,
            latency_ms=outcome.latency_ms,
        )
    except Exception:
        prediction_id = None

    if prediction_id is not None:
        outcome.response.prediction_id = prediction_id

    decision = run_decide(
        outcome.response,
        anomalies=open_anoms,
        mp=mp,
        corridor_active=req.corridor_active,
        prediction_id=prediction_id,
    )

    try:
        await decisions.insert(decision)
        await state.upsert_after_predict(
            trip_id=req.trip_id,
            organ_type=req.organ_type.value if req.organ_type else None,
            recommendation=outcome.response.recommendation,
            breach_prob=outcome.response.breach_probability,
            last_predict_at=decision.decided_at,
        )
        await audit.append(
            actor="ai-brain",
            action="decide",
            trip_id=req.trip_id,
            request_id=request.headers.get("x-request-id"),
            payload={
                "action":        decision.action.value,
                "rule_path":     decision.rule_path,
                "model_version": mp.version,
            },
        )
    except Exception:
        pass

    return DecideResponse(prediction=outcome.response, decision=decision)
