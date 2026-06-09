"""
asyncpg pool + idempotent migration runner.

The brain owns the `ai` schema. core-go owns the rest. We never DDL outside
our schema, and the migration file is idempotent so it converges on every
boot. Production deploys can disable boot-time migrations via AI_DB_ENABLED=0
and run them out-of-band — the same SQL file is the source of truth.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

try:
    import asyncpg  # type: ignore[import-not-found]
except ImportError:  # asyncpg unavailable in dev/test environments
    asyncpg = None  # type: ignore[assignment]

from .config import SETTINGS

_pool: Optional[Any] = None


def _normalise_dsn(dsn: str) -> str:
    # core-go uses libpq's `?sslmode=disable` form which asyncpg accepts.
    # postgres:// vs postgresql:// — asyncpg accepts both; normalise just in case.
    if dsn.startswith("postgres://"):
        return "postgresql://" + dsn[len("postgres://"):]
    return dsn


async def init_pool() -> Optional[Any]:
    global _pool
    if not SETTINGS.db_enabled or asyncpg is None:
        return None
    if _pool is not None:
        return _pool
    _pool = await asyncpg.create_pool(
        dsn=_normalise_dsn(SETTINGS.database_url),
        min_size=SETTINGS.db_pool_min,
        max_size=SETTINGS.db_pool_max,
        command_timeout=10.0,
    )
    await _run_migrations(_pool)
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def pool() -> Optional[Any]:
    return _pool


async def _run_migrations(p: Any) -> None:
    sql = (Path(__file__).parent / "migrations.sql").read_text(encoding="utf-8")
    async with p.acquire() as conn:
        async with conn.transaction():
            await conn.execute(sql)
