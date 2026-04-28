# Edge 1 — Peak-hour NH-48 (close call, no drone)

> Note: folder name retained from earlier MG Road scenario, but the dataset is now the NH-48 evening-peak variant of the standard 72 km / 2 hr corridor.

**Trip ID:** `00000003-0000-4000-8000-000000000003`
**Route:** Manipal HAL Bangalore → Sri Siddhartha Tumkur (same NH-48 as Scenario A)
**Cargo:** Vaccine batch
**Golden hour:** **120 minutes**
**Conditions:** Clear weather, NH-48 evening commute (6:30 PM equivalent), 50 kph cruise

## Why this is interesting

Same route as Scenarios A and B. Speed is genuinely slow because of evening peak — not stop-and-go like the breach scenario, just a steady 50 kph crawl. The math at minute 5:

```
straight_m  = 65.2 km
road_m      = 91.3 km
speed       = 50 kph        = 13.89 m/s
weather     = clear          (1.0)
eta_seconds = 91300 / 13.89  ≈ 6573 s   (109.5 min)
deadline    = 6900 s         (115 min remaining at minute 5)
buffer      = +327 s         (+5.5 min)
breach_prob = 1/(1+exp(327/300)) = 0.249
will_breach = FALSE → on track, but only just
```

This is the regime where the AI Brain panel's breach probability bar sits in the yellow zone (20–60%). UI must distinguish "delayed but on track" from both green (Scenario A, <5%) and red (Scenario B, >95%).

## Expected UI state

| Surface | Renders |
|---|---|
| AI Brain panel | Probability bar at ~25%, **yellow**. Reasoning highlights tight buffer. |
| Map | Ambulance moves visibly slower than Scenario A; corridor shape same. |
| StatusBar | Status badge: `Delayed` (yellow) — distinct from `In Transit` and `Drone Handoff`. |
| HandoffOverlay | NEVER shown unless conditions deteriorate further. |

## Files

- `README.md` — this file
- `trip.json` — Trip create payload
- `pings.ndjson` — 24 pings at 50 kph cruise (30-second intervals to cover ~12 km of journey)
- `predict.request.json` — minute-5 poll input
- `predict.response.json` — `will_breach=false`, `breach_probability=0.249`
