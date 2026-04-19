// Plain Node.js — no tsx/esbuild needed. Run: node test-handoff-banner.js
// Stop the Go backend first (both use :8080), then open http://localhost:3000.
const { WebSocketServer } = require('ws');

const PORT = 8080;
const PATH = '/ws/dashboard';

const HANDOFF_MSG = JSON.stringify({
  type: 'HANDOFF_INITIATED',
  timestamp: new Date().toISOString(),
  payload: {
    trip_id: 'test-trip-001',
    drone_id: 'DRN-42',
    eta_seconds: 87,
    reason: 'Golden hour breach predicted',
    predicted_eta_seconds: 120,
  },
});

const wss = new WebSocketServer({ port: PORT });
console.log(`[test] Mock WS server on ws://localhost:${PORT}${PATH}`);
console.log('[test] Open http://localhost:3000 — banner appears ~1s after connect.');

wss.on('connection', (ws, req) => {
  if (req.url !== PATH) { ws.close(); return; }
  console.log('[test] Dashboard connected — sending HANDOFF_INITIATED in 1s…');
  setTimeout(() => {
    ws.send(HANDOFF_MSG);
    console.log('[test] Sent! Banner should slide in. Exiting in 12s.');
    setTimeout(() => { wss.close(); process.exit(0); }, 12_000);
  }, 1_000);
});
