"""
Health endpoints. /healthz is liveness; /readyz checks DB + active model.
Kubernetes-style separation so a degraded DB takes the brain out of the
ready set without restarting the pod.
"""
from __future__ import annotations

from fastapi import APIRouter

from ..db import pool
from ..repos import ModelRegistry

router = APIRouter()


@router.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/readyz")
async def readyz() -> dict[str, str]:
    p = pool()
    if p is None:
        return {"status": "ok", "db": "disabled"}
    reg = ModelRegistry(p)
    active = await reg.get_active()
    if not active:
        return {"status": "degraded", "db": "ok", "active_model": "none"}
    return {"status": "ok", "db": "ok", "active_model": active["version"]}
