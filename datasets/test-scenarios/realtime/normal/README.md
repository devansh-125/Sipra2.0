# Scenario A — Normal Flow (no drone required)

**Trip ID (deterministic):** `00000001-0000-4000-8000-000000000001`
**Route:** Manipal Hospital HAL Bangalore → Sri Siddhartha Medical College, Tumkur
**Distance:** ~72 km haversine, ~100 km along NH-48 (after 1.4× traffic factor)
**Cargo:** Vaccine batch — refrigerated, non-organ
**Golden hour:** **120 minutes** (2 hours) — typical for inter-city cold-chain transport
**Conditions:** Clear weather, light highway traffic, mid-morning (10:30 AM equivalent)

## Why this is the "normal" baseline

This is the long-haul medical transport corridor that real Bangalore trauma referrals use — Manipal HAL handles the patient, Sri Siddhartha is the receiving tertiary care in Tumkur. 75 kph cruise on NH-48 is realistic. AI brain's sigmoid puts `breach_probability ≈ 0.0002` at minute 5 — well below any handoff threshold. Drone never enters the picture.

## Decision walkthrough (snapshot at minute 5 of trip)

```
ambulance position = 13.000, 77.595          (after 5 min on NH-48)
destination        = 13.3379, 77.1031
straight_m         = haversine ≈ 65.2 km
road_m             = 65.2 × 1.4 = 91.3 km
weather            = clear        (factor 1.0)
speed              = 75 kph       = 20.83 m/s
eta_seconds        = 91300 / 20.83 ≈ 4382 s   (73.0 min)
deadline_remaining = 7200 - 300   = 6900 s    (115 min)
buffer             = 6900 - 4382  = +2518 s   (+42 min)
breach_prob        = 1/(1+exp(2518/300)) ≈ 0.0002
will_breach        = FALSE → continue, no handoff
```

## Expected UI state

| Surface | Renders |
|---|---|
| StatusBar | Green dots — `connected` + `feed` fresh. |
| AI Brain panel | "ON TRACK — continue monitoring." Breach probability bar at <1%. |
| Map | Ambulance icon glides north-west from Manipal HAL toward Nelamangala/Dabaspete on NH-48. Pulsing 2 km exclusion polygon trails it. |
| FleetSwarm | 20 vehicles roaming on NH-48 service roads, Yeshwantpur, Peenya industrial belt. 0–3 evading as the corridor sweeps each. |
| HandoffOverlay | NEVER shown. |
| Driver phone (`/driver/[tripId]`) | Drivers near the corridor see proximity card + bounty offer; verify path completes. |

## File checklist

- `trip.json` — Trip create payload (Vaccine, 120-min deadline)
- `pings.ndjson` — 24 GPS pings spaced 1 minute apart (24 minutes of journey along NH-48)
- `predict.request.json` — what the Risk Monitor sends to the AI brain at minute 5
- `predict.response.json` — bit-exact AI brain response, will_breach=false
- `fleet.json` — FleetVehicle[] snapshot at minute 5 (NH-48 corridor adjacent vehicles)
- `ws-events.ndjson` — WebSocket envelopes the dashboard receives during the first 5 minutes
