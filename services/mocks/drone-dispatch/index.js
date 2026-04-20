// Sipra — Mock Drone Dispatch API
//
// Impersonates an autonomous drone fleet coordinator that the Sipra core
// calls when the AI brain predicts a golden-hour breach.  The server
// deterministically derives a drone_id from the trip_id and returns a
// simulated ETA so the Risk Monitor can include both in the HANDOFF_INITIATED
// WebSocket broadcast.

const express = require("express");
const morgan = require("morgan");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 4003;

const app = express();

// In-memory log of every dispatch call — queried by the e2e test via GET /calls.
const dispatchCalls = [];

app.use(express.json({ limit: "256kb" }));
app.use(morgan("tiny"));

// ANSI colour helpers.
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const DIM    = "\x1b[2m";
const RESET  = "\x1b[0m";

// Derive a stable drone identifier from the trip_id so repeated calls for the
// same trip always get the same drone (useful for UI consistency in demos).
function droneIDForTrip(tripID) {
  const hash = crypto.createHash("sha256").update(String(tripID)).digest("hex");
  const suffix = hash.slice(0, 6).toUpperCase();
  return `SIPRA-DRONE-${suffix}`;
}

// Haversine distance in km between two lat/lng pairs.
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", service: "mock-drone-dispatch" });
});

app.post("/api/v1/drones/dispatch", (req, res) => {
  const { trip_id: tripID, pickup, dropoff, cargo_type: cargoType, priority } =
    req.body || {};

  if (!tripID || !pickup || !dropoff) {
    return res
      .status(400)
      .json({ error: "trip_id, pickup, and dropoff are required" });
  }

  const droneID = droneIDForTrip(tripID);

  // ETA estimate: drone cruises at ~120 km/h; add 60s spin-up.
  const distKm = haversineKm(
    pickup.lat,
    pickup.lng,
    dropoff.lat,
    dropoff.lng
  );
  const cruiseSpeedKmH = 120;
  const etaSeconds = Math.round((distKm / cruiseSpeedKmH) * 3600 + 60);

  dispatchCalls.push({
    trip_id: tripID,
    drone_id: droneID,
    eta_seconds: etaSeconds,
    dispatched_at: new Date().toISOString(),
  });

  console.log(`\n${GREEN}🚁 DRONE DISPATCH REQUEST${RESET}`);
  console.log(`${YELLOW}  trip_id    ${RESET}${tripID}`);
  console.log(`${YELLOW}  drone_id   ${RESET}${MAGENTA}${droneID}${RESET}`);
  console.log(`${YELLOW}  cargo      ${RESET}${cargoType ?? "(unknown)"} — priority: ${priority ?? "(unknown)"}`);
  console.log(
    `${CYAN}  pickup     ${RESET}${DIM}(${pickup.lat.toFixed(4)}, ${pickup.lng.toFixed(4)})${RESET}`
  );
  console.log(
    `${CYAN}  dropoff    ${RESET}${DIM}(${dropoff.lat.toFixed(4)}, ${dropoff.lng.toFixed(4)})${RESET}`
  );
  console.log(`${CYAN}  dist       ${RESET}${distKm.toFixed(2)} km`);
  console.log(`${CYAN}  eta        ${RESET}${etaSeconds}s`);

  res.status(200).json({
    drone_id: droneID,
    eta_seconds: etaSeconds,
    status: "DISPATCHED",
  });
});

app.get("/calls", (_req, res) => {
  res.json({ count: dispatchCalls.length, calls: dispatchCalls });
});

app.use((err, _req, res, _next) => {
  console.error("mock-drone-dispatch error:", err);
  res.status(500).json({ error: "internal_error" });
});

app.listen(PORT, () => {
  console.log(`mock drone dispatch listening on :${PORT}`);
  console.log(`POST http://localhost:${PORT}/api/v1/drones/dispatch`);
});
