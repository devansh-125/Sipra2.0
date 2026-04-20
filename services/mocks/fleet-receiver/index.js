// Sipra — Mock Partner Fleet Receiver
//
// A minimal Express server that impersonates a third-party logistics partner
// (e.g. Uber, Swiggy) receiving exclusion-zone webhooks from the Sipra core.
// Useful for local end-to-end testing of the B2B dispatcher worker pool.

const crypto = require("crypto");
const express = require("express");
const morgan = require("morgan");

const PORT = Number(process.env.PORT) || 4000;
// Must match the hmac_secret stored in webhook_partners for this mock partner.
const WEBHOOK_SECRET = process.env.SIPRA_WEBHOOK_SECRET || "test-secret";

const app = express();

// Capture raw body bytes before JSON parsing so we can verify the HMAC
// against the exact bytes that were signed — re-serialising req.body is
// unreliable (key order, whitespace).
app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(morgan("tiny"));

// ANSI colour helpers so the received payload pops in the terminal.
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function verifyHMAC(secret, rawBody, sigHeader) {
  if (!sigHeader || !sigHeader.startsWith("sha256=")) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  // timingSafeEqual requires equal-length buffers.
  const a = Buffer.from(expected);
  const b = Buffer.from(sigHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

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

  const sig = req.header("x-sipra-signature") || "(none)";
  const partner = req.header("x-sipra-partner") || "(unknown)";
  const sigValid = verifyHMAC(WEBHOOK_SECRET, req.rawBody || Buffer.alloc(0), sig);

  console.log(`\n${RED}🚨 EXCLUSION ZONE RECEIVED${RESET}`);
  console.log(`${YELLOW}  trip_id    ${RESET}${tripID ?? "(missing)"}`);
  if (corridorID) console.log(`${YELLOW}  corridor   ${RESET}${corridorID} (v${version ?? "?"})`);
  console.log(`${YELLOW}  partner    ${RESET}${partner}`);
  console.log(
    `${YELLOW}  signature  ${RESET}${DIM}${sig}${RESET} ${sigValid ? GREEN + "✓ valid" : RED + "✗ INVALID"}${RESET}`
  );
  console.log(`${YELLOW}  timestamp  ${RESET}${timestamp ?? new Date().toISOString()}`);
  if (polygon) {
    console.log(`${CYAN}  polygon.type   ${RESET}${polygon.type ?? "?"}`);
    if (Array.isArray(polygon.coordinates) && polygon.coordinates[0]) {
      console.log(`${CYAN}  polygon.points ${RESET}${polygon.coordinates[0].length}`);
    }
  }

  if (!sigValid) {
    console.log(`${RED}  → rejected: invalid HMAC signature${RESET}`);
    return res.status(401).json({ error: "invalid_signature" });
  }

  if (!tripID || !polygon) {
    return res.status(400).json({ error: "trip_id and polygon_geojson are required" });
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
  console.log(`HMAC secret: ${WEBHOOK_SECRET === "test-secret" ? "(default test-secret)" : "(custom)"}`);
});
