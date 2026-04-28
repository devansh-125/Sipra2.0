# Scenario B — High congestion → Drone Handoff trigger

**Trip ID (deterministic):** `00000002-0000-4000-8000-000000000002`
**Route:** Manipal Hospital HAL Bangalore → Sri Siddhartha Medical College, Tumkur (same NH-48 corridor as Scenario A)
**Distance:** ~72 km haversine, ~100 km along NH-48 (after 1.4× traffic factor)
**Cargo:** **Organ — Kidney** (highest urgency)
**Golden hour:** **120 minutes** (2 hours) — same physical clock as Scenario A
**Conditions:** Heavy rain, NH-48 incident at Yeshwantpur exit, evening peak (6:45 PM equivalent)

## Why this triggers a drone

Same physical 100-km route as Scenario A, same 2-hour deadline. The breach is driven entirely by **conditions on the road**:

1. Weather is `heavy_rain` → 1.35× ETA factor.
2. NH-48 has stop-and-go traffic from a freight lorry breakdown near Yeshwantpur — ambulance speed crashed from 35 → 0 → 18 kph by minute 5.
3. AI brain extrapolates the slow speed against the remaining 65 km of road and concludes the deadline is unreachable on wheels.

`will_breach` flips to `true` → state machine transitions trip to `DroneHandoff` → drone dispatch API is called → `HANDOFF_INITIATED` envelope hits the dashboard → modal pops.

## Decision walkthrough (snapshot at minute 5)

```
ambulance position = 12.9700, 77.6250          (only 4.7 km from origin — barely moving)
destination        = 13.3379, 77.1031
straight_m         = haversine ≈ 70.2 km
road_m             = 70.2 × 1.4 = 98.3 km
weather            = heavy_rain  (factor 1.35)
speed_reported     = 20 kph     (5-ping rolling average)
speed_eff          = 20 / 1.35 = 14.8 kph = 4.11 m/s
eta_seconds        = 98300 / 4.11 ≈ 23916 s   (398.6 min — almost 7 hours)
deadline_remaining = 7200 - 300  = 6900 s     (115 min)
buffer             = 6900 - 23916 = -17016 s
breach_prob        = 1/(1+exp(-17016/300)) ≈ 1.000
will_breach        = TRUE → drone handoff dispatched
```

## Expected UI state

| Surface | Renders |
|---|---|
| StatusBar | Green/connected. Feed badge fresh. |
| AI Brain panel | Breach probability bar at 99.9% (red). Reasoning text shows speed degradation + heavy rain. |
| Map | Ambulance creeps near Yeshwantpur. Corridor pulses tightly because the polygon barely advances. |
| FleetSwarm | 8–10 vehicles on NH-48 service roads in `evading` state. Mainline NH-48 northbound visibly cleared. |
| HandoffOverlay | **Pops at minute ~5** — full-viewport, drone ETA countdown, "Drone SIPRA-DRONE-K72X dispatched". |
| Hospital alert | Toast: "Sri Siddhartha Medical College Tumkur: drone arriving in 18 min, prep landing pad C." |

## File checklist

- `trip.json` — Trip create payload (Kidney, 120-min deadline)
- `pings.ndjson` — 25 GPS pings showing the speed cliff (35 → 0 → 18 kph) over 25 minutes
- `predict.request.json` — what the Risk Monitor sends at minute 5 (the breach poll)
- `predict.response.json` — `will_breach: true`, breach_prob ≈ 1.0
- `drone-dispatch.request.json` — what core-go POSTs to mock drone service
- `drone-dispatch.response.json` — successful drone assignment
- `fleet.json` — FleetVehicle[] with evading vehicles on NH-48 service roads
- `ws-events.ndjson` — full envelope sequence including HANDOFF_INITIATED
