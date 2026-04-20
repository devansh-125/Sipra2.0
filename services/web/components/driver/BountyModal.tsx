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

export function BountyModal({ lifecycle, wallet, tripId }: BountyModalProps) {
  const { state, bounty, distanceToCheckpointM, accept, dismiss, retry } = lifecycle;

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

  const progressPercent =
    claimedVisible && initialDistRef.current !== null && distanceToCheckpointM !== null
      ? Math.max(
          0,
          Math.min(
            100,
            ((initialDistRef.current - distanceToCheckpointM) / initialDistRef.current) * 100,
          ),
        )
      : 0;

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
              Earn 50 Google Points
            </DialogTitle>
            <DialogDescription className="text-base text-foreground mt-1">
              Detour to the checkpoint
              {distanceToCheckpointM !== null
                ? ` (${Math.round(distanceToCheckpointM)}m away)`
                : ''}
              . Help clear the ambulance corridor and earn rewards.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 flex gap-2">
            <Button variant="outline" onClick={dismiss} className="flex-1">
              Dismiss
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

      {/* CLAIMED — non-intrusive fixed top progress strip */}
      {claimedVisible && (
        <div className="fixed top-0 left-0 right-0 z-40 bg-yellow-950/95 border-b border-yellow-700/50 px-4 py-2 backdrop-blur-sm">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium text-yellow-300">
              En route —{' '}
              {distanceToCheckpointM !== null
                ? `${Math.round(distanceToCheckpointM)}m to go`
                : 'calculating…'}
            </span>
            <button
              onClick={() => setClaimedVisible(false)}
              className="text-yellow-600 hover:text-yellow-400 text-xs px-1"
              aria-label="Dismiss progress strip"
            >
              ✕
            </button>
          </div>
          <div className="w-full bg-yellow-900/50 rounded-full h-1.5">
            <div
              className="bg-yellow-400 h-1.5 rounded-full transition-all duration-500"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      )}

      {/* VERIFIED — full-screen success overlay */}
      {verifiedVisible && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/92 text-center px-6">
          <div className="text-7xl mb-6 animate-bounce">⭐</div>
          <div className="text-4xl font-black text-yellow-400 tracking-tight mb-3">
            +50 GOOGLE POINTS
          </div>
          <p className="text-muted-foreground text-sm max-w-xs">
            Checkpoint reached. Thank you for clearing the ambulance corridor.
          </p>
          <p className="text-yellow-700 text-xs mt-6">Dismissing in 4 seconds…</p>
        </div>
      )}
    </>
  );
}
