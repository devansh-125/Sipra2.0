# S2 — Congestion: real-life Bangalore → Tumkur with multi-zone bounty flow

Manipal Hospital HAL → Sri Siddhartha Medical College, Tumkur (NH-48, ~76 km).
Blood platelets, 150-minute golden hour. The 100-ping stream (20 s cadence,
T+0 → T+1980 s) follows the actual NH-48 corridor with **four real-world
congestion choke points** between free-flow stretches:

| Zone | Location                     | Pings        | Speed     |
|------|------------------------------|--------------|-----------|
| A    | Yeshwantpur Junction (peak)  | T+60–360 s   | 14–24 kph |
| B    | Nelamangala bypass + toll    | T+660–960 s  | 18–32 kph |
| C    | Dabaspete bottleneck         | T+1140–1300 s| 22–35 kph |
| D    | Tumkur outskirts             | T+1640–1840 s| 22–38 kph |

Free-flow segments run at 60–72 kph between zones. The fleet (40 vehicles)
includes **16 evading vehicles staged across the four zones** via per-vehicle
`spawn_at_seconds_into_trip`: each one materialises ~30 s before the ambulance
reaches its zone centre, takes the offered bounty, accelerates radially out of
the 2 km exclusion corridor, and verifies at its checkpoint. Persistent ambient
traffic (NH-48 mainline, oncoming, service-road, destination cluster) provides
visual coverage across the route.

Expected outcome: AI requests bounty boost during each congestion zone. Sixteen
bounties cycle Offered → Claimed → Verified across the trip. No drone handoff —
the ambulance reaches Tumkur within the 150 min golden hour.

Run from the dashboard's "RUN SCENARIO" button or via:

```
npx tsx scripts/play-scenario.ts --scenario=s2-congestion --speed=10
```
