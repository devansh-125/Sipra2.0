"""
Model registry endpoints.

  GET  /models                          — list recent runs + active flag
  GET  /models/active                   — currently active parameters
  POST /internal/learning/recalibrate   — run the calibration loop now
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..db import pool
from ..learning import recalibrate
from ..repos import ModelRegistry, PredictionsRepo

router = APIRouter()


@router.get("/models")
async def list_models() -> dict:
    reg = ModelRegistry(pool())
    return {"models": await reg.list_recent()}


@router.get("/models/active")
async def active_model() -> dict:
    reg = ModelRegistry(pool())
    active = await reg.get_active()
    if not active:
        raise HTTPException(status_code=404, detail="no active model")
    return active


@router.post("/internal/learning/recalibrate")
async def recalibrate_now() -> dict:
    p = pool()
    return await recalibrate(
        registry=ModelRegistry(p),
        predictions=PredictionsRepo(p),
    )
