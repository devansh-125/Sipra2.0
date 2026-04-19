/**
 * Starts a mock WS server on :8080/ws/dashboard, waits for the Next.js
 * dashboard to connect, sends a HANDOFF_INITIATED message, then exits.
 *
 * Usage: cd scripts && npx tsx test-handoff-banner.ts
 * Prerequisites: Go backend must be STOPPED (this occupies :8080 temporarily).
 */
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';

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
console.log(`[test] Mock WS server listening on ws://localhost:${PORT}${PATH}`);
console.log('[test] Open http://localhost:3000 in your browser, then watch for the banner.');

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  if (req.url !== PATH) { ws.close(); return; }
  console.log('[test] Dashboard connected — sending HANDOFF_INITIATED in 1s…');

  setTimeout(() => {
    ws.send(HANDOFF_MSG);
    console.log('[test] Sent. Banner should appear. Server will exit in 12s (banner auto-dismisses at 10s).');
    setTimeout(() => { wss.close(); process.exit(0); }, 12_000);
  }, 1_000);
});
