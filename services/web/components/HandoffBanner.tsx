'use client';

import { useEffect, useState } from 'react';
import type { HandoffInitiatedPayload } from '../lib/types';

interface Props {
  handoffState: HandoffInitiatedPayload | null;
}

export default function HandoffBanner({ handoffState }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!handoffState) return;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 10_000);
    return () => clearTimeout(timer);
  }, [handoffState]);

  if (!visible || !handoffState) return null;

  const eta = handoffState.eta_seconds ?? handoffState.predicted_eta_seconds;
  const droneLabel = handoffState.drone_id ?? 'UNKNOWN';

  return (
    <>
      <style>{`
        @keyframes handoff-flash {
          0%, 100% { border-color: #ff1744; box-shadow: 0 0 18px 4px rgba(255,23,68,0.7); }
          50%       { border-color: #ff6d00; box-shadow: 0 0 32px 8px rgba(255,109,0,0.5); }
        }
        @keyframes handoff-slide-in {
          from { transform: translateY(-100%); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
      `}</style>
      <div
        role="alert"
        aria-live="assertive"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 9999,
          padding: '14px 24px',
          background: 'linear-gradient(90deg, #b71c1c 0%, #d32f2f 40%, #bf360c 100%)',
          border: '2.5px solid #ff1744',
          color: '#fff',
          fontFamily: 'monospace',
          fontSize: 15,
          fontWeight: 700,
          letterSpacing: 1,
          textAlign: 'center',
          animation: 'handoff-slide-in 0.35s ease-out, handoff-flash 1.1s ease-in-out infinite',
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={() => setVisible(false)}
        title="Click to dismiss"
      >
        🚁 DRONE HANDOFF INITIATED — Drone {droneLabel} en route, ETA {eta}s — {handoffState.reason}
      </div>
    </>
  );
}
