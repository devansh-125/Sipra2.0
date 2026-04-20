# Sipra — Autonomous AI Orchestrator for Bio-Logistics

Sipra coordinates emergency medical transport (organs, vaccines, blood) with zero human intervention. It broadcasts a rolling 2 km exclusion corridor around the ambulance so partner fleets (Uber, Swiggy, etc.) can reroute instantly. When the AI brain predicts a golden-hour deadline breach, it autonomously dispatches a drone to complete the delivery.

---

## Architecture

```
                    ┌──────────────────────────────────────────────┐
 Ambulance ─pings─▶ │  Go/Fiber core  :8080                        │ ─WS──────▶ Next.js dashboard :3000
                    │   Redis hot cache → Postgres batch flush     │ ─webhook─▶ fleet-receiver    :4000
                    │   PostGIS ST_Buffer(2 km) corridor engine    │ ─webhook─▶ drone-dispatch    :4003
                    │   Webhook worker pool + WS broadcast hub     │
                    │   Risk Monitor ─────poll────▶ AI brain :8000 │
                    └──────────────────────────────────────────────┘
```

Ingest is 202-immediate (Redis buffer); Postgres is the durable store, flushed every 5 s. Corridor rows are versioned and history-preserving — no UPDATE-in-place.

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Core API | Go 1.26 · Fiber · pgx/v5 · redis/v9 · zerolog |
| Database | Postgres 16 + PostGIS 3.4 |
| Cache | Redis 7 |
| AI brain | Python 3.11 · FastAPI · uvicorn |
| Dashboard | Next.js 14 App Router · TypeScript strict · Deck.gl 9 · `@vis.gl/react-google-maps` |
| Mock services | Node 18 · Express (fleet-receiver :4000, drone-dispatch :4003) |
| Infrastructure | Docker Compose · PostGIS `ST_Buffer` · `ST_DWithin` |

---

## Quick start

### 1. Environment setup

```bash
cp .env.example .env
```

Open `.env` and fill in:

```
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=<your key>   # required for the map to render
```

Get a key at [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Maps JavaScript API.

### 2. Start the full backend with Docker Compose

```bash
docker compose up -d
```

This brings up **all backend services**:

| Container | Port | Description |
|-----------|------|-------------|
| `sipra-postgres` | 5432 | Postgres 16 + PostGIS |
| `sipra-redis` | 6379 | Redis 7 cache |
| `sipra-ai-brain` | 8000 | Python FastAPI — ETA prediction |
| `sipra-fleet-receiver` | 4000 | Mock B2B fleet webhook receiver |
| `sipra-drone-dispatch` | 4003 | Mock drone dispatch API |

### 3. Start the Go core API

```bash
cd services/core-go && go run ./cmd/server
```

Runs on `:8080`. WebSocket hub at `/ws/dashboard`.

### 4. Start the Next.js dashboard

```bash
cd services/web && npm install && npm run dev
```

Opens on `:3000`.

---

## Demo scripts

All scripts live in `scripts/`. Install once with `cd scripts && npm install`.

| Command | Description |
|---------|-------------|
| `npm run simulate` | God-mode simulator — spawns a moving ambulance + 50 fleet vehicles over WebSocket |
| `npm run e2e:handoff` | End-to-end Phase 5 test — creates a trip with a 2-min deadline 50 km away and asserts the full handoff pipeline fires within 90 s |
| `bash scripts/chaos-flood-bridge.sh` | Chaos demo — stalls the ambulance at a flooded bridge for 60 s, forcing a golden-hour breach and drone handoff |
| `.\scripts\chaos-flood-bridge.ps1` | Same chaos demo for Windows PowerShell |

### Phase 5 e2e expected output

```
=== Sipra Phase 5 E2E — handoff test ===
  ✓  Go core API reachable
  ✓  AI brain reachable
  ✓  Drone mock reachable
  📡  HANDOFF_INITIATED received on WS
  ✓  trip status flipped to DroneHandoff
  ✓  mock drone dispatch received a call for this trip
  ✓  dashboard WebSocket received HANDOFF_INITIATED
✅  All assertions passed — Phase 5 handoff pipeline is working end-to-end.
```

---

## Repo layout

| Path | Description |
|------|-------------|
| `services/core-go/` | Go/Fiber backbone — DDD, corridor engine, risk monitor, bounty |
| `services/web/` | Next.js 14 + Deck.gl dashboard |
| `services/ai-brain/` | Python FastAPI — haversine ETA prediction |
| `services/mocks/fleet-receiver/` | Express mock for B2B corridor webhooks |
| `services/mocks/drone-dispatch/` | Express mock drone dispatch API |
| `scripts/simulate-gps.ts` | God-mode ambulance + fleet simulator |
| `scripts/e2e-handoff.ts` | Phase 5 end-to-end test |
| `infra/docker/postgres/init.sql` | PostGIS + uuid-ossp schema bootstrap |

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgres://sipra:sipra_dev@postgres:5432/sipra` | Postgres connection string |
| `REDIS_URL` | `redis://redis:6379/0` | Redis connection string |
| `AI_BRAIN_URL` | `http://ai-brain:8000` | AI prediction service |
| `MOCK_DRONE_URL` | `http://drone-dispatch:4003` | Drone dispatch mock |
| `RISK_POLL_INTERVAL_SEC` | `10` | How often Risk Monitor polls InTransit trips |
| `PING_FLUSH_INTERVAL_SEC` | `5` | Redis → Postgres flush cadence |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | — | **Required** — Google Maps JavaScript API key |

Compose-internal service names (`postgres`, `redis`, `ai-brain`, etc.) are used as hostnames inside the Docker network. When running services locally outside Compose, point these at `localhost`.

---

## Troubleshooting

**Map is blank / `InvalidKeyMapError`**
Set `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` in `services/web/.env.local` (copy from `.env.local.example`).

**`docker compose up` fails on PostGIS image pull**
Run `docker pull postgis/postgis:16-3.4` separately on a stable connection, then retry.

**Go core fails with `dial tcp 5432: connection refused`**
Postgres takes ~5 s to initialize. Wait for `sipra-postgres` to show `healthy` in `docker compose ps`, then start the Go server.

**AI brain container exits immediately**
Check `docker compose logs ai-brain`. Most likely missing Python deps — rebuild with `docker compose build ai-brain`.

**`npm run e2e:handoff` times out**
Ensure all five backend services are running (Compose + Go core). The Risk Monitor polls every 10 s; the test allows 90 s total.

**WebSocket disconnects after a few seconds**
The WS hub drops slow clients. Check that the dashboard page is open and not backgrounded by the OS. Run the simulator (`npm run simulate`) to keep pings flowing.
