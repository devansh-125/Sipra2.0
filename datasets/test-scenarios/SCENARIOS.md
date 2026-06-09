# Sipra — Test Scenario Catalog

> Three scenarios. One route. Ambulance pings + moving fleet vehicles — the AI and Go engine decide everything else in real time.

**Route:** Manipal Hospital HAL, Bangalore `(12.9587, 77.6442)` → Sri Siddhartha Medical College, Tumkur `(13.3379, 77.1031)` — NH-48.  
**Cargo:** S1 — Kidney (Organ); S2 — Blood platelets; S3 — Kidney (Organ).

---

## What the datasets contain

Each scenario has exactly three input files:

| File | What it is |
|------|-----------|
| `trip.json` | Hospital dispatcher input: origin, destination, cargo type, golden hour duration, ambulance ID |
| `pings.ndjson` | Ambulance GPS stream: `lat`, `lng`, `speed_kph`, `heading_deg`, optional `recorded_at` (`__T+Ns__`) — replay timing |
| `fleet.json` | Partner fleet snapshot: vehicle positions, speeds, and headings at a point in time |

**Nothing else.** No weather field. No traffic label. No predicted ETA. No breach flag.

The Go Risk Monitor fetches real-time weather for the route from an external API, counts fleet density in the live 2km PostGIS corridor, feeds all of it to the AI service, and reacts to whatever the AI returns. The scenarios differ only in the movement data — the rest is the system's job.

---

## Scenario 1 — s1-normal

| Key | Value |
|-----|-------|
| Folder | `datasets/test-scenarios/realtime/s1-normal/` |
| Golden hour | **90 min** |
| Ambulance pings | 110 pings, 20s cadence, speeds 22–82 kph — ramp to highway cruise |
| Fleet | 8 vehicles, sparse along NH-48. Only 2 inside the 2km corridor |

```bash
npx tsx scripts/play-scenario.ts --scenario=s1-normal --speed=10
```

---

## Scenario 2 — s2-congestion

| Key | Value |
|-----|-------|
| Folder | `datasets/test-scenarios/realtime/s2-congestion/` |
| Golden hour | **150 min** |
| Ambulance pings | 100 pings, 20s cadence, speeds 22–70 kph — congestion stretch, clears by mid-route |
| Fleet | 40 vehicles total: 25 jammed in the corridor plus mid-route and destination coverage. 8 evading (4 BOUNTY_ACCEPTED, 4 rerouting) |

```bash
npx tsx scripts/play-scenario.ts --scenario=s2-congestion --speed=10
```

---

## Scenario 3 — s3-drone-handoff

| Key | Value |
|-----|-------|
| Folder | `datasets/test-scenarios/realtime/s3-drone-handoff/` |
| Golden hour | **90 min** |
| Ambulance pings | 65 pings, 20s cadence, 22→72 kph highway run to ~km 33, then hard brake to 0 kph (lorry block ~33% of route) |
| Fleet | 10 vehicles at 0–15 kph, 5 evading, all trapped in the same blockage |

```bash
npx tsx scripts/play-scenario.ts --scenario=s3-drone-handoff --speed=10
```

---

## How the system handles these inputs

1. `play-scenario.ts` POSTs `trip.json`, streams `pings.ndjson`, and runs `fleet.json` as a continuous movement loop.
2. **Go Risk Monitor** runs every 10s per active trip:
   - Reads last 5 ambulance speeds from Redis
   - Counts fleet vehicles inside the live PostGIS corridor
   - Fetches current weather for the route from the weather API
   - POSTs all of it to the AI service (`services/ai-brain/`, FastAPI `:8000`)
3. **AI service** computes ETA, breach probability, and a recommendation (`CONTINUE` / `REQUEST_BOUNTY_BOOST` / `DISPATCH_DRONE`).
4. If `DISPATCH_DRONE`: Go fires `HANDOFF_INITIATED`, POSTs to the drone mock service (`:4003`), broadcasts on WebSocket.

The dashboard shows whatever verdict the live system produces — not a pre-recorded one.

---

## Comparison (data only — no predicted outcomes)

| | S1 Normal | S2 Congestion | S3 Near-Stall |
|--|-----------|---------------|---------------|
| Golden hour | 90 min | 150 min | 90 min |
| Ambulance speed range | 22–82 kph | 22–70 kph | 0–72 kph |
| Fleet vehicles in corridor | ~2 | ~25 (40 total) | ~10 |
| Fleet evading | 2 | 8 | 5 |
| Weather | fetched live | fetched live | fetched live |
