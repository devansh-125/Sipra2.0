// Sipra — Mock Drone Dispatch API
//
// Simulates an autonomous drone fleet coordinator that the Sipra core calls
// when the AI brain returns recommendation = DISPATCH_DRONE. The mock owns
// the *inventory* side of dispatch — drone identity, battery, launch pad —
// and the AI brain owns the *kinetic* side — weather-adjusted cruise,
// altitude, and ETA. When the caller supplies an `ai_predicted` block
// (produced by POST /predict-drone), the mock echoes those numbers
// straight back in the response so the dashboard banner reflects the
// AI's view of the flight, not a hardcoded sample. Without that block
// the mock falls back to spec-sheet defaults so legacy callers still work.
//
// Response contract is locked in
//   datasets/realtime/drone-dispatch.sample.response.json

const express = require("express");
const morgan  = require("morgan");
const crypto  = require("crypto");

const PORT = Number(process.env.PORT) || 4003;

const app = express();

// In-memory log of every dispatch call — queried by the e2e test via GET /calls.
const dispatchCalls = [];

app.use(express.json({ limit: "256kb" }));
app.use(morgan("tiny"));

// ANSI colour helpers.
const GREEN   = "\x1b[32m";
const YELLOW  = "\x1b[33m";
const CYAN    = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const DIM     = "\x1b[2m";
const RESET   = "\x1b[0m";

// --------------------------------------------------------------------
// Drone fleet specification (Sipra-MK2 — the only model in the demo).
// Cruise/altitude/spin-up are spec-sheet defaults used only when the
// AI brain didn't supply weather-adjusted values in the request.
// --------------------------------------------------------------------
const DRONE_MODEL          = "Sipra-MK2";
const MAX_PAYLOAD_KG       = 4.5;
const DEFAULT_ALTITUDE_M   = 120;
const DEFAULT_CRUISE_KPH   = 95;
const DEFAULT_SPIN_UP_S    = 60;
const BATTERY_PCT_MIN      = 70;
const BATTERY_PCT_MAX      = 95;

// Bangalore-area launch pads (lat, lng). Real heliport / DGCA-greenlit
// drone-corridor anchor points around the city. Dispatcher picks the
// closest pad to the pickup so the drone metadata reads sensibly on
// the operator dashboard.
const LAUNCH_PADS = [
  { id: "BLR-PAD-01-HAL",          lat: 12.9509, lng: 77.6680 }, // HAL Airport
  { id: "BLR-PAD-02-WHITEFIELD",   lat: 12.9698, lng: 77.7500 },
  { id: "BLR-PAD-03-YESHWANTPUR",  lat: 13.0280, lng: 77.5500 },
  { id: "BLR-PAD-04-ELECTRONIC",   lat: 12.8456, lng: 77.6603 }, // Electronic City
  { id: "BLR-PAD-05-DEVANAHALLI",  lat: 13.1986, lng: 77.7066 }, // KIA region
  { id: "BLR-PAD-06-TUMKUR-RD",    lat: 13.0850, lng: 77.4900 },
];

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

// Stable drone identifier — repeated calls for the same trip get the same
// drone, keeping the dashboard view consistent across reconnects.
function droneIDForTrip(tripID) {
  const hash   = crypto.createHash("sha256").update(String(tripID)).digest("hex");
  const suffix = hash.slice(0, 6).toUpperCase();
  return `SIPRA-DRONE-${suffix}`;
}

// Battery — deterministic in [BATTERY_PCT_MIN, BATTERY_PCT_MAX] from trip_id.
function batteryPctForTrip(tripID) {
  const hash = crypto.createHash("sha256").update(String(tripID) + ":battery").digest();
  const pick = hash[0]; // 0..255
  const range = BATTERY_PCT_MAX - BATTERY_PCT_MIN;
  return BATTERY_PCT_MIN + (pick % (range + 1));
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function nearestPad(lat, lng) {
  let best = LAUNCH_PADS[0];
  let bestKm = haversineKm(lat, lng, best.lat, best.lng);
  for (let i = 1; i < LAUNCH_PADS.length; i++) {
    const p  = LAUNCH_PADS[i];
    const km = haversineKm(lat, lng, p.lat, p.lng);
    if (km < bestKm) { best = p; bestKm = km; }
  }
  return { pad: best, distanceKm: bestKm };
}

// --------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", service: "mock-drone-dispatch" });
});

app.post("/api/v1/drones/dispatch", (req, res) => {
  const {
    trip_id:      tripID,
    pickup,
    dropoff,
    cargo_type:   cargoType,
    priority,
    ai_predicted: aiPredicted,
  } = req.body || {};

  if (!tripID || !pickup || !dropoff) {
    return res.status(400).json({ error: "trip_id, pickup, and dropoff are required" });
  }

  const droneID    = droneIDForTrip(tripID);
  const batteryPct = batteryPctForTrip(tripID);

  // Kinetic numbers come from the AI brain when present. The mock keeps
  // a spec-sheet fallback so it still functions if the caller skipped
  // /predict-drone.
  const haversineRouteKm = haversineKm(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng);

  const cruiseKph   = Number((aiPredicted && aiPredicted.cruise_kph)        || DEFAULT_CRUISE_KPH);
  const altitudeM   = Number((aiPredicted && aiPredicted.altitude_m_cruise) || DEFAULT_ALTITUDE_M);
  const spinUpS     = Number((aiPredicted && aiPredicted.spin_up_seconds)   || DEFAULT_SPIN_UP_S);
  const routeKm     = Number((aiPredicted && aiPredicted.route_km)          || haversineRouteKm);
  const weather     = (aiPredicted && aiPredicted.weather_condition) || "unknown";

  const fallbackFlightS = (routeKm / cruiseKph) * 3600;
  const etaSeconds  = Math.round(
    Number((aiPredicted && aiPredicted.eta_seconds) || (fallbackFlightS + spinUpS)),
  );

  const { pad: launchPad } = nearestPad(pickup.lat, pickup.lng);

  const droneMetadata = {
    model:             DRONE_MODEL,
    max_payload_kg:    MAX_PAYLOAD_KG,
    battery_pct:       batteryPct,
    launch_pad_id:     launchPad.id,
    altitude_m_cruise: altitudeM,
    cruise_kph:        cruiseKph,
    route_km:          Number(routeKm.toFixed(1)),
  };

  dispatchCalls.push({
    trip_id:        tripID,
    drone_id:       droneID,
    eta_seconds:    etaSeconds,
    drone_metadata: droneMetadata,
    ai_predicted:   aiPredicted ?? null,
    dispatched_at:  new Date().toISOString(),
  });

  const sourceLabel = aiPredicted ? "ai_brain" : "mock_default";

  console.log(`\n${GREEN}🚁 DRONE DISPATCH REQUEST${RESET}`);
  console.log(`${YELLOW}  trip_id    ${RESET}${tripID}`);
  console.log(`${YELLOW}  drone_id   ${RESET}${MAGENTA}${droneID}${RESET}`);
  console.log(`${YELLOW}  cargo      ${RESET}${cargoType ?? "(unknown)"} — priority: ${priority ?? "(unknown)"}`);
  console.log(`${CYAN}  launch_pad ${RESET}${launchPad.id}`);
  console.log(`${CYAN}  battery    ${RESET}${batteryPct}%`);
  console.log(`${CYAN}  pickup     ${RESET}${DIM}(${pickup.lat.toFixed(4)}, ${pickup.lng.toFixed(4)})${RESET}`);
  console.log(`${CYAN}  dropoff    ${RESET}${DIM}(${dropoff.lat.toFixed(4)}, ${dropoff.lng.toFixed(4)})${RESET}`);
  console.log(`${CYAN}  weather    ${RESET}${weather}`);
  console.log(`${CYAN}  route      ${RESET}${routeKm.toFixed(2)} km @ ${cruiseKph.toFixed(1)} kph (${sourceLabel})`);
  console.log(`${CYAN}  altitude   ${RESET}${altitudeM} m`);
  console.log(`${CYAN}  spin-up    ${RESET}${spinUpS}s`);
  console.log(`${CYAN}  eta        ${RESET}${etaSeconds}s`);

  res.status(200).json({
    drone_id:       droneID,
    eta_seconds:    etaSeconds,
    status:         "DISPATCHED",
    drone_metadata: droneMetadata,
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
