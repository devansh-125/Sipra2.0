# Edge 4 — AI says breach, drone dispatch fails

**Trip ID:** `00000006-0000-4000-8000-000000000006`
**Route:** Manipal HAL Bangalore → Sri Siddhartha Tumkur (NH-48), 2 hr deadline.
**Conditions:** identical to Scenario B (heavy rain, NH-48 incident). Brain returns `will_breach=true`. **But the drone dispatch endpoint returns 503.**

## Why this is interesting

Tests the graceful-degradation path documented in [services/core-go/internal/risk/monitor.go:177](../../../services/core-go/internal/risk/monitor.go#L177):

```go
dr, err := m.dispatcher.Dispatch(...)
if err != nil {
    log.Warn("drone dispatch failed — broadcasting without drone info")
} else {
    droneID = dr.DroneID
    droneETA = dr.ETASeconds
}
m.hub.BroadcastHandoffInitiatedFull(tripID, droneID, droneETA, ...)
```

The trip **still transitions** to `DroneHandoff` in the database (state-machine guard).
The `HANDOFF_INITIATED` envelope **still fires** but with `drone_id=""` and `eta_seconds=0`.
The dashboard must distinguish "drone dispatched" from "drone tried, failed".

## Expected UI state

| Surface | Renders |
|---|---|
| HandoffOverlay | Pops, but with **red banner**: "Drone dispatch failed — manual coordination required". |
| Hospital alert | Toast: "Sri Siddhartha Medical College Tumkur: drone unavailable, ambulance crew advised to attempt alternate route." |
| AI Brain panel | Probability 1.0, but recommendations now include "Escalate to manual dispatcher". |
| StatusBar | Status badge: `Drone Failed → Manual` (red). |

## Files

- `README.md` — this file
- `predict.response.json` — same as Scenario B (will_breach=true)
- `drone-dispatch.error.json` — the 503 response body our mock can return
- `ws-events.ndjson` — HANDOFF_INITIATED with empty drone fields
