'use client';

/**
 * MissionStatusSidebar
 *
 * Left column of the three-panel Mission Control demo layout.
 * Shows golden hour countdown, active mission details, sim controls,
 * and live statistics — all driven by the shared CorridorSimState.
 */

import { useEffect, useState } from 'react';
import type { CorridorSimState } from '../../hooks/useCorridorSimulation';

// ---------------------------------------------------------------------------
// Golden hour helpers
// ---------------------------------------------------------------------------
const GOLDEN_HOUR_MS = 60 * 60 * 1000; // 60 minutes

function formatCountdown(ms: number): string {
  if (ms <= 0) return '00:00:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

type UrgencyLevel = 'normal' | 'elevated' | 'critical';

function getUrgency(progress: number): UrgencyLevel {
  if (progress > 0.8) return 'critical';
  if (progress > 0.5) return 'elevated';
  return 'normal';
}

const URGENCY_COLORS: Record<UrgencyLevel, { bar: string; badge: string; badgeBg: string }> = {
  normal: { bar: '#22c55e', badge: '#22c55e', badgeBg: 'rgba(34,197,94,0.15)' },
  elevated: { bar: '#f59e0b', badge: '#f59e0b', badgeBg: 'rgba(245,158,11,0.15)' },
  critical: { bar: '#ef4444', badge: '#ef4444', badgeBg: 'rgba(239,68,68,0.15)' },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface MissionStatusSidebarProps {
  sim: CorridorSimState;
  speed: number;
  onSpeedChange: (s: number) => void;
  /** Called when the user clicks "View Reward Summary". */
  onViewRewards?: () => void;
}

export default function MissionStatusSidebar({
  sim,
  speed,
  onSpeedChange,
  onViewRewards,
}: MissionStatusSidebarProps) {
  const [tick, setTick] = useState(0);

  // Re-render every second for countdown
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const remainingMs = Math.max(0, GOLDEN_HOUR_MS * (1 - sim.progress));
  const elapsedMs = GOLDEN_HOUR_MS * sim.progress;
  const urgency = getUrgency(sim.progress);
  const uc = URGENCY_COLORS[urgency];
  const etaMin = Math.round((sim.etaSeconds * (1 - sim.progress)) / 60);
  const distKm = (sim.distanceMeters / 1000).toFixed(1);

  /** Button is enabled when trip finishes (progress=1) or golden hour expires. */
  const tripDone = sim.progress >= 1 || remainingMs <= 0;

  // tick is used only to force a re-render each second for the countdown
  void tick;

  return (
    <div
      style={{
        height: '100%',
        background: '#0c0c1a',
        borderRight: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontFamily: "'Inter', -apple-system, sans-serif",
        color: '#fff',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '16px 16px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          flexShrink: 0,
        }}
      >
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase' }}>
          SIPRA
        </div>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.5, marginTop: 2 }}>
          Mission Control
        </div>
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ── Golden Hour ──────────────────────────── */}
        <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 12, padding: '14px 14px', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase' }}>
              Golden Hour
            </span>
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: 6,
                background: uc.badgeBg,
                color: uc.badge,
                textTransform: 'uppercase',
                letterSpacing: 1,
                animation: urgency === 'critical' ? 'pulse 2s infinite' : undefined,
              }}
            >
              {urgency}
            </span>
          </div>

          <div style={{ fontSize: 28, fontWeight: 700, fontVariantNumeric: 'tabular-nums', fontFamily: "'Inter', monospace", color: urgency === 'critical' ? '#ef4444' : '#fff', marginBottom: 8 }}>
            {formatCountdown(remainingMs)}
          </div>

          {/* Progress bar */}
          <div style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 4, height: 6, overflow: 'hidden', marginBottom: 6 }}>
            <div
              style={{
                height: '100%',
                width: `${Math.round(sim.progress * 100)}%`,
                background: uc.bar,
                borderRadius: 4,
                transition: 'width 0.5s ease',
              }}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
            <span>Elapsed: {formatCountdown(elapsedMs)}</span>
            <span>{Math.round(sim.progress * 100)}%</span>
          </div>
        </div>

        {/* ── Active Mission ──────────────────────── */}
        <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 12, padding: '14px 14px', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', marginBottom: 10 }}>
            Active Mission
          </div>

          {/* Cargo badge */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 6, background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>
              Organ
            </span>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)' }}>
              Live donor kidney
            </span>
          </div>

          {/* Route */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span style={{ fontSize: 13, color: '#22c55e' }}>✚</span>
            <span style={{ fontSize: 11, fontWeight: 600 }}>KGMU Hospital</span>
          </div>
          <div style={{ color: 'rgba(255,255,255,0.2)', fontSize: 9, paddingLeft: 19, marginBottom: 2 }}>↓</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <span style={{ fontSize: 13, color: '#ef4444' }}>✚</span>
            <span style={{ fontSize: 11, fontWeight: 600 }}>SGPGIMS Hospital</span>
          </div>

          {/* Stats row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', fontWeight: 600, textTransform: 'uppercase', marginBottom: 2 }}>
                ETA
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                {etaMin}m
              </div>
            </div>
            <div>
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', fontWeight: 600, textTransform: 'uppercase', marginBottom: 2 }}>
                Distance
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                {distKm}km
              </div>
            </div>
          </div>
        </div>

        {/* ── Fleet Status ─────────────────────────── */}
        <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 12, padding: '14px 14px', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', marginBottom: 10 }}>
            Fleet Status
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#ff5028', fontVariantNumeric: 'tabular-nums' }}>
                {sim.driversInZone}
              </div>
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', fontWeight: 600, textTransform: 'uppercase' }}>
                In Zone
              </div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#ffc800', fontVariantNumeric: 'tabular-nums' }}>
                {sim.driversAlerted}
              </div>
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', fontWeight: 600, textTransform: 'uppercase' }}>
                Alerted
              </div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#3c8cff', fontVariantNumeric: 'tabular-nums' }}>
                {50 - sim.driversInZone - sim.driversAlerted}
              </div>
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', fontWeight: 600, textTransform: 'uppercase' }}>
                Safe
              </div>
            </div>
          </div>
        </div>

        {/* ── Sim Controls ─────────────────────────── */}
        <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 12, padding: '14px 14px', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', marginBottom: 10 }}>
            Simulation
          </div>

          {/* Play / Pause / Reset */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <button
              id="sidebar-play-btn"
              onClick={sim.isRunning ? sim.pause : sim.start}
              style={{
                flex: 1,
                padding: '10px 0',
                borderRadius: 10,
                border: 'none',
                fontWeight: 700,
                fontSize: 12,
                cursor: 'pointer',
                background: sim.isRunning
                  ? 'linear-gradient(135deg, #ff4444, #ff6644)'
                  : 'linear-gradient(135deg, #4285f4, #34a853)',
                color: '#fff',
                letterSpacing: 0.5,
              }}
            >
              {sim.isRunning ? '⏸ Pause' : '▶ Play'}
            </button>
            <button
              id="sidebar-reset-btn"
              onClick={sim.reset}
              style={{
                padding: '10px 14px',
                borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(255,255,255,0.05)',
                color: '#fff',
                fontWeight: 600,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              ↻
            </button>
          </div>

          {/* Speed selector */}
          <div style={{ display: 'flex', gap: 6 }}>
            {[1, 2, 5, 10].map((s) => (
              <button
                key={s}
                id={`sidebar-speed-${s}x`}
                onClick={() => onSpeedChange(s)}
                style={{
                  flex: 1,
                  padding: '5px 0',
                  borderRadius: 8,
                  border: speed === s ? '1px solid #4285f4' : '1px solid rgba(255,255,255,0.08)',
                  background: speed === s ? 'rgba(66,133,244,0.2)' : 'rgba(255,255,255,0.03)',
                  color: speed === s ? '#4285f4' : 'rgba(255,255,255,0.4)',
                  fontWeight: 700,
                  fontSize: 10,
                  cursor: 'pointer',
                }}
              >
                {s}×
              </button>
            ))}
          </div>

          {/* Emergency Service button */}
          <button
            id="sidebar-emergency-btn"
            onClick={() => sim.activateEmergency()}
            disabled={sim.isEmergencyMode}
            title={sim.isEmergencyMode ? 'Emergency mode already active' : 'Activate drone delivery mode'}
            style={{
              marginTop: 10,
              width: '100%',
              padding: '9px 0',
              borderRadius: 10,
              border: sim.isEmergencyMode
                ? '1px solid rgba(139,92,246,0.25)'
                : '1px solid rgba(139,92,246,0.6)',
              background: sim.isEmergencyMode
                ? 'rgba(139,92,246,0.08)'
                : 'linear-gradient(135deg, #6d28d9, #a855f7)',
              color: sim.isEmergencyMode ? 'rgba(167,139,250,0.45)' : '#fff',
              fontWeight: 700,
              fontSize: 11,
              cursor: sim.isEmergencyMode ? 'not-allowed' : 'pointer',
              letterSpacing: 0.5,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              transition: 'all 0.2s',
              boxShadow: sim.isEmergencyMode ? 'none' : '0 0 12px rgba(139,92,246,0.4)',
            }}
          >
            🚁 Emergency Service
          </button>

          {/* Emergency phase status label */}
          {sim.isEmergencyMode && (
            <div style={{
              marginTop: 8,
              padding: '8px 10px',
              borderRadius: 8,
              background: 'rgba(139,92,246,0.12)',
              border: '1px solid rgba(139,92,246,0.25)',
              fontSize: 10,
              fontWeight: 700,
              color: '#c4b5fd',
              textAlign: 'center',
              letterSpacing: 0.5,
              animation: 'pulse 1.5s ease-in-out infinite',
            }}>
              {sim.emergencyPhase === 'ambulance-to-midpoint' && '🚑 Ambulance racing to pickup point...'}
              {sim.emergencyPhase === 'transfer' && '⚡ Transferring organ to drone!'}
              {sim.emergencyPhase === 'drone-flight' && '🚁 Drone delivering to hospital...'}
              {sim.emergencyPhase === 'arrived' && '✅ Drone arrived at destination!'}
            </div>
          )}
        </div>{/* end Simulation card */}

        {/* ── Route Source ──────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 2px' }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: sim.routePoints.length > 0 ? '#22c55e' : '#ef4444' }} />
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
            {sim.routePoints.length > 0 ? 'Route loaded' : 'Loading…'}
          </span>
        </div>

        {/* ── View Reward Summary ───────────────────── */}
        <button
          id="view-reward-summary-btn"
          onClick={tripDone && onViewRewards ? onViewRewards : undefined}
          disabled={!tripDone}
          title={tripDone ? 'Open billing summary' : 'Available after trip completes or timer expires'}
          style={{
            width: '100%',
            padding: '11px 0',
            borderRadius: 10,
            border: tripDone
              ? '1px solid rgba(52, 211, 153, 0.45)'
              : '1px solid rgba(255,255,255,0.08)',
            background: tripDone
              ? 'linear-gradient(135deg, #059669 0%, #10b981 100%)'
              : 'rgba(255,255,255,0.04)',
            color: tripDone ? '#fff' : 'rgba(255,255,255,0.25)',
            fontWeight: 700,
            fontSize: 12,
            letterSpacing: 0.5,
            cursor: tripDone ? 'pointer' : 'not-allowed',
            transition: 'all 0.25s ease',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            boxShadow: tripDone ? '0 0 16px rgba(16, 185, 129, 0.35)' : 'none',
          }}
        >
          <span style={{ fontSize: 14 }}>{tripDone ? '💸' : '🔒'}</span>
          View Reward Summary
        </button>

        <style>{`@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.5 } }`}</style>
      </div>
    </div>
  );
}
