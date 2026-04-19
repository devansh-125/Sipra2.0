-- =============================================================================
-- Sipra :: 001_init.sql
-- Establishes the spatial data plane for the Digital Green Corridor.
-- Idempotent where possible so the migration is safe to re-run in dev.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'trip_status') THEN
        CREATE TYPE trip_status AS ENUM (
            'Pending',
            'InTransit',
            'DroneHandoff',
            'Completed',
            'Failed'
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cargo_type') THEN
        CREATE TYPE cargo_type AS ENUM (
            'Organ',
            'Vaccine',
            'Blood',
            'Medication'
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'bounty_status') THEN
        CREATE TYPE bounty_status AS ENUM (
            'Offered',
            'Claimed',
            'Verified',
            'Expired',
            'Rejected'
        );
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- Shared: updated_at auto-touch trigger
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- trips :: the authoritative mission record
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trips (
    id                     UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    status                 trip_status NOT NULL DEFAULT 'Pending',

    cargo_type             cargo_type  NOT NULL,
    cargo_description      TEXT        NOT NULL,
    cargo_tolerance_celsius NUMERIC(5,2),

    origin                 GEOMETRY(Point, 4326) NOT NULL,
    destination            GEOMETRY(Point, 4326) NOT NULL,

    golden_hour_deadline   TIMESTAMPTZ NOT NULL,
    started_at             TIMESTAMPTZ,
    completed_at           TIMESTAMPTZ,

    ambulance_id           TEXT        NOT NULL,
    hospital_dispatch_id   TEXT,

    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT trips_deadline_after_creation CHECK (golden_hour_deadline > created_at),
    CONSTRAINT trips_completed_consistency    CHECK (
        (status = 'Completed' AND completed_at IS NOT NULL)
        OR (status <> 'Completed')
    )
);

CREATE INDEX IF NOT EXISTS trips_status_idx            ON trips (status);
CREATE INDEX IF NOT EXISTS trips_deadline_idx          ON trips (golden_hour_deadline);
CREATE INDEX IF NOT EXISTS trips_origin_gix            ON trips USING GIST (origin);
CREATE INDEX IF NOT EXISTS trips_destination_gix       ON trips USING GIST (destination);
CREATE INDEX IF NOT EXISTS trips_active_idx            ON trips (id)
    WHERE status IN ('Pending', 'InTransit', 'DroneHandoff');

DROP TRIGGER IF EXISTS trips_set_updated_at ON trips;
CREATE TRIGGER trips_set_updated_at
    BEFORE UPDATE ON trips
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- gps_pings :: high-frequency ambulance telemetry
-- Hot write path — Redis is the primary buffer; Postgres is the audit log.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gps_pings (
    id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id      UUID        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,

    location     GEOMETRY(Point, 4326) NOT NULL,
    heading_deg  NUMERIC(5,2),
    speed_kph    NUMERIC(6,2),
    accuracy_m   NUMERIC(6,2),

    recorded_at  TIMESTAMPTZ NOT NULL,
    ingested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gps_pings_trip_id_idx       ON gps_pings (trip_id);
CREATE INDEX IF NOT EXISTS gps_pings_trip_recorded_idx ON gps_pings (trip_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS gps_pings_location_gix      ON gps_pings USING GIST (location);

-- -----------------------------------------------------------------------------
-- corridors :: versioned rolling exclusion envelopes
-- A new row per envelope recomputation; superseded rows are retained for replay.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS corridors (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id         UUID        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,

    version         INTEGER     NOT NULL,
    envelope        GEOMETRY(Polygon, 4326) NOT NULL,
    buffer_meters   INTEGER     NOT NULL,

    valid_from      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_until     TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT corridors_trip_version_unique UNIQUE (trip_id, version),
    CONSTRAINT corridors_envelope_valid      CHECK (ST_IsValid(envelope))
);

CREATE INDEX IF NOT EXISTS corridors_trip_id_idx   ON corridors (trip_id);
CREATE INDEX IF NOT EXISTS corridors_envelope_gix  ON corridors USING GIST (envelope);
CREATE INDEX IF NOT EXISTS corridors_active_idx    ON corridors (trip_id, version DESC)
    WHERE valid_until IS NULL;

-- -----------------------------------------------------------------------------
-- webhook_partners :: B2B fleet subscribers (Uber, Swiggy, ...)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_partners (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT        NOT NULL UNIQUE,
    webhook_url     TEXT        NOT NULL,
    hmac_secret     TEXT        NOT NULL,

    active          BOOLEAN     NOT NULL DEFAULT TRUE,
    timeout_ms      INTEGER     NOT NULL DEFAULT 2000,
    max_retries     INTEGER     NOT NULL DEFAULT 3,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS webhook_partners_active_idx ON webhook_partners (active)
    WHERE active = TRUE;

DROP TRIGGER IF EXISTS webhook_partners_set_updated_at ON webhook_partners;
CREATE TRIGGER webhook_partners_set_updated_at
    BEFORE UPDATE ON webhook_partners
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- bounties :: consumer-driver detour incentives
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bounties (
    id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id         UUID          NOT NULL REFERENCES trips(id) ON DELETE CASCADE,

    driver_ref      TEXT          NOT NULL,
    partner_id      UUID          REFERENCES webhook_partners(id) ON DELETE SET NULL,

    amount_points   INTEGER       NOT NULL CHECK (amount_points > 0),
    checkpoint      GEOMETRY(Point, 4326) NOT NULL,
    checkpoint_radius_m INTEGER   NOT NULL DEFAULT 50,

    status          bounty_status NOT NULL DEFAULT 'Offered',

    offered_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    claimed_at      TIMESTAMPTZ,
    verified_at     TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ   NOT NULL,

    CONSTRAINT bounties_expiry_after_offer CHECK (expires_at > offered_at)
);

CREATE INDEX IF NOT EXISTS bounties_trip_id_idx     ON bounties (trip_id);
CREATE INDEX IF NOT EXISTS bounties_status_idx      ON bounties (status);
CREATE INDEX IF NOT EXISTS bounties_checkpoint_gix  ON bounties USING GIST (checkpoint);
CREATE INDEX IF NOT EXISTS bounties_open_idx        ON bounties (trip_id, expires_at)
    WHERE status = 'Offered';

COMMIT;
