'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Activity, Cloud, Workflow } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { HOSPITAL_PAIR, SCENARIOS, type ScenarioKey } from '../../lib/scenarios';

const ICONS: Record<ScenarioKey, React.ReactNode> = {
  's1-normal': <Activity className="h-5 w-5 text-green-400" />,
  's2-congestion': <Workflow className="h-5 w-5 text-yellow-400" />,
  's3-drone-handoff': <Cloud className="h-5 w-5 text-red-400" />,
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function ScenarioPickerDialog({ open, onOpenChange }: Props) {
  const router = useRouter();
  const [busyKey, setBusyKey] = useState<ScenarioKey | null>(null);

  async function run(key: ScenarioKey) {
    setBusyKey(key);
    try {
      const res = await fetch('/api/scenarios/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: key }),
      });
      const data = (await res.json()) as { trip_id?: string; error?: string };
      if (!res.ok || !data.trip_id) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      toast.success(`${key} started — replaying ${data.trip_id.slice(0, 8)}…`);
      onOpenChange(false);
      router.push(`/dashboard?tripId=${data.trip_id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start scenario');
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Run a Scenario</DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {HOSPITAL_PAIR.origin} → {HOSPITAL_PAIR.destination}
            {' · '}~{HOSPITAL_PAIR.distanceKm} km on {HOSPITAL_PAIR.route}.
            Only the ambulance pings are replayed from a dataset — corridor, AI, drone,
            and bounty are computed live by the Sipra backend.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 pt-2">
          {SCENARIOS.map(s => (
            <div
              key={s.key}
              className="flex items-start gap-3 rounded-lg border border-border bg-card/50 p-3"
            >
              <div className="mt-0.5">{ICONS[s.key]}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-foreground">{s.title}</h3>
                  <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wide">
                    {s.goldenHourMin}-min golden hour
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{s.tagline}</p>
                <p className="text-xs text-foreground/70 mt-1">{s.outcome}</p>
              </div>
              <Button
                size="sm"
                disabled={busyKey !== null}
                onClick={() => run(s.key)}
                className="shrink-0"
              >
                {busyKey === s.key ? 'Starting…' : 'Run'}
              </Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
