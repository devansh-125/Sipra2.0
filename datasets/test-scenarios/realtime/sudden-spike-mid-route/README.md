# Edge 5 — Sudden congestion spike mid-route

**Trip ID:** `00000007-0000-4000-8000-000000000007`
**Route:** Manipal HAL Bangalore → Sri Siddhartha Tumkur (NH-48), 2 hr deadline.

## Why this is interesting

The trip starts perfectly. 80 kph cruise on the Bangalore-Tumkur expressway, breach_prob ≈ 0 for the first 17 minutes. Then at minute 18, near Dabaspete, a multi-vehicle accident drops speed to 8 kph for the next 12 minutes.

This is the regime that the **risk monitor's polling cadence** is designed for — the AI has to detect the trend across consecutive polls and trigger handoff before too much of the deadline burns. Three RISK_PREDICTION envelopes in sequence show the breach probability climbing from 0 → 0.4 → 0.95+ → handoff.

## Decision walkthrough — three poll cycles

| Poll | Minute | Speed reported | ETA seconds | buffer_s | breach_prob | will_breach |
|---|---|---|---|---|---|---|
| 1 | 5  | 80 kph | 4108 | +2792 | 0.000 | false |
| 2 | 18 | 50 kph | 4250 | +1750 | 0.003 | false |
| 3 | 22 | 12 kph | 14400 | -8260 | 1.000 | TRUE → drone |

This sequence demonstrates that the system isn't fooled by a momentary slowdown — it waits until the rolling-average speed degrades before recommending handoff.

## Expected UI state

The AI Brain panel's breach-probability bar should *animate* upward over the three poll cycles, not jump directly to red. The HandoffOverlay only appears at poll 3.

## Files

- `README.md` — this file
- `trip.json` — Trip create payload
- `pings.ndjson` — 30 pings: smooth highway → accident → near-stop
- `predict-sequence.ndjson` — three predictions over time
- `ws-events.ndjson` — interleaved sequence with HANDOFF_INITIATED at minute 22
