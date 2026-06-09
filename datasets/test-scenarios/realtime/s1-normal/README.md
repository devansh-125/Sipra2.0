# S1 — Normal: clear highway cruise, minimal bounty

Manipal Hospital HAL → Sri Siddhartha Medical College, Tumkur (NH-48, ~100 km). Kidney organ, 150-minute golden hour. Mid-morning clear weather at 70–80 kph. The ping stream is replayed at a 20s cadence and extends to the destination so the Risk Monitor can tick multiple times. Expected outcome: AI stays green (no breach), minimal bounty activity.

**Note on deadline:** 90 min was the original target when using the Google Routes API (real traffic-aware ETA ≈ 80 min with ambulance priority — a narrow pass). Without `GOOGLE_MAPS_API_KEY` set, the AI brain falls back to haversine × 1.4 = 101 km, which gives a pessimistic ETA of ~97 min at cruise speed and triggers a false drone dispatch. The 150-min deadline works correctly in both modes.

Run: `npx tsx scripts/play-scenario.ts --scenario=s1-normal --speed=10`
