# Sipra Real-Time Datasets

This folder contains starter datasets/contracts for running the Go server in real time.

## Files used by scripts/realtime-ingest.ts

- trip.json
- ambulance-pings.ndjson

The runner will:

1. Create a trip from trip.json (unless TRIP_ID is provided).
2. Start the trip (AUTO_START_TRIP=true by default).
3. Stream each row from ambulance-pings.ndjson to /api/v1/trips/:id/pings.

## Quick start

From repository root:

1. Start services (Postgres, Redis, Go server, optional web UI).
2. Run:

   cd scripts
   npm run realtime:ingest

Optional environment variables:

- BACKEND_URL=http://localhost:8080
- DATASET_DIR=../datasets/realtime
- TRIP_ID=<existing-trip-id>
- AUTO_START_TRIP=true|false
- PING_INTERVAL_MS=1000
- LOOP=true|false

## Additional contract samples

- ai-predict.sample.request.json
- ai-predict.sample.response.json
- drone-dispatch.sample.request.json
- drone-dispatch.sample.response.json
- webhook-partners.sample.sql

These files are not consumed by the ingest runner directly; they exist to help external system teams align payloads.
