# Edge 2 — Conflicting ETAs across simultaneous trips

**Trip IDs (deterministic):**
- `00000004-0000-4000-8000-000000000401` — Trip α (vaccine, on track)
- `00000004-0000-4000-8000-000000000402` — Trip β (blood, close call)
- `00000004-0000-4000-8000-000000000403` — Trip γ (organ, breach)

**Route (all three):** Manipal HAL Bangalore → Sri Siddhartha Tumkur (NH-48), 2 hr deadline.
**Fleet:** Single FleetSwarm of 20 vehicles serves all three corridors.

## Why this is interesting

Three ambulances dispatched within seconds of each other along the same arterial. Each reports a different speed. The brain returns three contradictory recommendations in the same poll cycle. UI must:

1. **Stack RISK_PREDICTION envelopes** by `trip_id` — not last-write-wins.
2. **Visually order** the AI Brain panel by descending breach probability so the operator sees the highest-risk trip first.
3. **Run three corridors simultaneously** on the map, each with its own color/version.
4. **Coordinate fleet rerouting**: a vehicle that's evading Trip γ's corridor may be entering Trip α's corridor seconds later. Reroute decisions must use the union of corridors, not just the first.

## Decision walkthrough — all three at minute 5

| | Trip α (vaccine) | Trip β (blood) | Trip γ (organ) |
|---|---|---|---|
| Speed reported | 75 kph | 50 kph | 22 kph |
| Weather | clear | clear | light_rain |
| Speed_eff | 75 kph | 50 kph | 19.1 kph |
| ETA seconds | 4382 | 6573 | 18495 |
| Deadline remaining | 6900 | 6900 | 6900 |
| Buffer | +2518 s | +327 s | -11595 s |
| breach_probability | 0.0002 | 0.249 | ~1.0 |
| will_breach | false | false | true |
| Drone? | NO | NO (yellow alert) | YES |

## Files

- `trips.json` — array of three Trip create payloads
- `predict-responses.ndjson` — three RISK_PREDICTION envelopes from the same poll cycle
- `ws-events.ndjson` — interleaved sequence: GPS_UPDATE × 3, RISK_PREDICTION × 3, HANDOFF_INITIATED × 1
