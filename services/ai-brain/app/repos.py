"""
Repositories. Thin asyncpg adapters per table — all SQL lives here.

Every method tolerates the pool being None (DB disabled in dev). When
the pool is missing, mutating methods are no-ops and reading methods
return empty defaults, so the predict path stays fully functional even
without persistence — only learning + reporting degrade.
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Optional
from uuid import UUID, uuid4

from .domain import (
    Anomaly, AnomalyKind, AnomalySeverity, Decision, DecisionAction, Factor,
)


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------

def _factors_to_jsonb(factors: list[Factor]) -> str:
    return json.dumps([f.model_dump() for f in factors])


def _factors_from_jsonb(raw: Any) -> list[Factor]:
    if raw is None:
        return []
    if isinstance(raw, str):
        raw = json.loads(raw)
    return [Factor(**f) for f in raw]


# ---------------------------------------------------------------------
# Model registry
# ---------------------------------------------------------------------

class ModelRegistry:
    def __init__(self, pool: Optional[Any]) -> None:
        self._pool = pool

    async def get_active(self) -> Optional[dict[str, Any]]:
        if self._pool is None:
            return None
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT id, version, parameters FROM ai.model_runs WHERE is_active = TRUE"
            )
            if not row:
                return None
            return {
                "id":         row["id"],
                "version":    row["version"],
                "parameters": json.loads(row["parameters"]) if isinstance(row["parameters"], str) else row["parameters"],
            }

    async def list_recent(self, limit: int = 20) -> list[dict[str, Any]]:
        if self._pool is None:
            return []
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id, version, parameters, sample_count,
                       mae_seconds, rmse_seconds, bias_seconds,
                       is_active, created_at, activated_at
                FROM ai.model_runs
                ORDER BY created_at DESC
                LIMIT $1
                """, limit,
            )
            out = []
            for r in rows:
                params = r["parameters"]
                if isinstance(params, str):
                    params = json.loads(params)
                out.append({
                    "id":            r["id"],
                    "version":       r["version"],
                    "parameters":    params,
                    "sample_count":  r["sample_count"],
                    "mae_seconds":   r["mae_seconds"],
                    "rmse_seconds":  r["rmse_seconds"],
                    "bias_seconds":  r["bias_seconds"],
                    "is_active":     r["is_active"],
                    "created_at":    r["created_at"],
                    "activated_at":  r["activated_at"],
                })
            return out

    async def insert_run(self, *, version: str, parameters: dict[str, Any],
                         sample_count: int, mae: float, rmse: float, bias: float,
                         activate: bool) -> UUID:
        if self._pool is None:
            return uuid4()
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                if activate:
                    await conn.execute("UPDATE ai.model_runs SET is_active = FALSE WHERE is_active = TRUE")
                rid: UUID = await conn.fetchval(
                    """
                    INSERT INTO ai.model_runs
                        (version, parameters, sample_count,
                         mae_seconds, rmse_seconds, bias_seconds,
                         is_active, activated_at)
                    VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8)
                    RETURNING id
                    """,
                    version, json.dumps(parameters), sample_count, mae, rmse, bias,
                    activate, datetime.utcnow() if activate else None,
                )
                return rid


# ---------------------------------------------------------------------
# Predictions
# ---------------------------------------------------------------------

class PredictionsRepo:
    def __init__(self, pool: Optional[Any]) -> None:
        self._pool = pool

    async def insert(
        self,
        *,
        trip_id:       UUID,
        model_version: str,
        inputs:        dict[str, Any],
        factors:       list[Factor],
        backbone:      str,
        predicted_eta_seconds:      int,
        deadline_seconds_remaining: int,
        breach_probability:         float,
        will_breach:                bool,
        recommendation:             str,
        ai_confidence:              float,
        latency_ms:                 int,
    ) -> Optional[UUID]:
        if self._pool is None:
            return None
        async with self._pool.acquire() as conn:
            return await conn.fetchval(
                """
                INSERT INTO ai.predictions
                    (trip_id, model_version, inputs, factors, backbone,
                     predicted_eta_seconds, deadline_seconds_remaining,
                     breach_probability, will_breach, recommendation,
                     ai_confidence, latency_ms)
                VALUES ($1, $2, $3::jsonb, $4::jsonb, $5,
                        $6, $7, $8, $9, $10, $11, $12)
                RETURNING id
                """,
                trip_id, model_version, json.dumps(inputs), _factors_to_jsonb(factors),
                backbone, predicted_eta_seconds, deadline_seconds_remaining,
                breach_probability, will_breach, recommendation, ai_confidence, latency_ms,
            )

    async def list_for_trip(self, trip_id: UUID) -> list[dict[str, Any]]:
        if self._pool is None:
            return []
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id, model_version, requested_at, inputs, factors, backbone,
                       predicted_eta_seconds, deadline_seconds_remaining,
                       breach_probability, will_breach, recommendation,
                       ai_confidence, latency_ms
                FROM ai.predictions
                WHERE trip_id = $1
                ORDER BY requested_at ASC
                """, trip_id,
            )
            out = []
            for r in rows:
                inputs = r["inputs"]
                if isinstance(inputs, str):
                    inputs = json.loads(inputs)
                factors = _factors_from_jsonb(r["factors"])
                out.append({
                    "id":             r["id"],
                    "model_version":  r["model_version"],
                    "requested_at":   r["requested_at"],
                    "inputs":         inputs,
                    "factors":        [f.model_dump() for f in factors],
                    "backbone":       r["backbone"],
                    "predicted_eta_seconds":      r["predicted_eta_seconds"],
                    "deadline_seconds_remaining": r["deadline_seconds_remaining"],
                    "breach_probability":         r["breach_probability"],
                    "will_breach":                r["will_breach"],
                    "recommendation":             r["recommendation"],
                    "ai_confidence":              r["ai_confidence"],
                    "latency_ms":                 r["latency_ms"],
                })
            return out

    async def calibration_window(self, *, limit: int) -> list[dict[str, Any]]:
        """
        Pull predictions that have a paired actual, for the calibration loop.
        Returns most recent `limit` rows with both predicted and actual ETA.
        """
        if self._pool is None:
            return []
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT p.id, p.trip_id, p.model_version,
                       p.predicted_eta_seconds, p.factors,
                       a.actual_eta_seconds
                FROM ai.predictions p
                JOIN ai.actuals a ON a.trip_id = p.trip_id
                ORDER BY p.requested_at DESC
                LIMIT $1
                """, limit,
            )
            return [
                {
                    "prediction_id":         r["id"],
                    "trip_id":               r["trip_id"],
                    "model_version":         r["model_version"],
                    "predicted_eta_seconds": r["predicted_eta_seconds"],
                    "actual_eta_seconds":    r["actual_eta_seconds"],
                    "factors":               r["factors"],
                }
                for r in rows
            ]


# ---------------------------------------------------------------------
# Actuals
# ---------------------------------------------------------------------

class ActualsRepo:
    def __init__(self, pool: Optional[Any]) -> None:
        self._pool = pool

    async def upsert(self, *, trip_id: UUID, actual_eta_seconds: int,
                     completion_status: str, arrived_at: datetime,
                     notes: Optional[str] = None) -> None:
        if self._pool is None:
            return
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO ai.actuals
                    (trip_id, arrived_at, actual_eta_seconds, completion_status, notes)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (trip_id) DO UPDATE
                    SET arrived_at         = EXCLUDED.arrived_at,
                        actual_eta_seconds = EXCLUDED.actual_eta_seconds,
                        completion_status  = EXCLUDED.completion_status,
                        notes              = EXCLUDED.notes,
                        recorded_at        = NOW()
                """, trip_id, arrived_at, actual_eta_seconds, completion_status, notes,
            )


# ---------------------------------------------------------------------
# Trip state
# ---------------------------------------------------------------------

class TripStateRepo:
    def __init__(self, pool: Optional[Any]) -> None:
        self._pool = pool

    async def upsert_after_predict(self, *, trip_id: UUID, organ_type: Optional[str],
                                   recommendation: str, breach_prob: float,
                                   last_predict_at: datetime) -> None:
        if self._pool is None:
            return
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO ai.trip_state
                    (trip_id, organ_type, status, last_predict_at,
                     last_recommendation, last_breach_prob, updated_at)
                VALUES ($1, $2, 'InTransit', $3, $4, $5, NOW())
                ON CONFLICT (trip_id) DO UPDATE
                    SET organ_type           = COALESCE(EXCLUDED.organ_type, ai.trip_state.organ_type),
                        last_predict_at      = EXCLUDED.last_predict_at,
                        last_recommendation  = EXCLUDED.last_recommendation,
                        last_breach_prob     = EXCLUDED.last_breach_prob,
                        updated_at           = NOW()
                """, trip_id, organ_type, last_predict_at, recommendation, breach_prob,
            )

    async def get(self, trip_id: UUID) -> Optional[dict[str, Any]]:
        if self._pool is None:
            return None
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow("SELECT * FROM ai.trip_state WHERE trip_id = $1", trip_id)
            return dict(row) if row else None


# ---------------------------------------------------------------------
# Anomalies
# ---------------------------------------------------------------------

class AnomaliesRepo:
    def __init__(self, pool: Optional[Any]) -> None:
        self._pool = pool

    async def insert(self, a: Anomaly) -> Optional[UUID]:
        if self._pool is None:
            return None
        async with self._pool.acquire() as conn:
            return await conn.fetchval(
                """
                INSERT INTO ai.anomalies (trip_id, kind, severity, evidence)
                VALUES ($1, $2, $3, $4::jsonb)
                RETURNING id
                """,
                a.trip_id, a.kind.value, a.severity.value, json.dumps(a.evidence),
            )

    async def list_for_trip(self, trip_id: UUID) -> list[Anomaly]:
        if self._pool is None:
            return []
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT trip_id, kind, severity, detected_at, evidence
                FROM ai.anomalies WHERE trip_id = $1
                ORDER BY detected_at ASC
                """, trip_id,
            )
            out = []
            for r in rows:
                ev = r["evidence"]
                if isinstance(ev, str):
                    ev = json.loads(ev)
                out.append(Anomaly(
                    trip_id=r["trip_id"],
                    kind=AnomalyKind(r["kind"]),
                    severity=AnomalySeverity(r["severity"]),
                    detected_at=r["detected_at"],
                    evidence=ev,
                ))
            return out


# ---------------------------------------------------------------------
# Decisions (audit-grade)
# ---------------------------------------------------------------------

class DecisionsRepo:
    def __init__(self, pool: Optional[Any]) -> None:
        self._pool = pool

    async def insert(self, d: Decision) -> Optional[UUID]:
        if self._pool is None:
            return None
        async with self._pool.acquire() as conn:
            return await conn.fetchval(
                """
                INSERT INTO ai.decisions
                    (trip_id, prediction_id, action, confidence,
                     rule_path, factors)
                VALUES ($1, $2, $3, $4, $5, $6::jsonb)
                RETURNING id
                """,
                d.trip_id, d.prediction_id, d.action.value, d.confidence,
                d.rule_path, _factors_to_jsonb(d.factors),
            )

    async def list_for_trip(self, trip_id: UUID) -> list[dict[str, Any]]:
        if self._pool is None:
            return []
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id, prediction_id, action, confidence,
                       rule_path, factors, decided_at
                FROM ai.decisions WHERE trip_id = $1
                ORDER BY decided_at ASC
                """, trip_id,
            )
            out = []
            for r in rows:
                factors = _factors_from_jsonb(r["factors"])
                out.append({
                    "id":            r["id"],
                    "prediction_id": r["prediction_id"],
                    "action":        DecisionAction(r["action"]),
                    "confidence":    r["confidence"],
                    "rule_path":     list(r["rule_path"] or []),
                    "factors":       [f.model_dump() for f in factors],
                    "decided_at":    r["decided_at"],
                })
            return out


# ---------------------------------------------------------------------
# Audit log (append-only, compliance trail)
# ---------------------------------------------------------------------

class AuditRepo:
    def __init__(self, pool: Optional[Any]) -> None:
        self._pool = pool

    async def append(self, *, actor: str, action: str,
                     trip_id: Optional[UUID] = None,
                     request_id: Optional[str] = None,
                     payload: Optional[dict[str, Any]] = None) -> None:
        if self._pool is None:
            return
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO ai.audit_log (actor, action, trip_id, request_id, payload)
                VALUES ($1, $2, $3, $4, $5::jsonb)
                """,
                actor, action, trip_id, request_id, json.dumps(payload or {}),
            )


# ---------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------

class ReportsRepo:
    def __init__(self, pool: Optional[Any]) -> None:
        self._pool = pool

    async def upsert(self, *, trip_id: UUID, model_version: str,
                     summary_md: str, structured: dict[str, Any],
                     narrative_src: str) -> None:
        if self._pool is None:
            return
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO ai.reports
                    (trip_id, model_version, summary_md, structured, narrative_src)
                VALUES ($1, $2, $3, $4::jsonb, $5)
                ON CONFLICT (trip_id) DO UPDATE
                    SET model_version  = EXCLUDED.model_version,
                        summary_md     = EXCLUDED.summary_md,
                        structured     = EXCLUDED.structured,
                        narrative_src  = EXCLUDED.narrative_src,
                        generated_at   = NOW()
                """,
                trip_id, model_version, summary_md, json.dumps(structured), narrative_src,
            )

    async def get(self, trip_id: UUID) -> Optional[dict[str, Any]]:
        if self._pool is None:
            return None
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow("SELECT * FROM ai.reports WHERE trip_id = $1", trip_id)
            if not row:
                return None
            d = dict(row)
            if isinstance(d.get("structured"), str):
                d["structured"] = json.loads(d["structured"])
            return d
