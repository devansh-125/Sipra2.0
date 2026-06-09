"""
POST /anomaly/scan — pure detection over a window of pings. The brain
returns the anomalies it would record; the caller decides whether to
persist them via persist=True.
"""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter
from pydantic import BaseModel

from ..anomaly import scan
from ..db import pool
from ..domain import Anomaly, GPSPing, LatLng
from ..repos import AnomaliesRepo

router = APIRouter()


class AnomalyScanRequest(BaseModel):
    trip_id:       UUID
    pings:         list[GPSPing]
    planned_route: list[LatLng] = []
    persist:       bool = False


class AnomalyScanResponse(BaseModel):
    trip_id:   UUID
    anomalies: list[Anomaly]


@router.post("/anomaly/scan", response_model=AnomalyScanResponse)
async def scan_anomalies(req: AnomalyScanRequest) -> AnomalyScanResponse:
    found = scan(req.trip_id, req.pings, planned_route=req.planned_route or None)
    if req.persist:
        repo = AnomaliesRepo(pool())
        for a in found:
            try:
                await repo.insert(a)
            except Exception:
                pass
    return AnomalyScanResponse(trip_id=req.trip_id, anomalies=found)
