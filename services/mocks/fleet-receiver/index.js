// Sipra — Mock Partner Fleet Receiver
//
// A minimal Express server that impersonates a third-party logistics partner
// (e.g. Uber, Swiggy) receiving exclusion-zone webhooks from the Sipra core.
// Useful for local end-to-end testing of the B2B dispatcher worker pool.

const express = require("express");
const morgan = require("morgan");

const PORT = Number(process.env.PORT) || 4000;

const app = express();

// Generous JSON limit — GeoJSON polygons for long trips can grow large.
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));

// ANSI colour helpers so the received payload pops in the terminal.
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", service: "mock-fleet-receiver" });
});

app.post("/webhooks/exclusion-zone", (req, res) => {
  const {
    trip_id: tripID,
    corridor_id: corridorID,
    version,
    polygon_geojson: polygon,
    timestamp,
  } = req.body || {};

  if (!tripID || !polygon) {
    return res.status(400).json({ error: "trip_id and polygon_geojson are required" });
  }

  const sig = req.header("x-sipra-signature") || "(none)";
  const partner = req.header("x-sipra-partner") || "(unknown)";

  console.log(`\n${RED}🚨 EXCLUSION ZONE RECEIVED${RESET}`);
  console.log(`${YELLOW}  trip_id    ${RESET}${tripID}`);
  if (corridorID) console.log(`${YELLOW}  corridor   ${RESET}${corridorID} (v${version ?? "?"})`);
  console.log(`${YELLOW}  partner    ${RESET}${partner}`);
  console.log(`${YELLOW}  signature  ${RESET}${DIM}${sig}${RESET}`);
  console.log(`${YELLOW}  timestamp  ${RESET}${timestamp ?? new Date().toISOString()}`);
  console.log(`${CYAN}  polygon.type   ${RESET}${polygon.type ?? "?"}`);
  if (Array.isArray(polygon.coordinates) && polygon.coordinates[0]) {
    console.log(`${CYAN}  polygon.points ${RESET}${polygon.coordinates[0].length}`);
  }

  res.status(200).json({ received: true, trip_id: tripID });
});

app.use((err, _req, res, _next) => {
  console.error("mock-receiver error:", err);
  res.status(500).json({ error: "internal_error" });
});

app.listen(PORT, () => {
  console.log(`mock fleet receiver listening on :${PORT}`);
  console.log(`POST http://localhost:${PORT}/webhooks/exclusion-zone`);
});
