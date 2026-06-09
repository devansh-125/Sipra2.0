"""
Centralised configuration. Read once at startup; never read os.environ
elsewhere in the codebase. Keeps the 12-factor surface auditable.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env(key: str, default: str = "") -> str:
    return os.getenv(key, default)


def _env_int(key: str, default: int) -> int:
    v = os.getenv(key)
    if v is None or v == "":
        return default
    try:
        return int(v)
    except ValueError:
        return default


def _env_bool(key: str, default: bool = False) -> bool:
    v = os.getenv(key)
    if v is None:
        return default
    return v.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    # Service
    log_level: str = field(default_factory=lambda: _env("LOG_LEVEL", "info"))
    port: int = field(default_factory=lambda: _env_int("PORT", 8000))
    request_id_header: str = field(default_factory=lambda: _env("REQUEST_ID_HEADER", "x-request-id"))

    # Persistence
    database_url: str = field(default_factory=lambda: _env(
        "DATABASE_URL",
        "postgres://sipra:sipra_dev@localhost:5433/sipra?sslmode=disable",
    ))
    db_pool_min: int = field(default_factory=lambda: _env_int("DB_POOL_MIN", 1))
    db_pool_max: int = field(default_factory=lambda: _env_int("DB_POOL_MAX", 10))
    db_enabled: bool = field(default_factory=lambda: _env_bool("AI_DB_ENABLED", True))

    # External APIs
    google_maps_api_key: str = field(default_factory=lambda: _env("GOOGLE_MAPS_API_KEY", ""))
    openweathermap_api_key: str = field(default_factory=lambda: _env("OPENWEATHERMAP_API_KEY", ""))
    vertex_ai_endpoint: str = field(default_factory=lambda: _env("VERTEX_AI_ENDPOINT", ""))
    vertex_ai_token: str = field(default_factory=lambda: _env("VERTEX_AI_TOKEN", ""))

    # Security
    webhook_hmac_secret: str = field(default_factory=lambda: _env("AI_WEBHOOK_HMAC_SECRET", ""))
    jwt_public_key_pem: str = field(default_factory=lambda: _env("AI_JWT_PUBLIC_KEY_PEM", ""))
    jwt_audience: str = field(default_factory=lambda: _env("AI_JWT_AUDIENCE", "sipra-ai-brain"))
    api_key: str = field(default_factory=lambda: _env("AI_API_KEY", ""))
    auth_required: bool = field(default_factory=lambda: _env_bool("AI_AUTH_REQUIRED", True))

    # Reliability
    routes_timeout_s: float = field(default_factory=lambda: float(_env("ROUTES_TIMEOUT_S", "5.0")))
    weather_timeout_s: float = field(default_factory=lambda: float(_env("WEATHER_TIMEOUT_S", "5.0")))
    vertex_timeout_s: float = field(default_factory=lambda: float(_env("VERTEX_TIMEOUT_S", "20.0")))

    # Anomaly thresholds (citation-backed defaults; overridable for staging).
    stale_ping_seconds: int = field(default_factory=lambda: _env_int("ANOMALY_STALE_S", 60))
    jitter_meters_per_second_max: float = field(default_factory=lambda: float(_env("ANOMALY_JITTER_MPS", "70")))
    deviation_meters_max: float = field(default_factory=lambda: float(_env("ANOMALY_DEVIATION_M", "1500")))
    speed_anomaly_kph_max: float = field(default_factory=lambda: float(_env("ANOMALY_SPEED_KPH", "180")))

    # Learning loop
    learning_min_samples: int = field(default_factory=lambda: _env_int("LEARNING_MIN_SAMPLES", 50))
    learning_drift_seconds: int = field(default_factory=lambda: _env_int("LEARNING_DRIFT_S", 60))


SETTINGS = Settings()
