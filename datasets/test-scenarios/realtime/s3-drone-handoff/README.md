# S3 — Drone Handoff: blockage triggers immediate drone dispatch

Manipal Hospital HAL → Sri Siddhartha Medical College, Tumkur (NH-48, ~100 km). Kidney organ, 90-minute golden hour. A freight lorry blocks NH-48 at Yeshwantpur within minutes of departure. The ping stream decelerates to 0 kph and stalls long enough for multiple Risk Monitor polls. Expected outcome: AI flags breach and fires HANDOFF_INITIATED; the drone mock dispatches.

Run: `npx tsx scripts/play-scenario.ts --scenario=s3-drone-handoff --speed=10`
