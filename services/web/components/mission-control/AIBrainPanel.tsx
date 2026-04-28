'use client';

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

function PredictionView({ pred }: { pred: RiskPredictionPayload }) {
  return (
    <>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Breach Risk</span>
          <Badge className={`${breachColor(pred.breach_probability)} bg-transparent border-current text-xs`}>
            {(pred.breach_probability * 100).toFixed(0)}%
          </Badge>
        </div>
        <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-1000 ${
              pred.breach_probability >= 0.8 ? 'bg-red-500' :
              pred.breach_probability >= 0.6 ? 'bg-orange-500' :
              pred.breach_probability >= 0.4 ? 'bg-yellow-500' : 'bg-green-500'
            }`}
            style={{ width: `${pred.breach_probability * 100}%` }}
          />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Predicted ETA</span>
        <span className="text-sm font-mono text-foreground">{formatETA(pred.predicted_eta_seconds)}</span>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Deadline</span>
        <span className={`text-sm font-mono ${pred.will_breach ? 'text-red-400' : 'text-green-400'}`}>
          {formatETA(pred.deadline_seconds_remaining)}
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
        <span className="text-xs text-muted-foreground">Status</span>
        <Badge className={`${pred.will_breach ? 'bg-red-600 text-white' : 'bg-green-600 text-white'} text-xs`}>
          {pred.will_breach ? 'BREACH RISK' : 'ON TRACK'}
        </Badge>
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
        <span className="text-xs text-muted-foreground">AI Analysis</span>
        <div className="text-xs text-foreground bg-muted/30 rounded p-2 max-h-16 overflow-y-auto">
          {pred.ai_reasoning}
        </div>
      </div>

      {(pred.risk_factors ?? []).length > 0 && (
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">Risk Factors</span>
          <div className="flex flex-wrap gap-1">
            {(pred.risk_factors ?? []).map((f, i) => (
              <Badge key={i} variant="outline" className="text-[10px] px-1 py-0">{f}</Badge>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export default function AIBrainPanel() {
  const { trip } = useMission();
  const { riskPrediction, handoffState, status } = useSipraWebSocket();

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
        ) : handoffState ? (
          <div className="space-y-3">
            <Badge className="bg-purple-700 text-white w-full justify-center py-1 text-xs">
              🚁 DRONE HANDOFF ACTIVE
            </Badge>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Predicted ETA</span>
              <span className="text-sm font-mono text-red-400">
                {formatETA(handoffState.predicted_eta_seconds)}
              </span>
            </div>
            {handoffState.drone_id && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Drone</span>
                <span className="text-sm font-mono text-foreground">{handoffState.drone_id}</span>
              </div>
            )}
            <div className="text-xs bg-muted/30 rounded p-2 text-foreground">
              {handoffState.reason}
            </div>
          </div>
        ) : riskPrediction ? (
          <PredictionView pred={riskPrediction} />
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
