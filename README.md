# Sipra — Autonomous AI Orchestrator for Bio-Logistics

Sipra coordinates emergency medical transport (organs, vaccines, blood) by:

- Broadcasting a rolling 2 km exclusion corridor around the ambulance so partner fleets can reroute
- Predicting whether the route ETA will breach the "golden hour" deadline
- Triggering an autonomous drone handoff when a breach is imminent

---

## Quick start

```bash
# 1. Infrastructure
docker compose up -d          # postgres (PostGIS) + redis

# 2. Go core API  :8080
cd services/core-go && go run ./cmd/server

# 3. Next.js dashboard  :3000
cd services/web && npm run dev

# 4. Mock fleet receiver  :4000
cd services/mocks/fleet-receiver && npm start

# 5. God-mode simulator (ambulance + 50 fleet vehicles)
cd scripts && npm run simulate
```

> `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` must be set for the map to render.

---

## Run the Phase 5 demo (AI brain + drone handoff)

Phase 5 wires the AI prediction pipeline end-to-end:
**ambulance ping → AI brain → Risk Monitor → drone dispatch → dashboard banner**

### Start all Phase 5 services

Open four terminals and run each command:

```bash
# Terminal 1 — Go core API
cd services/core-go && go run ./cmd/server

# Terminal 2 — AI brain  (Python 3.11, FastAPI)
cd services/ai-brain && pip install -e ".[dev]" && uvicorn app.main:app --port 8000

# Terminal 3 — Mock drone dispatch
cd services/mocks/drone-dispatch && npm install && node index.js

# Terminal 4 — Next.js dashboard  (optional, for visual confirmation)
cd services/web && npm run dev
```

### Run the automated e2e test

The test creates a trip with a **2-minute golden-hour deadline**, places the
ambulance **50 km from the destination** (guaranteed ETA breach), then verifies
the full pipeline fires within 90 seconds:

```bash
cd scripts && npm run e2e:handoff
```

Expected output:

```
=== Sipra Phase 5 E2E — handoff test ===

── pre-flight checks ──
  ✓  Go core API reachable
  ✓  AI brain reachable
  ✓  Drone mock reachable

── create trip ──
  trip_id : <uuid>
  deadline: <now + 2 min>

── start trip (Pending → InTransit) ──
  status: InTransit

── subscribing to dashboard WebSocket ──
  WebSocket connected

── sending pings from 50 km away ──
  location: (12.5129, 77.6201)
  duration: 25 s
  sent 25 pings — waiting for Risk Monitor to pick up

── polling for DroneHandoff ──
  📡  HANDOFF_INITIATED received on WS
  status: DroneHandoff

── assertions ──
  ✓  trip status flipped to DroneHandoff
  ✓  mock drone dispatch received a call for this trip
  ✓  dashboard WebSocket received HANDOFF_INITIATED

✅  All assertions passed — Phase 5 handoff pipeline is working end-to-end.
```

### What the pipeline does

| Step | Component | Action |
|------|-----------|--------|
| 1 | Go ingest | GPS ping buffered in Redis (202 immediately) |
| 2 | Go flush ticker | Pings drained to Postgres every 5 s |
| 3 | Risk Monitor | Polls InTransit trips every 10 s, calls AI brain |
| 4 | AI brain `:8000` | Haversine + traffic factor → `will_breach: true` |
| 5 | Risk Monitor | Transitions trip to `DroneHandoff` in Postgres |
| 6 | Drone dispatch `:4003` | `POST /api/v1/drones/dispatch` → drone ID + ETA |
| 7 | WS hub | Broadcasts `HANDOFF_INITIATED` to all dashboard clients |

### Environment variables (all have defaults)

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_BRAIN_URL` | `http://localhost:8000` | AI brain base URL |
| `MOCK_DRONE_URL` | `http://localhost:4003` | Drone dispatch base URL |
| `RISK_POLL_INTERVAL_SEC` | `10` | How often the Risk Monitor polls |
| `PING_FLUSH_INTERVAL_SEC` | `5` | Redis → Postgres flush cadence |

---

## Architecture

```
                    ┌──────────────────────────────────────┐
 Ambulance ─pings─▶ │  Go/Fiber core  :8080                │ ─WS─▶ Next.js dashboard :3000
                    │   Redis hot cache → Postgres batch   │ ─webhook─▶ fleet-receiver :4000
                    │   PostGIS ST_Buffer corridor engine  │ ─webhook─▶ drone-dispatch :4003
                    │   Webhook worker pool + WS hub       │
                    │   Risk Monitor ───poll───▶ AI brain  │
                    └──────────────────────────────────────┘
                                                  :8000 (FastAPI)
```

## Repo layout

| Path | Description |
|------|-------------|
| `services/core-go/` | Go/Fiber backbone — DDD, corridor engine, risk monitor |
| `services/web/` | Next.js 14 + Deck.gl dashboard |
| `services/ai-brain/` | Python FastAPI — ETA prediction |
| `services/mocks/fleet-receiver/` | Express mock for B2B corridor webhooks |
| `services/mocks/drone-dispatch/` | Express mock drone dispatch API |
| `scripts/simulate-gps.ts` | God-mode demo simulator |
| `scripts/e2e-handoff.ts` | Phase 5 end-to-end test |
| `infra/docker/postgres/init.sql` | PostGIS schema bootstrap |
