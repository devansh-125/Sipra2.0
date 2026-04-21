'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import confetti from 'canvas-confetti';

import type { BountyLifecycleResult } from '../../hooks/useBountyLifecycle';
import type { PointsWallet } from '../../hooks/usePointsWallet';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';

interface BountyModalProps {
  lifecycle: BountyLifecycleResult;
  wallet: PointsWallet;
  tripId: string;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return '0:00';
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function BountyModal({ lifecycle, wallet, tripId }: BountyModalProps) {
  const { state, bounty, distanceToCheckpointM, timeRemainingMs, totalTimeMs, accept, dismiss, retry } = lifecycle;

  // Capture initial distance when CLAIMED starts — used for progress bar denominator.
  const initialDistRef = useRef<number | null>(null);

  useEffect(() => {
    if (state === 'CLAIMED' && initialDistRef.current === null && distanceToCheckpointM !== null) {
      initialDistRef.current = distanceToCheckpointM;
    }
    if (state !== 'CLAIMED' && state !== 'VERIFIED') {
      initialDistRef.current = null;
    }
  }, [state, distanceToCheckpointM]);

  // CLAIMED strip — locally dismissible without touching lifecycle.
  const [claimedVisible, setClaimedVisible] = useState(false);
  useEffect(() => {
    if (state === 'CLAIMED') setClaimedVisible(true);
    if (state !== 'CLAIMED') setClaimedVisible(false);
  }, [state]);

  const distProgress =
    claimedVisible && initialDistRef.current !== null && distanceToCheckpointM !== null
      ? Math.max(
          0,
          Math.min(
            100,
            ((initialDistRef.current - distanceToCheckpointM) / initialDistRef.current) * 100,
          ),
        )
      : 0;

  const timeProgress = totalTimeMs > 0 ? Math.max(0, (timeRemainingMs / totalTimeMs) * 100) : 0;

  // VERIFIED: confetti once, add points, fire custom event, auto-dismiss after 4s.
  const [verifiedVisible, setVerifiedVisible] = useState(false);
  const verifiedHandledRef = useRef(false);

  useEffect(() => {
    if (state === 'IDLE') verifiedHandledRef.current = false;
  }, [state]);

  useEffect(() => {
    if (state !== 'VERIFIED' || verifiedHandledRef.current) return;
    verifiedHandledRef.current = true;
    setVerifiedVisible(true);

    confetti({ particleCount: 160, spread: 90, origin: { y: 0.55 } });

    wallet.add(50);

    window.dispatchEvent(
      new CustomEvent('bounty:verified', {
        detail: { tripId, bountyId: bounty?.id },
      }),
    );

    const timer = setTimeout(() => setVerifiedVisible(false), 4000);
    return () => clearTimeout(timer);
  }, [state, bounty?.id, wallet, tripId]);

  // EXPIRED: show failure overlay, auto-dismiss after 4s.
  const [expiredVisible, setExpiredVisible] = useState(false);
  const expiredHandledRef = useRef(false);

  useEffect(() => {
    if (state === 'IDLE') expiredHandledRef.current = false;
  }, [state]);

  useEffect(() => {
    if (state !== 'EXPIRED' || expiredHandledRef.current) return;
    expiredHandledRef.current = true;
    setExpiredVisible(true);

    const timer = setTimeout(() => setExpiredVisible(false), 4000);
    return () => clearTimeout(timer);
  }, [state]);

  // ERROR: sonner toast with retry action.
  const errorHandledRef = useRef(false);
  useEffect(() => {
    if (state !== 'ERROR' || errorHandledRef.current) return;
    errorHandledRef.current = true;
    toast.error('Bounty operation failed', {
      description: 'Could not complete the bounty step.',
      action: { label: 'Retry', onClick: retry },
    });
  }, [state, retry]);

  useEffect(() => {
    if (state !== 'ERROR') errorHandledRef.current = false;
  }, [state]);

  return (
    <>
      {/* OFFERED — blocking dialog requiring driver action */}
      <Dialog open={state === 'OFFERED'} onOpenChange={open => { if (!open) dismiss(); }}>
        <DialogContent className="max-w-[340px] rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-yellow-400 text-xl">
              Reroute and earn reward?
            </DialogTitle>
            <DialogDescription className="text-base text-foreground mt-1">
              Detour to the checkpoint
              {distanceToCheckpointM !== null
                ? ` (${Math.round(distanceToCheckpointM)}m away)`
                : ''}
              . Help clear the ambulance corridor and earn +50 points.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 flex gap-2">
            <Button variant="outline" onClick={dismiss} className="flex-1">
              Ignore
            </Button>
            <Button
              onClick={accept}
              className="flex-1 bg-yellow-500 hover:bg-yellow-400 text-black font-semibold"
            >
              Accept
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* CLAIMED — non-intrusive fixed top progress strip with countdown */}
      {claimedVisible && (
        <div className="fixed top-0 left-0 right-0 z-40 bg-yellow-950/95 border-b border-yellow-700/50 px-4 py-2 backdrop-blur-sm">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30 animate-pulse">
                ● Rerouting
              </span>
              <span className="text-xs font-medium text-yellow-300">
                {distanceToCheckpointM !== null
                  ? `${Math.round(distanceToCheckpointM)}m to go`
                  : 'calculating…'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-yellow-400 tabular-nums">
                ⏱ {formatCountdown(timeRemainingMs)}
              </span>
              <button
                onClick={() => setClaimedVisible(false)}
                className="text-yellow-600 hover:text-yellow-400 text-xs px-1"
                aria-label="Dismiss progress strip"
              >
                ✕
              </button>
            </div>
          </div>
          {/* Distance progress bar */}
          <div className="w-full bg-yellow-900/50 rounded-full h-1.5 mb-1">
            <div
              className="bg-yellow-400 h-1.5 rounded-full transition-all duration-500"
              style={{ width: `${distProgress}%` }}
            />
          </div>
          {/* Time remaining bar */}
          <div className="w-full bg-yellow-900/30 rounded-full h-1">
            <div
              className={`h-1 rounded-full transition-all duration-500 ${timeProgress < 20 ? 'bg-red-500' : 'bg-yellow-600/60'}`}
              style={{ width: `${timeProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* VERIFIED — full-screen success overlay */}
      {verifiedVisible && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/92 text-center px-6">
          <div className="text-7xl mb-6 animate-bounce">⭐</div>
          <div className="text-4xl font-black text-yellow-400 tracking-tight mb-3">
            +50 POINTS
          </div>
          <p className="text-lg font-semibold text-green-400 mb-2">
            You earned +50 points for clearing the emergency corridor
          </p>
          <p className="text-muted-foreground text-sm max-w-xs">
            Checkpoint reached. Thank you for helping save lives.
          </p>
          <p className="text-yellow-700 text-xs mt-6">Dismissing in 4 seconds…</p>
        </div>
      )}

      {/* EXPIRED — full-screen failure overlay */}
      {expiredVisible && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/92 text-center px-6">
          <div className="text-7xl mb-6">⏱</div>
          <div className="text-3xl font-black text-red-400 tracking-tight mb-3">
            REROUTE FAILED
          </div>
          <p className="text-lg font-semibold text-red-300 mb-2">
            Time&apos;s up — no reward earned
          </p>
          <p className="text-muted-foreground text-sm max-w-xs">
            You didn&apos;t reach the checkpoint in time. The reroute window has expired.
          </p>
          <p className="text-red-700 text-xs mt-6">Dismissing in 4 seconds…</p>
        </div>
      )}
    </>
  );
}
