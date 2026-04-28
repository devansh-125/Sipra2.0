# Sipra — Dummy Dataset & Scenario Catalog

> Owner: Staff-level design review for Solutions Challenge 2026 demo.
> Goal: simulate production-grade Uber/Swiggy partner integration without real fleet APIs.
> Audience: anyone running the demo or wiring a UI test panel.

This catalog is the source of truth for every "what should the dashboard show?" question during the demo. It maps **dummy data → backend pipeline → UI surface** for two core flows and six edge cases.

---

## 1. Where does congestion come from?

This is the question that drives every dataset in this folder. The answer is layered:

| Layer | Source | What it gives us | Used in dummy data? |
|---|---|---|---|
| **Route geometry** | [Google Maps Directions API](https://developers.google.com/maps/documentation/directions) — `traffic_model=best_guess`, `departure_time=now` | Polyline that already reflects live traffic (Google's own model). Called from [scripts/simulate-gps.ts:178](../../scripts/simulate-gps.ts#L178) and [services/web/app/api/route/directions/route.ts](../../services/web/app/api/route/directions/route.ts). | YES — real polylines fetched at simulation start, fallback to hand-traced waypoints if the API key is missing. |
| **Risk prediction** | Python FastAPI brain at [services/ai-brain/app/main.py](../../services/ai-brain/app/main.py) | `predicted_eta_seconds`, `breach_probability`, `will_breach`. Pure heuristic: `road_dist = haversine × 1.4`, `breach_prob = sigmoid((deadline - eta) / 300)`. | YES — every `predict.response.json` in this folder is bit-exact reproducible from `predict.request.json` via that formula. |
| **Weather impact** | Mocked in `get_mock_weather_factor()` | Multiplier 1.0–1.5 on ETA. | YES — fixed weather string in each scenario so demo runs deterministically. |
| **Gemma / Ollama LLM** | Not integrated. | — | NO. Considered for narrative `ai_reasoning` text only — never on the hot path. See §6. |

**Why not Gemma on the hot path?** The Risk Monitor polls every `RISK_POLL_INTERVAL_SEC` (default 10s, see [services/core-go/internal/config/config.go:31](../../services/core-go/internal/config/config.go#L31)) across every InTransit trip. A 200ms LLM call per trip per poll cycle blows the SLA. The deterministic sigmoid runs in microseconds and produces the same numeric ETA an LLM would justify post-hoc.

**When you DO want Gemma**: the `ai_reasoning` field is currently template-filled in Python. That's the right place to swap in an LLM — it's user-facing copy, not a control signal, and a 1–2s latency budget is fine because it doesn't gate the handoff transition.

---

## 2. Scenario index

All scenarios use the same physical corridor — **Manipal Hospital HAL Bangalore (12.9587, 77.6442) → Sri Siddhartha Medical College Tumkur (13.3379, 77.1031)** along NH-48, ~72 km haversine / ~100 km after the brain's 1.4× traffic factor — and the same **120-minute (2 hr) golden-hour deadline**. Only the conditions and ping speed differ. This makes the demo's contrast crisp: same map, same route, different outcomes.

| # | ID | Folder | Trigger | Drone? | UI badge |
|---|---|---|---|---|---|
| A | `normal` | [realtime/normal/](realtime/normal/) | Clear weather, 75 kph cruise, 2-hr deadline | NO | `In Transit` (green) |
| B | `congestion-breach` | [realtime/congestion-breach/](realtime/congestion-breach/) | NH-48 incident at Yeshwantpur, heavy rain, speed crash to 0–18 kph, 2-hr deadline | YES | `Drone Handoff` (amber pulse) |
| 1 | `peak-hour-mg-road` | [realtime/peak-hour-mg-road/](realtime/peak-hour-mg-road/) | Evening peak NH-48, 50 kph crawl, 2-hr deadline | NO (close call) | `Delayed` (yellow) |
| 2 | `conflicting-etas` | [realtime/conflicting-etas/](realtime/conflicting-etas/) | Multiple trips on NH-48, contradictory ETAs | Mixed | Per-trip |
| 3 | `no-agents-available` | [realtime/no-agents-available/](realtime/no-agents-available/) | Empty fleet broadcast | N/A | `No Partners` (red) |
| 4 | `drone-unavailable-fallback` | [realtime/drone-unavailable-fallback/](realtime/drone-unavailable-fallback/) | AI says breach, drone API 503 | Tried, failed | `Drone Failed → Manual` |
| 5 | `sudden-spike-mid-route` | [realtime/sudden-spike-mid-route/](realtime/sudden-spike-mid-route/) | NH-48 clears, then accident at Dabaspete drops speed 80→8 kph at minute 18 | Eventually YES | `Delayed → Drone` |
| 6 | `gps-jitter-stale` | [realtime/gps-jitter-stale/](realtime/gps-jitter-stale/) | Bad pings: dupes, OOB, gaps | NO (data hygiene) | `Signal Weak` (grey blink) |

---

## 3. File contract per scenario folder

Every realtime scenario folder follows the same shape so a single loader script works for all of them:

```
<scenario>/
├── README.md                  # Human-readable: trigger, expected UI, decision walkthrough
├── trip.json                  # POST /api/v1/trips body (matches services/web/lib/types.ts Trip)
├── pings.ndjson               # POST /api/v1/trips/:id/pings — one line per second
├── predict.request.json       # AI brain input  (risk.PredictRequest)
├── predict.response.json      # AI brain output (risk.PredictResponse) — deterministic from request
├── fleet.json                 # /api/v1/sim/fleet snapshot — FleetVehicle[]
└── ws-events.ndjson           # Expected WebSocket envelopes the dashboard should render
```

Optional files when a scenario needs them:

```
├── drone-dispatch.request.json
├── drone-dispatch.response.json    # or drone-dispatch.error.json
├── chaos-event.json                # for /api/v1/chaos/* triggers
└── predict-sequence.ndjson         # multiple predictions over time (sudden-spike)
```

---

## 4. Decision logic — when does the system trigger a drone?

Pseudocode, traced exactly from [services/core-go/internal/risk/monitor.go:88](../../services/core-go/internal/risk/monitor.go#L88):

```python
def evaluate_trip(trip):
    ping = pings.get_latest(trip.id)
    if ping is None:
        skip("no GPS — wait for next poll")        # → scenario 6
        return

    speed_kph = ping.speed_kph or 40.0             # default fallback
    resp = ai_brain.predict(
        current      = ping.location,
        destination  = trip.destination,
        deadline     = trip.golden_hour_deadline,
        avg_speed    = speed_kph,
    )

    # Always broadcast — UI's AI Brain panel stays live (see scenarios 1, 5).
    hub.broadcast(RISK_PREDICTION, resp)

    if not resp.will_breach:
        return                                      # → scenarios A, 1, 6

    # Domain-layer state-machine guard. Idempotent if trip already moved on.
    try:
        trip.transition_to(DroneHandoff)
    except InvalidTransition:
        return

    trips.update_status(trip.id, DroneHandoff)
    metrics.handoffs_triggered.inc(label=resp.reasoning)

    drone_id, drone_eta = "", 0
    try:
        dr = drone_dispatch.dispatch(trip, ping)    # 5s timeout
        drone_id, drone_eta = dr.drone_id, dr.eta_seconds
    except Exception:
        log.warn("drone dispatch failed — broadcasting without drone info")
        # → scenario 4: HANDOFF_INITIATED still fires, drone fields empty.

    hub.broadcast(HANDOFF_INITIATED, {
        trip_id=trip.id,
        drone_id=drone_id,
        eta_seconds=drone_eta,
        reason=resp.reasoning,
        predicted_eta_seconds=resp.predicted_eta_seconds,
    })
```

### The breach formula (deterministic, no LLM)

```python
straight_m  = haversine(current, destination)
road_m      = straight_m * 1.4                       # TRAFFIC_FACTOR
weather     = mock_weather()                          # ('clear'|'light_rain'|...) → 1.0..1.5
eta_seconds = road_m / (speed_kph/3.6 / weather)
buffer_s    = (deadline - now).seconds - eta_seconds
breach_prob = 1 / (1 + exp(buffer_s / 300))           # logistic, scale=300s
will_breach = eta_seconds >= (deadline - now).seconds
```

Properties worth knowing for the demo:
- `breach_prob = 0.50` exactly when `buffer_s = 0` (right at the deadline).
- `breach_prob = 0.88` when 5 minutes overshot.
- `breach_prob = 0.0002` when 42 minutes to spare. (This is the value in our `normal` scenario at the minute-5 poll: 73-min ETA against a 115-min deadline-remaining.)
- `breach_prob ≈ 1.0` when ETA exceeds deadline by more than ~25 minutes. (`congestion-breach` saturates here — predicted 6-hr ETA against a 2-hr deadline.)
- `will_breach` is the boolean that triggers handoff. `breach_prob` only drives UI heatmap intensity.

### Why a 60+ km route and 2-hour deadline

Real medical bio-logistics is rarely intra-city. The cases that need a Sipra-style autonomous orchestrator are inter-hospital tertiary referrals — Bangalore-to-Tumkur, Mumbai-to-Pune, Delhi-to-Meerut — where:

1. Distances are 60–150 km along national highways.
2. Golden hours for organs are typically 1.5–4 hours (kidney cold ischemia 24h, but transport budget is far tighter).
3. The drone alternative becomes economically viable: a 70 km drone hop at 95 kph cruise = 44 min, beating an ambulance stuck on NH-48 by hours, not minutes.

Intra-city 8 km / 60 min scenarios don't justify the architecture — at that scale, traffic clears before the drone even spins up. The 100 km / 2 hr setup is where the ROI of corridor broadcasting + AI prediction + drone failover is actually visible.

---

## 5. UI surface mapping

Dashboard is at [services/web/app/page.tsx](../../services/web/app/page.tsx). Each WS envelope drives specific components:

| WS envelope | Hook | Components affected | Visible change |
|---|---|---|---|
| `GPS_UPDATE` | `useSipraWebSocket` → `ambulanceLat/Lng` | [CorridorMap](../../services/web/components/map/CorridorMap.tsx), [DriverPovOverlay](../../services/web/components/mission-control/DriverPovOverlay.tsx) | Ambulance icon moves; speed gauge updates |
| `CORRIDOR_UPDATE` | `useSipraWebSocket` → `corridorGeoJSON` | [ExclusionPolygon](../../services/web/components/map/ExclusionPolygon.tsx) | Pulsing polygon redraws; version counter increments |
| `FLEET_UPDATE` | sim WS on `:4001` (now folded into backend hub) | [FleetSwarm](../../services/web/components/map/FleetSwarm.tsx) | Vehicles relocate; `evading=true` ones turn amber |
| `RISK_PREDICTION` | `useSipraWebSocket` | [RerouteStatusPanel](../../services/web/components/mission-control/RerouteStatusPanel.tsx) (AI Brain block) | Breach probability bar + reasoning text update every poll |
| `HANDOFF_INITIATED` | `useSipraWebSocket` → `handoffState` | [HandoffOverlay] (planned), `MissionControlLayout` | Full-viewport modal, drone ETA countdown, hospital alert toast |
| `REROUTE_STATUS` | `useSipraWebSocket` | [RerouteStatusPanel](../../services/web/components/mission-control/RerouteStatusPanel.tsx) | Per-driver "rerouting → completed" toast stack |

Driver-side ([services/web/app/driver/[tripId]/page.tsx](../../services/web/app/driver/[tripId]/page.tsx)):
- `CORRIDOR_UPDATE` + driver position → [DriverShell](../../services/web/components/driver/DriverShell.tsx) shows `INSIDE_ZONE` proximity card with bounty offer.
- Bounty endpoints → BountyModal renders the surge-priced offer.

---

## 6. Production-readiness gaps & realism roadmap

Honest accounting of what a Google panel reviewer will probe:

### Already realistic
- Polylines come from real Google Maps Directions, not random walks. Coordinates lie on actual road centre-lines (verified by spot-check against satellite imagery).
- Trip status state machine is enforced at the domain layer — transitions are atomic and auditable.
- Webhook fan-out and WS broadcast are decoupled from the DB write path (post-commit hook pattern).

### Gaps the dummy data papers over
1. **No real partner SDK integration.** We POST to a mock fleet receiver on `:4000`. Productionising means HMAC-signed webhooks (deferred — see [services/core-go/internal/webhooks/dispatcher.go:207](../../services/core-go/internal/webhooks/dispatcher.go#L207)) and partner-specific payload schemas (Uber's vs Swiggy's differ).
2. **Traffic factor is a constant.** `TRAFFIC_FACTOR=1.4` ignores time-of-day, road type, and incidents. Production: keep the Google-derived ETA as ground truth and use the heuristic only as a sanity-check fallback.
3. **No GPS hygiene layer.** Scenario 6 demonstrates the kinds of bad pings we currently accept blindly. The `gps_pings` table accepts whatever the ambulance posts; needs server-side filtering (Kalman or simple velocity-cap).
4. **No retry / dead-letter on drone dispatch.** Scenario 4 shows the graceful-degradation path, but a real drone fleet will need exponential backoff + an operator alert when 3 consecutive dispatches fail.
5. **Bounty pricing is linear.** Surge pricing in [services/core-go/internal/bounty/](../../services/core-go/internal/bounty/) uses `base × (1 + deviation_m/1000)`. Realistic surge models are non-linear and partner-specific (Uber clamps, Swiggy uses zone density).

### Suggestions for higher-fidelity demo data
- **Time-of-day variation** — ship six pings.ndjson variants per scenario (rush AM, midday, rush PM, late night, weekend, holiday) and let `?time=evening_rush` query-param select.
- **Multi-city presets** — extend [scripts/run-demo-scenario.ts](../../scripts/run-demo-scenario.ts) `--city` flag with Lucknow, Delhi, Mumbai. Hospital coordinates and arterial routes are the only per-city data needed.
- **Reproducible randomness** — every scenario should accept a `?seed=N` query so the same fleet jitter and weather draw repeats across demo runs.
- **Replay mode** — record a real demo run's WS frames into `ws-events.ndjson`, then add a `replay` mode to the simulator that streams the recorded frames at 1× speed. Unblocks demo-without-backend.
- **LLM narration overlay** — add an Ollama-backed `/api/narrate` endpoint that takes the latest `RiskPredictionPayload` and returns a human-paced voiceover string for the demo screen. Keep it OFF the hot decision path — call it from the frontend, cache by trip+second.

---

## 7. How to use these datasets

```bash
# Run a scenario end-to-end through the real backend pipeline
cd scripts
npx tsx run-demo-scenario.ts --scenario=congestion --city=bangalore

# Inspect a scenario's expected output without running anything
cat datasets/test-scenarios/realtime/congestion-breach/ws-events.ndjson | jq

# Replay just the GPS pings against a running backend
curl -X POST http://localhost:8080/api/v1/trips \
  -H 'Content-Type: application/json' \
  -d @datasets/test-scenarios/realtime/normal/trip.json
# (capture trip_id from response, then)
while IFS= read -r line; do
  curl -X POST http://localhost:8080/api/v1/trips/$TRIP_ID/pings \
    -H 'Content-Type: application/json' -d "$line"
  sleep 1
done < datasets/test-scenarios/realtime/normal/pings.ndjson
```

---

## 8. Where this catalog should evolve next

1. **JSON schemas** in `datasets/schemas/` so `npm run validate:test-data` (already promised in the README) actually works. Schema for `Trip`, `GPSPing`, `PredictRequest/Response`, `FleetVehicle`, `Bounty`.
2. **Golden frames** — record the canonical WS sequence for each scenario and add a snapshot test that fails when the dashboard renders a different payload shape.
3. **Recorded video stubs** — for the panel demo, a 30-second screen capture of each scenario alongside its dataset folder. Reviewers love being able to scrub.
4. **Synthetic load** — extend `multiple-simultaneous.json` to 50, 200, 1000 concurrent trips. Useful for backend stress, even if the UI only renders the first ~50.
