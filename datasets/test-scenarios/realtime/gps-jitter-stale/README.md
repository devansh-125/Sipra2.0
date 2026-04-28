# Edge 6 — GPS jitter, duplicates, gaps, and out-of-bounds pings

**Trip ID:** `00000008-0000-4000-8000-000000000008`
**Route:** Manipal HAL Bangalore → Sri Siddhartha Tumkur (NH-48), 2 hr deadline.

## Why this is interesting

Real-world ambulance GPS hardware doesn't produce clean 1Hz pings. Tunnels drop signal, cheap modules jitter ±15m, and stuck devices keep republishing the last fix. This dataset exercises every form of bad ping the backend has to tolerate without poisoning the corridor or risk-prediction pipelines.

The current backend accepts these blindly — see [services/core-go/internal/api/rest/ping.go](../../../services/core-go/internal/api/rest/ping.go). This scenario also serves as the test fixture for the GPS-hygiene layer that's listed in [SCENARIOS.md §6 gap 3](../../SCENARIOS.md).

## What's in `pings.ndjson`

The 25-line file mixes the following pathological cases (one per line, in order):

| Line | Class | Payload notes |
|---|---|---|
| 1 | **Valid baseline** | Clean ping at origin |
| 2 | **Jitter ±15m** | Same intended position, lat shifted by 0.00013° |
| 3 | **Jitter ±15m** | Same intended position, lng shifted -0.00012° |
| 4 | **Duplicate** | Identical to line 1 (same lat/lng/speed/heading) |
| 5–8 | **Valid** | Real movement |
| 9 | **Stuck device** | lat/lng frozen, speed=0 (tunnel, signal lost) |
| 10 | **Stuck device** | identical to line 9 — backend should de-dupe |
| 11 | **Stuck device** | identical to line 9 — third dup |
| 12 | **Recovered** | Sudden jump 600m forward (signal re-acquired after the gap) |
| 13–14 | **Valid** | Real movement |
| 15 | **Out-of-bounds latitude** | lat=99.5 (clearly bogus, GPS module fault) |
| 16 | **Valid** | Real movement (backend should have dropped line 15) |
| 17 | **Negative speed** | speed_kph=-12 (sensor flip-flop) |
| 18 | **Impossibly fast** | speed_kph=312 (cosmic ray on serial line) |
| 19–22 | **Valid** | Real movement |
| 23 | **Stale timestamp** | Posted now but `recorded_at` 90s in the past |
| 24 | **Future timestamp** | `recorded_at` 60s in the future (clock skew) |
| 25 | **Valid** | Real movement, system recovered |

Run a hygiene-aware ingest layer over this file and ~9 of the 25 pings should be dropped/clamped. The risk monitor uses GetLatest, so it should fall back to the most recent valid ping (not blindly trust line 17/18/23/24).

## Expected UI state

| Surface | Renders |
|---|---|
| StatusBar | `feed` dot turns amber when no valid ping seen for 3+ seconds, red after 10s. |
| Map | Ambulance icon doesn't teleport — UI debounces position to last-valid-or-interpolated. |
| AI Brain panel | Reasoning text includes "ping_quality_warnings" label when latest ping is jitter-shifted. |

## Files

- `README.md` — this file
- `pings.ndjson` — 25 pings demonstrating each pathology (see table)
- `pings.expected-after-hygiene.ndjson` — what the hygiene layer should keep (16 pings)
