"""
Report endpoints.

  GET  /reports/trip/{trip_id}            — return cached report if any
  POST /reports/trip/{trip_id}/generate   — (re)build it
  POST /trip/{trip_id}/complete           — record realised arrival,
                                            unblocks the learning loop
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..db import pool
from ..predictor import params_from_active
from ..reports import generate_report
from ..repos import (
    ActualsRepo, AnomaliesRepo, DecisionsRepo, ModelRegistry,
    PredictionsRepo, ReportsRepo, TripStateRepo,
)

router = APIRouter()


class CompleteTripRequest(BaseModel):
    actual_eta_seconds: int
    completion_status:  str = "Completed"
    arrived_at:         Optional[datetime] = None
    notes:              Optional[str] = None


@router.get("/reports/trip/{trip_id}")
async def get_report(trip_id: UUID) -> dict:
    repo = ReportsRepo(pool())
    cached = await repo.get(trip_id)
    if not cached:
        raise HTTPException(status_code=404, detail="report not generated yet")
    return {
        "trip_id":       str(trip_id),
        "generated_at":  cached["generated_at"].isoformat(),
        "model_version": cached["model_version"],
        "narrative_src": cached["narrative_src"],
        "summary_md":    cached["summary_md"],
        "structured":    cached["structured"],
    }


@router.post("/reports/trip/{trip_id}/generate")
async def generate(trip_id: UUID) -> dict:
    p = pool()
    registry = ModelRegistry(p)
    active = await registry.get_active()
    mp = params_from_active(active)
    return await generate_report(
        trip_id,
        predictions_repo=PredictionsRepo(p),
        decisions_repo=DecisionsRepo(p),
        anomalies_repo=AnomaliesRepo(p),
        actuals_repo=ActualsRepo(p),
        state_repo=TripStateRepo(p),
        reports_repo=ReportsRepo(p),
        model_version=mp.version,
    )


@router.post("/trip/{trip_id}/complete")
async def complete_trip(trip_id: UUID, body: CompleteTripRequest) -> dict:
    repo = ActualsRepo(pool())
    arrived_at = body.arrived_at or datetime.utcnow()
    await repo.upsert(
        trip_id=trip_id,
        actual_eta_seconds=body.actual_eta_seconds,
        completion_status=body.completion_status,
        arrived_at=arrived_at,
        notes=body.notes,
    )
    return {"trip_id": str(trip_id), "recorded": True}
