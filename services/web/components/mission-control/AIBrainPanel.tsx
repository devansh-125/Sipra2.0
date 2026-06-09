'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { useMission } from '../../lib/MissionContext';
import { useSipraWebSocket } from '../../hooks/useSipraWebSocket';
import type { RiskPredictionPayload } from '../../lib/types';

const WEATHER_ICONS: Record<string, string> = {
  clear: '☀️',
  light_rain: '🌦️',
  heavy_rain: '🌧️',
  fog: '🌫️',
  storm: '⛈️',
  snow: '❄️',
};

const RECOMMENDATION_LABEL: Record<string, string> = {
  CONTINUE: 'CONTINUE',
  REQUEST_BOUNTY_BOOST: 'BOUNTY BOOST',
  DISPATCH_DRONE: 'DISPATCH DRONE',
};

const RECOMMENDATION_CLASS: Record<string, string> = {
  CONTINUE: 'bg-green-600 text-white',
  REQUEST_BOUNTY_BOOST: 'bg-amber-600 text-white',
  DISPATCH_DRONE: 'bg-red-600 text-white',
};

function formatETA(seconds: number): string {
  if (seconds <= 0) return '–';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function breachColor(p: number): string {
  if (p >= 0.8) return 'text-red-500';
  if (p >= 0.6) return 'text-orange-500';
  if (p >= 0.4) return 'text-yellow-500';
  return 'text-green-500';
}

function PredictionView({ pred, deadlineSeconds }: { pred: RiskPredictionPayload; deadlineSeconds: number }) {
  // Hide the alarming breach % while the AI is still in its warm-up window
  // (ai_confidence < 0.4). Under-sampled early pings can produce 100% breach
  // numbers that the decision engine already ignores — the dashboard should
  // ignore them too. Once enough pings arrive, the bar reveals itself.
  const isWarmingUp = pred.ai_confidence < 0.4;

  return (
    <>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Breach Risk</span>
          {isWarmingUp ? (
            <Badge className="bg-slate-700 text-slate-200 border-slate-500/50 text-xs animate-pulse">
              WARMING UP
            </Badge>
          ) : (
            <Badge className={`${breachColor(pred.breach_probability)} bg-transparent border-current text-xs`}>
              {(pred.breach_probability * 100).toFixed(0)}%
            </Badge>
          )}
        </div>
        <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-1000 ${
              isWarmingUp ? 'bg-slate-500' :
              pred.breach_probability >= 0.8 ? 'bg-red-500' :
              pred.breach_probability >= 0.6 ? 'bg-orange-500' :
              pred.breach_probability >= 0.4 ? 'bg-yellow-500' : 'bg-green-500'
            }`}
            style={{ width: isWarmingUp ? '20%' : `${pred.breach_probability * 100}%` }}
          />
        </div>
        {isWarmingUp && (
          <p className="text-[10px] text-muted-foreground italic leading-snug">
            Few pings observed so far — the AI is gathering speed samples before
            committing to a breach estimate.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Predicted ETA</span>
        <span className="text-sm font-mono text-foreground">
          {isWarmingUp ? '—' : formatETA(pred.predicted_eta_seconds)}
        </span>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Deadline</span>
        <span className={`text-sm font-mono ${pred.will_breach ? 'text-red-400' : 'text-green-400'}`}>
          {formatETA(deadlineSeconds)}
        </span>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Weather</span>
        <div className="flex items-center gap-1.5">
          <span>{WEATHER_ICONS[pred.weather_condition] ?? '🌤️'}</span>
          <span className="text-xs">{pred.weather_condition.replace('_', ' ')}</span>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Recommendation</span>
        <Badge className={`${RECOMMENDATION_CLASS[pred.recommendation] ?? 'bg-muted text-foreground'} text-xs`}>
          {RECOMMENDATION_LABEL[pred.recommendation] ?? pred.recommendation}
        </Badge>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Effective Speed</span>
        <span className="text-sm font-mono text-foreground">{pred.effective_speed_kph.toFixed(1)} kph</span>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Fleet Density (2 km)</span>
        <span className="text-sm font-mono text-foreground">
          {pred.fleet_density_in_corridor} <span className="text-[10px] text-muted-foreground">×{pred.fleet_penalty.toFixed(2)}</span>
        </span>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">AI Confidence</span>
          <span className={`text-sm font-mono ${
            pred.ai_confidence >= 0.8 ? 'text-green-400' :
            pred.ai_confidence >= 0.6 ? 'text-yellow-400' : 'text-red-400'
          }`}>{(pred.ai_confidence * 100).toFixed(0)}%</span>
        </div>
        <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-1000 ${
              pred.ai_confidence >= 0.8 ? 'bg-green-500' :
              pred.ai_confidence >= 0.6 ? 'bg-yellow-500' : 'bg-red-500'
            }`}
            style={{ width: `${pred.ai_confidence * 100}%` }}
          />
        </div>
      </div>

      <div className="space-y-1">
        <span className="text-xs text-muted-foreground">Reasoning</span>
        <div className="text-xs text-foreground bg-muted/30 rounded p-2 max-h-24 overflow-y-auto leading-relaxed">
          {pred.reasoning}
        </div>
      </div>
    </>
  );
}

export default function AIBrainPanel() {
  const { trip, remainingMs } = useMission();
  const { riskPrediction, handoffState, handoffStartedAt, status } = useSipraWebSocket(undefined, trip?.id ?? null);
  const [predAtMs, setPredAtMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!riskPrediction) return;
    setPredAtMs(Date.now());
  }, [riskPrediction]);

  // Drone-mode triggers, scoped to the *current* trip. Filtering by trip_id
  // is what prevents a previous run's handoff from leaking into the next
  // scenario (e.g. s3 → s1 would otherwise keep showing "DRONE HANDOFF ACTIVE").
  const handoffForCurrentTrip =
    handoffState !== null && handoffState.trip_id === trip?.id
      ? handoffState
      : null;
  const aiRecommendsDrone =
    riskPrediction?.trip_id === trip?.id &&
    riskPrediction?.recommendation === 'DISPATCH_DRONE';
  const handoffActive =
    handoffForCurrentTrip !== null ||
    trip?.status === 'DroneHandoff' ||
    aiRecommendsDrone;

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  // Drone-flight countdown derived directly from the WS payload — no local
  // state copy, so it can never get stuck at a stale fallback. If the handoff
  // data hasn't arrived yet (page reload before WS replay), we surface "0s"
  // rather than fabricating a 90 s flight.
  const droneEtaTotal = handoffForCurrentTrip?.eta_seconds ?? 0;
  const droneEtaLeft = useMemo(() => {
    if (handoffStartedAt === null || droneEtaTotal === 0) return droneEtaTotal;
    const elapsed = Math.floor((nowMs - handoffStartedAt) / 1_000);
    return Math.max(0, droneEtaTotal - elapsed);
  }, [handoffStartedAt, droneEtaTotal, nowMs]);

  const deadlineSeconds = useMemo(() => {
    if (!riskPrediction) return 0;
    if (remainingMs > 0) return Math.round(remainingMs / 1000);
    if (!predAtMs) return riskPrediction.deadline_seconds_remaining;
    const elapsed = Math.floor((nowMs - predAtMs) / 1000);
    return Math.max(0, riskPrediction.deadline_seconds_remaining - elapsed);
  }, [riskPrediction, remainingMs, predAtMs, nowMs]);

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-mono text-muted-foreground uppercase tracking-widest flex items-center justify-between">
          <span>AI Brain</span>
          <div className="flex items-center space-x-1">
            <div className={`w-2 h-2 rounded-full ${
              status === 'connected'   ? 'bg-green-400' :
              status === 'connecting'  ? 'bg-yellow-400 animate-pulse' : 'bg-red-400'
            }`} />
            <span className="text-[10px]">
              {status === 'connected' ? 'Live' : status === 'connecting' ? 'Connecting' : 'Offline'}
            </span>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!trip ? (
          <div className="text-center text-muted-foreground text-sm py-4">
            No active trip
          </div>
        ) : handoffActive ? (
          <div className="space-y-3">
            <Badge className="bg-purple-700 text-white w-full justify-center py-1 text-xs">
              🚁 DRONE HANDOFF ACTIVE
            </Badge>
            <div className="space-y-1">
              <div className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest">
                Drone ETA
              </div>
              <div className="font-mono text-3xl font-bold tabular-nums text-violet-300">
                {formatETA(droneEtaLeft)}
              </div>
            </div>
            {handoffForCurrentTrip?.drone_id && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Drone</span>
                <span className="text-sm font-mono text-foreground">{handoffForCurrentTrip.drone_id}</span>
              </div>
            )}
            <div className="text-xs bg-muted/30 rounded p-2 text-foreground">
              {handoffForCurrentTrip?.reason ?? 'Drone delivery in progress — ambulance route abandoned.'}
            </div>
          </div>
        ) : riskPrediction ? (
          <PredictionView
            pred={riskPrediction}
            deadlineSeconds={deadlineSeconds || riskPrediction.deadline_seconds_remaining}
          />
        ) : (
          <div className="text-center py-6 space-y-1">
            <div className="text-xs text-muted-foreground animate-pulse">Awaiting AI signal…</div>
            <div className="text-[10px] text-muted-foreground opacity-60">
              Risk Monitor polls every 10s
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
