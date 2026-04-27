'use client';

/**
 * GemmaAIPanel — AI Mission Control card for the corridor-sim left sidebar.
 *
 * Shows risk tier, golden-time status, and a Gemma-generated mission summary.
 * Appears below the simulation controls and triggers the AI report on demand.
 */

import { useState, useCallback } from 'react';
import type { GemmaReport, GemmaTripInput } from '../../app/api/gemma/route';

interface GemmaAIPanelProps {
    progress: number;             // 0–1 ambulance progress fraction
    distanceMeters: number;
    droneActivated: boolean;
    driversInZone: number;
    tripDone: boolean;
    onReportReady?: (report: GemmaReport) => void;
}

const RISK_COLORS = {
    Safe: '#22c55e',
    Watchlist: '#f59e0b',
    Critical: '#ef4444',
    'Drone Required': '#a855f7',
};

const RISK_BG = {
    Safe: 'rgba(34,197,94,0.12)',
    Watchlist: 'rgba(245,158,11,0.12)',
    Critical: 'rgba(239,68,68,0.12)',
    'Drone Required': 'rgba(168,85,247,0.12)',
};

const RISK_ICONS = {
    Safe: '✅',
    Watchlist: '⚠️',
    Critical: '🔴',
    'Drone Required': '🚁',
};

export default function GemmaAIPanel({
    progress,
    distanceMeters,
    droneActivated,
    driversInZone,
    tripDone,
    onReportReady,
}: GemmaAIPanelProps) {
    const [report, setReport] = useState<GemmaReport | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const generateReport = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            // Build a representative trip payload
            const tripInput: GemmaTripInput = {
                trip_id: `demo-trip-${Date.now()}`,
                hospital_name: 'Tender Palm Hospital',
                total_distance_km: Number((distanceMeters / 1000).toFixed(1)),
                golden_time_threshold_min: 60,
                elapsed_min: Math.round(progress * 42), // ~42 min full trip
                progress_percent: Math.round(progress * 100),
                drone_activated: droneActivated,
                // No drivers here — just route-level stats for the sidebar panel
                drivers: [],
                rewards_subtotal: 0,
                distance_fee: Math.round((distanceMeters / 1000) * 12),
                platform_charge: 0,
                compliance_fee: 249,
                total_payable: 0,
            };

            const res = await fetch('/api/gemma', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(tripInput),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = (await res.json()) as GemmaReport;
            setReport(data);
            onReportReady?.(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    }, [distanceMeters, droneActivated, progress, onReportReady]);

    const riskStatus = report?.risk_status ?? (droneActivated ? 'Drone Required' : progress > 0.8 ? 'Critical' : progress > 0.5 ? 'Watchlist' : 'Safe');
    const riskColor = RISK_COLORS[riskStatus];
    const riskBg = RISK_BG[riskStatus];
    const riskIcon = RISK_ICONS[riskStatus];

    return (
        <div
            style={{
                background: 'linear-gradient(135deg, rgba(124,58,237,0.08), rgba(30,30,60,0.5))',
                borderRadius: 12,
                padding: '14px',
                border: '1px solid rgba(124,58,237,0.25)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
            }}
        >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 14 }}>🤖</span>
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: 'rgba(167,139,250,0.9)', textTransform: 'uppercase' }}>
                        AI Mission Control
                    </span>
                </div>
                <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.25)', fontWeight: 500 }}>Gemma</span>
            </div>

            {/* Risk Tier */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    background: riskBg,
                    border: `1px solid ${riskColor}40`,
                    borderRadius: 8,
                    padding: '6px 10px',
                }}
            >
                <span style={{ fontSize: 14 }}>{riskIcon}</span>
                <div>
                    <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
                        Risk Tier
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: riskColor }}>
                        {riskStatus}
                    </div>
                </div>
                {droneActivated && (
                    <div style={{ marginLeft: 'auto', fontSize: 9, color: '#a855f7', fontWeight: 700, background: 'rgba(168,85,247,0.12)', padding: '2px 6px', borderRadius: 4 }}>
                        DRONE ACTIVE
                    </div>
                )}
            </div>

            {/* Stats row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '6px 10px' }}>
                    <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', fontWeight: 600, textTransform: 'uppercase' }}>Golden Time</div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: progress > 0.8 ? '#ef4444' : '#22c55e', marginTop: 2 }}>
                        {progress > 0.8 ? '⚠ Critical' : '✓ On Track'}
                    </div>
                </div>
                <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '6px 10px' }}>
                    <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', fontWeight: 600, textTransform: 'uppercase' }}>Drone Mode</div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: droneActivated ? '#a855f7' : 'rgba(255,255,255,0.45)', marginTop: 2 }}>
                        {droneActivated ? '🚁 Active' : 'Road Only'}
                    </div>
                </div>
            </div>

            {/* Gemma report content */}
            {report && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#c4b5fd', lineHeight: 1.3 }}>
                        {report.mission_title}
                    </div>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', lineHeight: 1.5, fontStyle: 'italic' }}>
                        {report.final_note}
                    </div>
                    {report.what_if_note && (
                        <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 6, padding: '6px 8px' }}>
                            <div style={{ fontSize: 8, fontWeight: 700, color: '#fbbf24', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 2 }}>
                                💡 What-If
                            </div>
                            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', lineHeight: 1.4 }}>
                                {report.what_if_note}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Error */}
            {error && (
                <div style={{ fontSize: 9, color: '#ef4444', background: 'rgba(239,68,68,0.08)', borderRadius: 6, padding: '4px 8px' }}>
                    ⚠ AI unavailable — using fallback
                </div>
            )}

            {/* Generate button */}
            <button
                id="gemma-generate-btn"
                onClick={generateReport}
                disabled={loading}
                style={{
                    width: '100%',
                    padding: '8px 0',
                    borderRadius: 8,
                    border: '1px solid rgba(124,58,237,0.5)',
                    background: loading
                        ? 'rgba(124,58,237,0.08)'
                        : 'linear-gradient(135deg, #6d28d9, #7c3aed)',
                    color: loading ? 'rgba(167,139,250,0.4)' : '#fff',
                    fontWeight: 700,
                    fontSize: 10,
                    letterSpacing: 0.5,
                    cursor: loading ? 'wait' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    transition: 'all 0.2s',
                    boxShadow: loading ? 'none' : '0 0 10px rgba(109,40,217,0.35)',
                }}
            >
                {loading ? (
                    <>
                        <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</span>
                        Generating AI Report…
                    </>
                ) : (
                    <>✨ {report ? 'Regenerate' : 'Generate'} AI Report</>
                )}
            </button>

            <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
        </div>
    );
}
