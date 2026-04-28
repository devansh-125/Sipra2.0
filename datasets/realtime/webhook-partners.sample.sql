-- =============================================================================
-- Sipra :: webhook-partners.sample.sql
-- Sample webhook partner configurations for the B2B exclusion zone dispatcher.
--
-- This file documents the seed data contract for webhook_partners table.
-- The actual seed data is in infra/docker/postgres/seed.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Mock Fleet Receiver (Development)
-- -----------------------------------------------------------------------------
-- This is the partner used in development/demo environments.
-- The hmac_secret MUST match SIPRA_WEBHOOK_SECRET in fleet-receiver service.
INSERT INTO webhook_partners (name, webhook_url, hmac_secret, active, timeout_ms, max_retries)
VALUES (
    'Mock Fleet Receiver',
    'http://fleet-receiver:4000/webhooks/exclusion-zone',
    'test-secret',
    TRUE,
    2000,
    3
)
ON CONFLICT (name) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Production Partner Examples
-- -----------------------------------------------------------------------------
-- These are example configurations for real B2B fleet partners.
-- Uncomment and modify for production use.

-- Uber Fleet Integration
-- INSERT INTO webhook_partners (name, webhook_url, hmac_secret, active, timeout_ms, max_retries)
-- VALUES (
--     'Uber Fleet API',
--     'https://api.uber.com/v1/sipra/exclusion-zones',
--     'uber-production-hmac-secret-256-bit',
--     TRUE,
--     5000,
--     5
-- )
-- ON CONFLICT (name) DO NOTHING;

-- Swiggy Fleet Integration  
-- INSERT INTO webhook_partners (name, webhook_url, hmac_secret, active, timeout_ms, max_retries)
-- VALUES (
--     'Swiggy Fleet API',
--     'https://fleet-api.swiggy.com/v2/exclusion-zones/webhook',
--     'swiggy-production-hmac-secret-256-bit',
--     TRUE,
--     3000,
--     4
-- )
-- ON CONFLICT (name) DO NOTHING;

-- Ola Fleet Integration
-- INSERT INTO webhook_partners (name, webhook_url, hmac_secret, active, timeout_ms, max_retries)
-- VALUES (
--     'Ola Fleet API',
--     'https://partners.olacabs.com/api/v1/exclusion-zones',
--     'ola-production-hmac-secret-256-bit',
--     TRUE,
--     4000,
--     3
-- )
-- ON CONFLICT (name) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Schema Reference
-- -----------------------------------------------------------------------------
-- webhook_partners table structure:
--
-- id              UUID        PRIMARY KEY (auto-generated)
-- name            TEXT        NOT NULL UNIQUE (partner display name)
-- webhook_url     TEXT        NOT NULL (HTTP endpoint for webhook delivery)
-- hmac_secret     TEXT        NOT NULL (shared secret for HMAC-SHA256 signing)
-- active          BOOLEAN     NOT NULL DEFAULT TRUE (enable/disable partner)
-- timeout_ms      INTEGER     NOT NULL DEFAULT 2000 (HTTP timeout in milliseconds)
-- max_retries     INTEGER     NOT NULL DEFAULT 3 (retry attempts on failure)
-- created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() (auto-managed)
-- updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() (auto-managed)
--
-- Webhook Payload Format:
-- {
--   "trip_id": "uuid",
--   "corridor_id": "uuid", 
--   "version": 1,
--   "buffer_meters": 2000,
--   "polygon_geojson": { "type": "Polygon", "coordinates": [...] },
--   "timestamp": "2025-04-23T10:30:00Z"
-- }
--
-- HMAC Verification:
-- - Header: X-Sipra-Signature-256
-- - Algorithm: HMAC-SHA256
-- - Input: Raw JSON payload body
-- - Secret: hmac_secret from this table