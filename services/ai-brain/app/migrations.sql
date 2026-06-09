-- Sipra AI Brain — owned schema.
--
-- The brain runs against the same Postgres instance as core-go but lives
-- in its own namespace. Core-go owns trips/gps_pings/corridors; the brain
-- only reads them. All writes from the brain land here under ai.*.
--
-- Idempotent: every CREATE is IF NOT EXISTS so the migration runs on
-- every boot of the FastAPI app and converges.

CREATE SCHEMA IF NOT EXISTS ai;

-- ---------------------------------------------------------------------
-- model_runs — versioned predictor parameters + offline metrics.
--
-- Each row is one trained-or-calibrated configuration of the residual
-- model (priority/density/weather constants). `is_active = TRUE` for
-- exactly one row at a time; the predictor reads this on every call.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai.model_runs (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    version         TEXT        NOT NULL UNIQUE,
    parameters      JSONB       NOT NULL,
    training_window TSTZRANGE,
    sample_count    INTEGER     NOT NULL DEFAULT 0,
    mae_seconds     DOUBLE PRECISION,
    rmse_seconds    DOUBLE PRECISION,
    bias_seconds    DOUBLE PRECISION,
    is_active       BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    activated_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS model_runs_active_uniq
    ON ai.model_runs (is_active) WHERE is_active = TRUE;

-- ---------------------------------------------------------------------
-- predictions — every /predict call, persisted for audit + offline learning.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai.predictions (
    id                          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id                     UUID        NOT NULL,
    model_version               TEXT        NOT NULL,
    requested_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    inputs                      JSONB       NOT NULL,
    factors                     JSONB       NOT NULL,
    backbone                    TEXT        NOT NULL,
    predicted_eta_seconds       INTEGER     NOT NULL,
    deadline_seconds_remaining  INTEGER     NOT NULL,
    breach_probability          DOUBLE PRECISION NOT NULL,
    will_breach                 BOOLEAN     NOT NULL,
    recommendation              TEXT        NOT NULL,
    ai_confidence               DOUBLE PRECISION NOT NULL,
    latency_ms                  INTEGER
);
CREATE INDEX IF NOT EXISTS predictions_trip_idx
    ON ai.predictions (trip_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS predictions_model_idx
    ON ai.predictions (model_version, requested_at DESC);

-- ---------------------------------------------------------------------
-- actuals — realised arrival time, joined to predictions for residuals.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai.actuals (
    trip_id              UUID        PRIMARY KEY,
    arrived_at           TIMESTAMPTZ NOT NULL,
    actual_eta_seconds   INTEGER     NOT NULL,
    completion_status    TEXT        NOT NULL,
    notes                TEXT,
    recorded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- trip_state — last-known view per trip (cache + restart resilience).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai.trip_state (
    trip_id              UUID        PRIMARY KEY,
    organ_type           TEXT,
    status               TEXT        NOT NULL,
    last_ping_at         TIMESTAMPTZ,
    last_predict_at      TIMESTAMPTZ,
    last_recommendation  TEXT,
    last_breach_prob     DOUBLE PRECISION,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- anomalies — GPS jitter / staleness / route deviation / speed anomalies.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai.anomalies (
    id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id      UUID        NOT NULL,
    kind         TEXT        NOT NULL,
    severity     TEXT        NOT NULL,
    detected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    evidence     JSONB       NOT NULL,
    resolved_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS anomalies_trip_idx
    ON ai.anomalies (trip_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS anomalies_open_idx
    ON ai.anomalies (trip_id) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------
-- decisions — output of the decision engine, paired with the prediction
-- it was based on. Append-only audit trail.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai.decisions (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id         UUID        NOT NULL,
    prediction_id   UUID        REFERENCES ai.predictions(id),
    action          TEXT        NOT NULL,
    confidence      DOUBLE PRECISION NOT NULL,
    rule_path       TEXT[]      NOT NULL,
    factors         JSONB       NOT NULL,
    decided_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS decisions_trip_idx
    ON ai.decisions (trip_id, decided_at DESC);

-- ---------------------------------------------------------------------
-- audit_log — append-only compliance trail. Every state-changing
-- request, regardless of outcome, lands here.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai.audit_log (
    id           BIGSERIAL    PRIMARY KEY,
    occurred_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    actor        TEXT         NOT NULL,
    action       TEXT         NOT NULL,
    trip_id      UUID,
    request_id   TEXT,
    payload      JSONB        NOT NULL DEFAULT '{}'::JSONB
);
CREATE INDEX IF NOT EXISTS audit_log_trip_idx
    ON ai.audit_log (trip_id, occurred_at DESC);

-- ---------------------------------------------------------------------
-- reports — cached, generated trip reports (markdown + structured).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai.reports (
    trip_id        UUID        PRIMARY KEY,
    generated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    model_version  TEXT        NOT NULL,
    summary_md     TEXT        NOT NULL,
    structured     JSONB       NOT NULL,
    narrative_src  TEXT        NOT NULL
);

-- ---------------------------------------------------------------------
-- Seed: the bootstrap (v0) model row with the citation-backed constants
-- the original main.py shipped with. Marks itself active iff no other
-- active row exists.
-- ---------------------------------------------------------------------
INSERT INTO ai.model_runs (version, parameters, is_active, activated_at)
SELECT
    'v0-bootstrap',
    '{
        "ambulance_priority_factor":      0.80,
        "free_flow_density":              5,
        "density_penalty_per_vehicle":    0.015,
        "density_penalty_cap":            1.30,
        "breach_sigmoid_scale_seconds":   300,
        "recommendation_boost_threshold": 0.40,
        "recommendation_drone_threshold": 0.85,
        "road_distance_multiplier_fallback": 1.4,
        "weather_factors": {
            "clear":      1.00,
            "light_rain": 1.10,
            "heavy_rain": 1.25,
            "fog":        1.20,
            "storm":      1.40,
            "snow":       1.40
        }
    }'::JSONB,
    TRUE,
    NOW()
WHERE NOT EXISTS (SELECT 1 FROM ai.model_runs WHERE is_active = TRUE);
