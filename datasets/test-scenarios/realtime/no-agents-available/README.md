# Edge 3 — No partner agents available in corridor

**Trip ID:** `00000005-0000-4000-8000-000000000005` (any active trip — this scenario is fleet-side)
**Route:** Manipal HAL Bangalore → Sri Siddhartha Tumkur, 2 hr deadline.

## Why this is interesting

Late-night corridor (2 AM equivalent) over rural NH-48 between Dabaspete and Tumkur — there are no Uber/Swiggy partner vehicles in the 20 km buffer either side of the highway. The fleet broadcast is empty.

This is a partner-side, not ambulance-side, breach. The trip itself is on track — clear weather, 75 kph cruise, will_breach=false. But:

- **Bounty offers cannot be made** because no driver_ref exists in range.
- **Webhook fan-out has zero recipients** — the corridor still publishes, but no partner receives it.
- **Reroute simulation idle** — FleetSwarm renders 0 vehicles.

The right UI behavior is a calm informational badge ("0 partners in corridor"), not an alarm — no agents nearby is normal at 2 AM.

## Files

- `README.md` — this file
- `fleet-empty.json` — the literal `[]` body the sim posts to `/api/v1/sim/fleet`
- `chaos-event.json` — the chaos-panel event that drains the fleet (for testing the UI in daytime conditions)
- `ws-events.ndjson` — sequence showing FLEET_UPDATE with empty `fleet`
