'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { toast } from 'sonner';
import { useSipraWebSocket } from '../../hooks/useSipraWebSocket';
import type { HandoffInitiatedPayload } from '../../lib/types';

const WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? 'ws://localhost:8080/ws/dashboard';

const KEYFRAMES = `
@keyframes amb-fade-out {
  0%   { opacity: 1; transform: translateX(0) scale(1); }
  100% { opacity: 0; transform: translateX(-40px) scale(0.85); }
}
@keyframes drone-fade-in {
  0%   { opacity: 0; transform: translateX(40px) scale(0.85); }
  100% { opacity: 1; transform: translateX(0) scale(1); }
}
`;

function AmbulanceSVG({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 80 56" className={className} aria-hidden fill="none">
      {/* Body */}
      <rect x="4" y="18" width="50" height="30" rx="4" fill="#dc2626" />
      {/* Cab */}
      <rect x="54" y="26" width="22" height="22" rx="3" fill="#b91c1c" />
      {/* Windshield */}
      <rect x="56" y="28" width="14" height="10" rx="2" fill="#93c5fd" opacity="0.6" />
      {/* Wheels */}
      <circle cx="18" cy="50" r="7" fill="#1f2937" />
      <circle cx="18" cy="50" r="3.5" fill="#6b7280" />
      <circle cx="60" cy="50" r="7" fill="#1f2937" />
      <circle cx="60" cy="50" r="3.5" fill="#6b7280" />
      {/* Medical cross */}
      <rect x="22" y="26" width="14" height="3" rx="1.5" fill="white" />
      <rect x="27.5" y="20.5" width="3" height="14" rx="1.5" fill="white" />
      {/* Siren */}
      <rect x="20" y="14" width="10" height="5" rx="2" fill="#fbbf24" />
    </svg>
  );
}

function DroneSVG({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 80 80" className={className} aria-hidden fill="none">
      {/* Arms */}
      <line x1="28" y1="28" x2="10" y2="10" stroke="#7c3aed" strokeWidth="5" strokeLinecap="round" />
      <line x1="52" y1="28" x2="70" y2="10" stroke="#7c3aed" strokeWidth="5" strokeLinecap="round" />
      <line x1="28" y1="52" x2="10" y2="70" stroke="#7c3aed" strokeWidth="5" strokeLinecap="round" />
      <line x1="52" y1="52" x2="70" y2="70" stroke="#7c3aed" strokeWidth="5" strokeLinecap="round" />
      {/* Body */}
      <rect x="26" y="26" width="28" height="28" rx="5" fill="#6d28d9" />
      {/* Propellers */}
      <ellipse cx="10" cy="10" rx="9" ry="3.5" fill="#a78bfa" transform="rotate(-45 10 10)" />
      <ellipse cx="70" cy="10" rx="9" ry="3.5" fill="#a78bfa" transform="rotate(45 70 10)" />
      <ellipse cx="10" cy="70" rx="9" ry="3.5" fill="#a78bfa" transform="rotate(45 10 70)" />
      <ellipse cx="70" cy="70" rx="9" ry="3.5" fill="#a78bfa" transform="rotate(-45 70 70)" />
      {/* Hub dots */}
      <circle cx="10" cy="10" r="3" fill="#c4b5fd" />
      <circle cx="70" cy="10" r="3" fill="#c4b5fd" />
      <circle cx="10" cy="70" r="3" fill="#c4b5fd" />
      <circle cx="70" cy="70" r="3" fill="#c4b5fd" />
      {/* Camera lens */}
      <circle cx="40" cy="40" r="7" fill="#1e1b4b" />
      <circle cx="40" cy="40" r="4" fill="#c4b5fd" />
    </svg>
  );
}

function ReadoutRow({
  label,
  value,
  highlight,
  large,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  large?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest">{label}</p>
      <p
        className={`font-mono font-bold tabular-nums ${
          large
            ? 'text-5xl text-red-400'
            : highlight
              ? 'text-lg text-foreground'
              : 'text-sm text-muted-foreground'
        }`}
      >
        {value}
      </p>
    </div>
  );
}

export default function HandoffOverlay() {
  const { handoffState, clearHandoff } = useSipraWebSocket(WS_URL);
  const [open, setOpen] = useState(false);
  const [displayed, setDisplayed] = useState<HandoffInitiatedPayload | null>(null);
  const [etaLeft, setEtaLeft] = useState(0);
  const toastFiredRef = useRef(false);

  // Open and update displayed data when a handoff arrives.
  useEffect(() => {
    if (!handoffState) return;
    setDisplayed(handoffState);
    setOpen(true);
    setEtaLeft(handoffState.eta_seconds ?? handoffState.predicted_eta_seconds);
    toastFiredRef.current = false;
  }, [handoffState]);

  // Fire sonner toast exactly once per handoff activation.
  useEffect(() => {
    if (!open || !displayed || toastFiredRef.current) return;
    toastFiredRef.current = true;
    toast(`Handoff initiated for trip ${displayed.trip_id.slice(0, 8)}\u2026`, {
      duration: 8_000,
    });
  }, [open, displayed]);

  // ETA countdown — one tick per second.
  useEffect(() => {
    if (!open || etaLeft <= 0) return;
    const id = setInterval(() => setEtaLeft(n => Math.max(0, n - 1)), 1_000);
    return () => clearInterval(id);
  }, [open, etaLeft]);

  // Auto-dismiss after 30 s; timer resets if a new handoff arrives while open.
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => handleClose(), 30_000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, displayed]);

  const handleClose = useCallback(() => {
    setOpen(false);
    clearHandoff();
  }, [clearHandoff]);

  // Nothing to show until the first handoff has been received.
  if (!displayed) return null;

  return (
    <>
      <style>{KEYFRAMES}</style>
      <DialogPrimitive.Root open={open} onOpenChange={o => { if (!o) handleClose(); }}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <DialogPrimitive.Content
            className="fixed inset-0 z-50 flex items-center justify-center p-6 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
            aria-describedby={undefined}
          >
            <DialogPrimitive.Title className="sr-only">Drone Handoff Initiated</DialogPrimitive.Title>

            <div className="relative w-full max-w-3xl bg-card border border-border rounded-2xl shadow-2xl overflow-hidden">
              {/* Close */}
              <DialogPrimitive.Close
                onClick={handleClose}
                className="absolute top-4 right-4 z-10 rounded-sm text-muted-foreground opacity-70 hover:opacity-100 transition-opacity focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                aria-label="Dismiss handoff alert"
              >
                <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                  <path
                    fillRule="evenodd"
                    d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  />
                </svg>
              </DialogPrimitive.Close>

              {/* Alert header */}
              <div className="bg-red-950/60 border-b border-red-500/30 px-8 py-4">
                <p className="font-mono text-xs text-red-400 uppercase tracking-widest">
                  Mission-Critical Alert
                </p>
                <p className="font-mono text-xl font-bold text-red-300 mt-0.5 tracking-wide">
                  DRONE HANDOFF INITIATED
                </p>
              </div>

              {/* Body: swap animation | readout */}
              <div className="flex flex-col sm:flex-row gap-0">
                {/* Left — icon swap animation */}
                <div className="flex-1 flex flex-col items-center justify-center gap-4 py-10 px-8">
                  <div className="relative w-40 h-40">
                    <div
                      className="absolute inset-0 flex items-center justify-center"
                      style={{ animation: 'amb-fade-out 1.5s ease-in-out forwards' }}
                    >
                      <AmbulanceSVG className="w-36 h-36" />
                    </div>
                    <div
                      className="absolute inset-0 flex items-center justify-center"
                      style={{ animation: 'drone-fade-in 1.5s ease-in-out forwards', opacity: 0 }}
                    >
                      <DroneSVG className="w-36 h-36" />
                    </div>
                  </div>
                  <p className="font-mono text-xs text-muted-foreground uppercase tracking-widest">
                    Drone taking over
                  </p>
                </div>

                {/* Divider */}
                <div className="hidden sm:block w-px bg-border self-stretch" />

                {/* Right — readout */}
                <div className="flex-1 flex flex-col justify-center gap-6 py-10 px-8">
                  <ReadoutRow
                    label="ETA"
                    value={`${etaLeft}s`}
                    large
                  />
                  <ReadoutRow
                    label="Drone ID"
                    value={displayed.drone_id ?? 'dispatching\u2026'}
                    highlight
                  />
                  <ReadoutRow
                    label="Reason"
                    value={displayed.reason}
                  />
                  <ReadoutRow
                    label="Predicted ETA"
                    value={`${displayed.predicted_eta_seconds}s`}
                  />
                </div>
              </div>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
