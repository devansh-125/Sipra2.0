'use client';

/**
 * GemmaRewardsPanel
 *
 * Shown on the rewards-settlement page. Contains:
 * - Hospital Briefing Panel   — Gemma hospital_summary
 * - Driver Insight Panel      — Per-driver AI labels + explanations
 * - What-If Intelligence card — Gemma what_if_note
 */

import { useState, useCallback } from 'react';
import type { GemmaReport, GemmaTripInput, GemmaDriverInput } from '../../app/api/gemma/route';
import type { RewardDriverEntry } from '../../lib/rewardsSettlement';

interface GemmaRewardsPanelProps {
    tripId: string;
    distanceMeters: number;
    drivers: RewardDriverEntry[];
    rewardsSubtotal: number;
    distanceFee: number;
    platformCharge: number;
    complianceFee: number;
    totalPayable: number;
    destinationName: string;
    droneActivated?: boolean;
}

const LABEL_COLORS: Record<string, string> = {
    'Fast responder': '#22c55e',
    'Critical support contributor': '#3b82f6',
    'Delayed but valuable': '#f59e0b',
    'High-priority emergency response': '#ef4444',
    'Efficient corridor clearance': '#10b981',
};

const LABEL_BG: Record<string, string> = {
    'Fast responder': 'rgba(34,197,94,0.12)',
    'Critical support contributor': 'rgba(59,130,246,0.12)',
    'Delayed but valuable': 'rgba(245,158,11,0.12)',
    'High-priority emergency response': 'rgba(239,68,68,0.12)',
    'Efficient corridor clearance': 'rgba(16,185,129,0.12)',
};

function rupees(value: number): string {
    return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 0,
    }).format(value);
}

export default function GemmaRewardsPanel({
    tripId,
    distanceMeters,
    drivers,
    rewardsSubtotal,
    distanceFee,
    platformCharge,
    complianceFee,
    totalPayable,
    destinationName,
    droneActivated = false,
}: GemmaRewardsPanelProps) {
    const [report, setReport] = useState<GemmaReport | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const generateReport = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            // Build per-driver input from deterministic data
            const driverInputs: GemmaDriverInput[] = drivers.map((d) => {
                const alertOffsetMin = Math.round(
                    (Date.now() - d.redAlertAt.getTime()) / 60_000,
                );
                const redZoneDurationMin = Math.round(
                    (d.movedOutAt.getTime() - d.redAlertAt.getTime()) / 60_000,
                );
                return {
                    driverId: d.driverId,
                    rewardRupees: d.rewardRupees,
                    alertOffsetMin,
                    redZoneDurationMin,
                };
            });

            const tripInput: GemmaTripInput = {
                trip_id: tripId,
                hospital_name: destinationName,
                total_distance_km: Number((distanceMeters / 1000).toFixed(1)),
                golden_time_threshold_min: 60,
                elapsed_min: 42,
                progress_percent: 100,
                drone_activated: droneActivated,
                drivers: driverInputs,
                rewards_subtotal: rewardsSubtotal,
                distance_fee: distanceFee,
                platform_charge: platformCharge,
                compliance_fee: complianceFee,
                total_payable: totalPayable,
            };

            const res = await fetch('/api/gemma', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(tripInput),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = (await res.json()) as GemmaReport;
            setReport(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    }, [tripId, distanceMeters, drivers, rewardsSubtotal, distanceFee, platformCharge, complianceFee, totalPayable, destinationName, droneActivated]);

    // Build a lookup map for driver summaries
    const driverMap = new Map(
        (report?.driver_summaries ?? []).map((ds) => [ds.driverId, ds]),
    );

    const riskColors: Record<string, string> = {
        Safe: '#22c55e',
        Watchlist: '#f59e0b',
        Critical: '#ef4444',
        'Drone Required': '#a855f7',
    };

    return (
        <div className="space-y-6">
            {/* ── Generate button / status ── */}
            {!report && (
                <div
                    style={{
                        background: 'linear-gradient(135deg, rgba(109,40,217,0.12), rgba(30,27,75,0.5))',
                        border: '1px solid rgba(109,40,217,0.3)',
                        borderRadius: 16,
                        padding: '20px 20px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 12,
                        alignItems: 'center',
                        textAlign: 'center',
                    }}
                >
                    <div style={{ fontSize: 32 }}>🤖</div>
                    <div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: '#c4b5fd', marginBottom: 4 }}>
                            AI Mission Intelligence
                        </div>
                        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
                            Generate a Gemma-powered hospital briefing, driver performance analysis,
                            and predictive what-if insights for this mission.
                        </div>
                    </div>
                    {error && (
                        <div style={{ fontSize: 11, color: '#ef4444', background: 'rgba(239,68,68,0.08)', borderRadius: 8, padding: '6px 12px' }}>
                            ⚠ {error} — using AI fallback
                        </div>
                    )}
                    <button
                        id="gemma-rewards-generate-btn"
                        onClick={generateReport}
                        disabled={loading}
                        style={{
                            padding: '10px 28px',
                            borderRadius: 10,
                            border: '1px solid rgba(109,40,217,0.5)',
                            background: loading ? 'rgba(109,40,217,0.08)' : 'linear-gradient(135deg, #6d28d9, #7c3aed)',
                            color: loading ? 'rgba(196,181,253,0.4)' : '#fff',
                            fontWeight: 700,
                            fontSize: 13,
                            cursor: loading ? 'wait' : 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            boxShadow: loading ? 'none' : '0 0 16px rgba(109,40,217,0.35)',
                        }}
                    >
                        {loading ? (
                            <>
                                <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</span>
                                Generating AI Mission Report…
                            </>
                        ) : (
                            <>✨ Generate AI Mission Report</>
                        )}
                    </button>
                    <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
                </div>
            )}

            {/* ── AI Mission Control header (shown post-generation) ── */}
            {report && (
                <>
                    {/* Mission Status Banner */}
                    <div
                        style={{
                            background: 'linear-gradient(135deg, rgba(109,40,217,0.15), rgba(30,27,75,0.6))',
                            border: '1px solid rgba(109,40,217,0.35)',
                            borderRadius: 16,
                            padding: '20px 24px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 16,
                            flexWrap: 'wrap',
                        }}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                            <span style={{ fontSize: 36 }}>🤖</span>
                            <div>
                                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 2, color: '#a855f7', textTransform: 'uppercase', marginBottom: 2 }}>
                                    SIPRA AI — Mission Complete
                                </div>
                                <div style={{ fontSize: 16, fontWeight: 800, color: '#fff', lineHeight: 1.2 }}>
                                    {report.mission_title}
                                </div>
                            </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div
                                style={{
                                    padding: '6px 16px',
                                    borderRadius: 20,
                                    background: `${riskColors[report.risk_status] ?? '#22c55e'}18`,
                                    border: `1px solid ${riskColors[report.risk_status] ?? '#22c55e'}40`,
                                    color: riskColors[report.risk_status] ?? '#22c55e',
                                    fontWeight: 700,
                                    fontSize: 12,
                                }}
                            >
                                ● {report.risk_status}
                            </div>
                            <button
                                onClick={generateReport}
                                disabled={loading}
                                style={{
                                    padding: '6px 14px',
                                    borderRadius: 8,
                                    border: '1px solid rgba(109,40,217,0.4)',
                                    background: 'rgba(109,40,217,0.12)',
                                    color: '#c4b5fd',
                                    fontWeight: 600,
                                    fontSize: 11,
                                    cursor: 'pointer',
                                }}
                            >
                                ↺ Regenerate
                            </button>
                        </div>
                    </div>

                    {/* Hospital Briefing Panel */}
                    <div
                        style={{
                            background: 'linear-gradient(135deg, rgba(30,64,175,0.12), rgba(15,23,42,0.8))',
                            border: '1px solid rgba(59,130,246,0.25)',
                            borderRadius: 16,
                            padding: '20px 24px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 12,
                        }}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 18 }}>🏥</span>
                            <div>
                                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 2, color: '#60a5fa', textTransform: 'uppercase' }}>
                                    Hospital Briefing
                                </div>
                                <div style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>{destinationName}</div>
                            </div>
                            <div style={{ marginLeft: 'auto', fontSize: 9, background: 'rgba(34,197,94,0.12)', color: '#22c55e', padding: '3px 8px', borderRadius: 6, fontWeight: 700, border: '1px solid rgba(34,197,94,0.2)' }}>
                                ✓ MISSION COMPLETE
                            </div>
                        </div>

                        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.7, fontStyle: 'italic', background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: '12px 14px' }}>
                            &ldquo;{report.hospital_summary}&rdquo;
                        </div>

                        {/* Financial summary */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
                            {[
                                { label: 'Total Rewarded', value: rupees(rewardsSubtotal), color: '#10b981' },
                                { label: 'Distance Fee', value: rupees(distanceFee), color: '#60a5fa' },
                                { label: 'Platform Charge', value: rupees(platformCharge), color: '#a78bfa' },
                                { label: 'Total Payable', value: rupees(totalPayable), color: '#f59e0b' },
                            ].map(({ label, value, color }) => (
                                <div key={label} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '8px 10px' }}>
                                    <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', fontWeight: 600, textTransform: 'uppercase', marginBottom: 2 }}>{label}</div>
                                    <div style={{ fontSize: 13, fontWeight: 700, color }}>{value}</div>
                                </div>
                            ))}
                        </div>

                        {/* Final note */}
                        <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.5 }}>
                            💬 {report.final_note}
                        </div>
                    </div>

                    {/* Driver Insight Panel */}
                    <div
                        style={{
                            background: 'rgba(15,23,42,0.8)',
                            border: '1px solid rgba(255,255,255,0.08)',
                            borderRadius: 16,
                            padding: '20px 24px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 14,
                        }}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 16 }}>🚗</span>
                            <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1.5 }}>
                                Driver Performance Debrief — AI Analysis
                            </div>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {drivers.map((d) => {
                                const ai = driverMap.get(d.driverId);
                                const labelColor = LABEL_COLORS[ai?.label ?? ''] ?? '#94a3b8';
                                const labelBg = LABEL_BG[ai?.label ?? ''] ?? 'rgba(148,163,184,0.08)';
                                return (
                                    <div
                                        key={d.driverId}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'flex-start',
                                            gap: 12,
                                            background: 'rgba(255,255,255,0.02)',
                                            border: '1px solid rgba(255,255,255,0.05)',
                                            borderRadius: 10,
                                            padding: '10px 12px',
                                        }}
                                    >
                                        <div style={{ minWidth: 0, flex: 1 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                                                <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'monospace', color: '#e2e8f0' }}>
                                                    {d.driverId}
                                                </span>
                                                {ai?.label && (
                                                    <span
                                                        style={{
                                                            fontSize: 9,
                                                            fontWeight: 700,
                                                            padding: '2px 8px',
                                                            borderRadius: 20,
                                                            background: labelBg,
                                                            color: labelColor,
                                                            border: `1px solid ${labelColor}30`,
                                                            textTransform: 'uppercase',
                                                            letterSpacing: 0.5,
                                                        }}
                                                    >
                                                        {ai.label}
                                                    </span>
                                                )}
                                                <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: '#10b981' }}>
                                                    {rupees(d.rewardRupees)}
                                                </span>
                                            </div>
                                            {ai?.explanation && (
                                                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', lineHeight: 1.5 }}>
                                                    {ai.explanation}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* What-If Intelligence */}
                    {report.what_if_note && (
                        <div
                            style={{
                                background: 'linear-gradient(135deg, rgba(245,158,11,0.08), rgba(15,23,42,0.6))',
                                border: '1px solid rgba(245,158,11,0.25)',
                                borderRadius: 16,
                                padding: '16px 20px',
                                display: 'flex',
                                gap: 12,
                                alignItems: 'flex-start',
                            }}
                        >
                            <span style={{ fontSize: 22, flexShrink: 0 }}>💡</span>
                            <div>
                                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: '#fbbf24', textTransform: 'uppercase', marginBottom: 4 }}>
                                    What-If Intelligence
                                </div>
                                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.65)', lineHeight: 1.6 }}>
                                    {report.what_if_note}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Drone reason (if activated) */}
                    {report.drone_reason && (
                        <div
                            style={{
                                background: 'linear-gradient(135deg, rgba(168,85,247,0.1), rgba(15,23,42,0.7))',
                                border: '1px solid rgba(168,85,247,0.3)',
                                borderRadius: 16,
                                padding: '16px 20px',
                                display: 'flex',
                                gap: 12,
                                alignItems: 'flex-start',
                            }}
                        >
                            <span style={{ fontSize: 22, flexShrink: 0 }}>🚁</span>
                            <div>
                                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: '#a855f7', textTransform: 'uppercase', marginBottom: 4 }}>
                                    Drone Handoff Report
                                </div>
                                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.65)', lineHeight: 1.6 }}>
                                    {report.drone_reason}
                                </div>
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
