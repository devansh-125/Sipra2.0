'use client';

import { useState } from 'react';
import { Signal, Wifi, BatteryFull } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function DriverPovSimulator() {
  const [isTriggered, setIsTriggered] = useState(false);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-8 p-8 min-h-screen bg-slate-950 items-center">
      {/* Left: Phone Bezel */}
      <div className="flex items-center justify-center">
        <div className="relative mx-auto w-[320px] h-[640px] rounded-[48px] border-[14px] border-slate-800 bg-black shadow-[0_0_60px_-10px_rgba(0,0,0,0.9)] overflow-hidden">
          {/* Notch */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-6 bg-slate-800 rounded-b-2xl z-10" />

          {/* Screen */}
          <div className="absolute inset-0 bg-slate-100 flex flex-col">
            {/* Status bar */}
            <div className="h-8 bg-slate-100 flex items-center justify-between px-5 pt-1 flex-shrink-0">
              <span className="text-xs font-semibold text-slate-800">10:47</span>
              <div className="flex items-center gap-1 text-slate-700">
                <Signal className="w-3 h-3" />
                <Wifi className="w-3 h-3" />
                <BatteryFull className="w-3 h-3" />
              </div>
            </div>

            {/* Blue nav banner */}
            <div className="bg-blue-600 text-white text-sm font-medium px-4 py-2 flex-shrink-0">
              Navigating to drop-off
            </div>

            {/* Map panel */}
            <div className="flex-1 relative overflow-hidden">
              <svg viewBox="0 0 320 380" className="w-full h-full" preserveAspectRatio="xMidYMid slice">
                {/* Road background */}
                <rect width="320" height="380" fill="#e2e8f0" />
                {/* Street grid */}
                <line x1="80" y1="0" x2="80" y2="380" stroke="#cbd5e1" strokeWidth="10" />
                <line x1="200" y1="0" x2="200" y2="380" stroke="#cbd5e1" strokeWidth="10" />
                <line x1="0" y1="110" x2="320" y2="110" stroke="#cbd5e1" strokeWidth="10" />
                <line x1="0" y1="260" x2="320" y2="260" stroke="#cbd5e1" strokeWidth="10" />
                {/* Gentle curved blue route */}
                <path
                  d="M 155 355 C 170 290, 210 230, 195 170 C 178 110, 115 95, 138 32"
                  stroke="#3b82f6"
                  strokeWidth="6"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {/* Origin dot */}
                <circle cx="155" cy="355" r="9" fill="#2563eb" />
                <circle cx="155" cy="355" r="5" fill="white" />
                {/* Destination marker */}
                <circle cx="138" cy="32" r="9" fill="#1d4ed8" />
                <circle cx="138" cy="32" r="5" fill="white" />
              </svg>
            </div>

            {/* Bottom card */}
            <div className="h-40 bg-white border-t border-slate-200 p-4 flex gap-3 flex-shrink-0">
              {/* Driver avatar */}
              <div className="w-10 h-10 rounded-full bg-slate-300 flex-shrink-0 flex items-center justify-center text-slate-600 text-sm font-bold">
                R
              </div>
              {/* Info + button */}
              <div className="flex flex-col flex-1 gap-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-slate-900">8 min</span>
                  <span className="text-xs text-slate-400">away</span>
                </div>
                <span className="text-sm text-slate-500">101 MG Road</span>
                <button className="mt-auto w-full bg-green-500 hover:bg-green-400 active:bg-green-600 text-white text-sm font-semibold rounded-lg py-2 transition-colors">
                  Start Navigation
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right: Control column */}
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Sipra Webhook Impact Demo</h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-400">
            Sipra broadcasts a rolling 2 km exclusion corridor around the ambulance to every partner
            fleet in real time. When a critical medical shipment is in transit, delivery drivers inside
            the corridor receive an immediate reroute webhook — protecting the ambulance&apos;s
            golden-hour deadline without any manual intervention.
          </p>
          <p className="mt-2 text-sm text-slate-500">
            Click the button below to simulate the webhook fan-out and watch what the driver sees.
          </p>
        </div>

        <Button
          onClick={() => setIsTriggered((prev) => !prev)}
          className="w-full bg-red-600 hover:bg-red-500 shadow-[0_0_30px_-5px_rgba(239,68,68,0.8)] py-6 text-base uppercase tracking-wide font-semibold"
        >
          {isTriggered ? 'Reset to peaceful' : 'Trigger Sipra Webhook'}
        </Button>

        {/* Event log placeholder — filled in Session 6 */}
        <ul className="flex flex-col gap-1 text-sm text-slate-400 font-mono max-h-48 overflow-y-auto" />
      </div>
    </div>
  );
}
