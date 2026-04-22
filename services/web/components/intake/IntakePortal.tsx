'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, Loader2, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { createTrip } from '@/lib/api';
import { HOSPITALS } from './hospitals';

const CARGO_OPTIONS = ['Liver', 'Heart', 'Volatile Vaccine', 'Blood Platelets'] as const;
type CargoOption = (typeof CARGO_OPTIONS)[number];

// Maps display labels to domain CargoCategory enum values accepted by the Go backend.
const CARGO_TO_CATEGORY: Record<CargoOption, string> = {
  'Liver':            'Organ',
  'Heart':            'Organ',
  'Volatile Vaccine': 'Vaccine',
  'Blood Platelets':  'Blood',
};

function defaultDeadline(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  // datetime-local needs "YYYY-MM-DDTHH:MM"
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const FIELD_CLASS =
  'bg-slate-950 border border-slate-800 focus:border-red-500 focus:ring-1 focus:ring-red-500/40 rounded-md px-3 py-2 text-sm text-slate-100 w-full outline-none';

export default function IntakePortal() {
  const router = useRouter();

  const [sourceId, setSourceId]     = useState(HOSPITALS[0].id);
  const [destId, setDestId]         = useState(HOSPITALS[1].id);
  const [cargo, setCargo]           = useState<CargoOption>('Liver');
  const [deadline, setDeadline]     = useState(defaultDeadline);
  const [submitting, setSubmitting] = useState(false);
  const [sameError, setSameError]   = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (sourceId === destId) {
      setSameError(true);
      return;
    }
    setSameError(false);

    const src  = HOSPITALS.find((h) => h.id === sourceId)!;
    const dest = HOSPITALS.find((h) => h.id === destId)!;

    setSubmitting(true);
    try {
      const res = await createTrip({
        origin:               { lat: src.lat,  lng: src.lng  },
        destination:          { lat: dest.lat, lng: dest.lng },
        cargo_category:       CARGO_TO_CATEGORY[cargo],
        cargo_description:    cargo,
        golden_hour_deadline: new Date(deadline).toISOString(),
        ambulance_id:         'AMB-001',
      });
      router.push(`/dashboard?tripId=${res.trip_id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create trip');
      setSubmitting(false);
    }
  }

  function handleDemoLaunch() {
    router.push('/demo/corridor-sim');
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
      <section className="max-w-2xl w-full rounded-2xl border border-slate-800 bg-slate-900/60 backdrop-blur-sm shadow-[0_0_40px_-10px_rgba(239,68,68,0.25)] p-8">

        {/* Auth header */}
        <div className="flex items-center gap-2 mb-6">
          <ShieldCheck className="text-red-500 w-4 h-4 shrink-0" />
          <span className="text-xs uppercase tracking-[0.2em] text-slate-400">
            Authenticated as Dr. Smith · City Hospital
          </span>
        </div>

        <h1 className="text-2xl font-semibold tracking-tight">Hospital Intake Portal</h1>
        <p className="mt-1 text-sm text-slate-400">Authorize a critical corridor for medical transit.</p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">

          {/* Source */}
          <div className="flex flex-col gap-1">
            <label className="text-xs uppercase tracking-widest text-slate-400">Source Hospital</label>
            <select
              className={FIELD_CLASS}
              value={sourceId}
              onChange={(e) => { setSourceId(e.target.value); setSameError(false); }}
            >
              {HOSPITALS.map((h) => (
                <option key={h.id} value={h.id}>{h.name}</option>
              ))}
            </select>
          </div>

          {/* Destination */}
          <div className="flex flex-col gap-1">
            <label className="text-xs uppercase tracking-widest text-slate-400">Destination Hospital</label>
            <select
              className={FIELD_CLASS}
              value={destId}
              onChange={(e) => { setDestId(e.target.value); setSameError(false); }}
            >
              {HOSPITALS.map((h) => (
                <option key={h.id} value={h.id}>{h.name}</option>
              ))}
            </select>
            {sameError && (
              <p className="text-xs text-red-400 mt-0.5">Source and destination must be different.</p>
            )}
          </div>

          {/* Cargo */}
          <div className="flex flex-col gap-1">
            <label className="text-xs uppercase tracking-widest text-slate-400">Cargo Type</label>
            <select
              className={FIELD_CLASS}
              value={cargo}
              onChange={(e) => setCargo(e.target.value as CargoOption)}
            >
              {CARGO_OPTIONS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          {/* Deadline */}
          <div className="flex flex-col gap-1">
            <label className="text-xs uppercase tracking-widest text-slate-400">Golden-Hour Deadline</label>
            <input
              type="datetime-local"
              className={FIELD_CLASS}
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              required
            />
          </div>

          <Button
            type="submit"
            disabled={submitting}
            className="w-full bg-red-600 hover:bg-red-500 shadow-[0_0_30px_-5px_rgba(239,68,68,0.8)] uppercase tracking-[0.3em] font-semibold py-6 mt-4"
          >
            {submitting ? (
              <>
                <Loader2 className="animate-spin" />
                Initiating…
              </>
            ) : (
              'Initiate Critical Corridor'
            )}
          </Button>

          <Button
            type="button"
            onClick={handleDemoLaunch}
            className="w-full bg-transparent border border-blue-500/50 hover:border-blue-400 hover:bg-blue-500/10 text-blue-400 hover:text-blue-300 shadow-[0_0_20px_-8px_rgba(59,130,246,0.5)] hover:shadow-[0_0_25px_-5px_rgba(59,130,246,0.6)] uppercase tracking-[0.2em] font-semibold py-6 transition-all duration-200"
          >
            <Zap className="w-4 h-4 mr-2" />
            Launch Hackathon Demo (Simulation)
          </Button>

        </form>
      </section>
    </main>
  );
}
