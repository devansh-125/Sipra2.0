-- =============================================================================
-- Sipra :: 01-seed.sql
-- Seeds the webhook_partners table so the B2B dispatcher fires webhooks
-- against the mock fleet-receiver on first boot.
--
-- The hmac_secret here MUST match SIPRA_WEBHOOK_SECRET in fleet-receiver
-- (defaults to "test-secret" when the env var is not set).
-- =============================================================================

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
