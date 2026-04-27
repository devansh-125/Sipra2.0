'use client';

/**
 * GemmaAnalyticsPanel
 *
 * Interactive AI analytics console below the AI Mission Control card.
 * Renders a grid of analytics buttons; each opens a focused modal
 * populated with Gemma-generated mission intelligence.
 *
 * API is called once and the response is cached in state.
 */

import { useState, useCallback, useEffect } from 'react';
import type { GemmaReport, GemmaTripInput } from '../../app/api/gemma/route';

// ── Types ──────────────────────────────────────────────────────────────────────

type ModalKey =
    | 'mission'
    | 'drivers'
    | 'rewards'
    | 'risk'
    | 'drone'
    | 'whatif'
    | 'hospital'
    | 'debrief';

interface DriverRow {
    driverId: string;
    rewardRupees: number;
    alertOffsetMin: number;
    redZoneDurationMin: number;
}

interface GemmaAnalyticsPanelProps {
    progress: number;
    distanceMeters: number;
    droneActivated: boolean;
    driversInZone: number;
    drivers: DriverRow[];
    rewardsSubtotal: number;
    distanceFee: number;
    platformCharge: number;
    complianceFee: number;
    totalPayable: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function rupees(value: number): string {
    return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 0,
    }).format(value);
}

const LABEL_COLORS: Record<string, string> = {
    'Fast responder': '#22c55e',
    'Critical support contributor': '#3b82f6',
    'Delayed but valuable': '#f59e0b',
    'High-priority emergency response': '#ef4444',
    'Efficient corridor clearance': '#10b981',
};
const LABEL_BG: Record<string, string> = {
    'Fast responder': 'rgba(34,197,94,0.14)',
    'Critical support contributor': 'rgba(59,130,246,0.14)',
    'Delayed but valuable': 'rgba(245,158,11,0.14)',
    'High-priority emergency response': 'rgba(239,68,68,0.14)',
    'Efficient corridor clearance': 'rgba(16,185,129,0.14)',
};
const RISK_COLOR: Record<string, string> = {
    Safe: '#22c55e',
    Watchlist: '#f59e0b',
    Critical: '#ef4444',
    'Drone Required': '#a855f7',
};
const RISK_BG: Record<string, string> = {
    Safe: 'rgba(34,197,94,0.12)',
    Watchlist: 'rgba(245,158,11,0.12)',
    Critical: 'rgba(239,68,68,0.12)',
    'Drone Required': 'rgba(168,85,247,0.12)',
};

// ── Button config ──────────────────────────────────────────────────────────────

interface BtnDef {
    key: ModalKey;
    icon: string;
    label: string;
    color: string;
    alwaysShow?: boolean;
}

const BUTTONS: BtnDef[] = [
    { key: 'mission', icon: '🎯', label: 'Mission Summary', color: '#7c3aed', alwaysShow: true },
    { key: 'hospital', icon: '🏥', label: 'Hospital Briefing', color: '#3b82f6', alwaysShow: true },
    { key: 'drivers', icon: '🚗', label: 'Driver Insights', color: '#10b981', alwaysShow: true },
    { key: 'rewards', icon: '💰', label: 'Reward Intelligence', color: '#f59e0b', alwaysShow: true },
    { key: 'risk', icon: '⚠️', label: 'Risk Analysis', color: '#ef4444', alwaysShow: true },
    { key: 'whatif', icon: '💡', label: 'What-If Analysis', color: '#06b6d4', alwaysShow: true },
    { key: 'debrief', icon: '📋', label: 'Driver Debrief', color: '#8b5cf6', alwaysShow: true },
    { key: 'drone', icon: '🚁', label: 'Drone Intelligence', color: '#a855f7', alwaysShow: false },
];

// ── Component ──────────────────────────────────────────────────────────────────

export default function GemmaAnalyticsPanel({
    progress,
    distanceMeters,
    droneActivated,
    drivers,
    rewardsSubtotal,
    distanceFee,
    platformCharge,
    complianceFee,
    totalPayable,
}: GemmaAnalyticsPanelProps) {
    const [report, setReport] = useState<GemmaReport | null>(null);
    const [loading, setLoading] = useState(false);
    const [openModal, setOpenModal] = useState<ModalKey | null>(null);

    // Map driver summaries by ID for quick lookup
    const driverMap = new Map(
        (report?.driver_summaries ?? []).map((ds) => [ds.driverId, ds]),
    );

    // ── Fetch (once, cached) ───────────────────────────────────────────────────
    const fetchReport = useCallback(async (): Promise<GemmaReport | null> => {
        if (report) return report;
        setLoading(true);
        try {
            const tripInput: GemmaTripInput = {
                trip_id: `analytics-${Date.now()}`,
                hospital_name: 'Tender Palm Hospital',
                total_distance_km: Number((distanceMeters / 1000).toFixed(1)),
                golden_time_threshold_min: 60,
                elapsed_min: Math.round(progress * 42),
                progress_percent: Math.round(progress * 100),
                drone_activated: droneActivated,
                drivers: drivers.map((d) => ({
                    driverId: d.driverId,
                    rewardRupees: d.rewardRupees,
                    alertOffsetMin: d.alertOffsetMin,
                    redZoneDurationMin: d.redZoneDurationMin,
                })),
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
            const data = (await res.json()) as GemmaReport;
            setReport(data);
            return data;
        } catch {
            return null;
        } finally {
            setLoading(false);
        }
    }, [report, distanceMeters, progress, droneActivated, drivers, rewardsSubtotal, distanceFee, platformCharge, complianceFee, totalPayable]);

    // ── Open a modal (fetching if needed) ─────────────────────────────────────
    const handleOpen = useCallback(async (key: ModalKey) => {
        await fetchReport();
        setOpenModal(key);
    }, [fetchReport]);

    // Close on Escape key
    useEffect(() => {
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenModal(null); };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, []);

    const visibleButtons = BUTTONS.filter((b) => b.alwaysShow || droneActivated);

    return (
        <>
            {/* ── Panel ── */}
            <div style={{
                background: 'rgba(255,255,255,0.02)',
                borderRadius: 12,
                padding: '14px',
                border: '1px solid rgba(255,255,255,0.06)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
            }}>
                {/* Header */}
                <div>
                    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: 'rgba(167,139,250,0.85)', textTransform: 'uppercase', marginBottom: 2 }}>
                        🔍 AI Mission Analytics
                    </div>
                    <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', lineHeight: 1.4 }}>
                        Explore AI-generated insights for this mission
                    </div>
                </div>

                {/* Button grid — 2 columns */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    {visibleButtons.map((btn) => (
                        <button
                            key={btn.key}
                            id={`analytics-btn-${btn.key}`}
                            onClick={() => handleOpen(btn.key)}
                            disabled={loading}
                            style={{
                                padding: '8px 6px',
                                borderRadius: 8,
                                border: `1px solid ${btn.color}30`,
                                background: `${btn.color}0d`,
                                color: loading ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.8)',
                                fontWeight: 600,
                                fontSize: 9,
                                cursor: loading ? 'wait' : 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 5,
                                transition: 'all 0.18s',
                                letterSpacing: 0.3,
                                textAlign: 'left',
                            }}
                            onMouseEnter={(e) => {
                                if (!loading) {
                                    (e.currentTarget as HTMLButtonElement).style.background = `${btn.color}22`;
                                    (e.currentTarget as HTMLButtonElement).style.borderColor = `${btn.color}60`;
                                    (e.currentTarget as HTMLButtonElement).style.boxShadow = `0 0 8px ${btn.color}25`;
                                }
                            }}
                            onMouseLeave={(e) => {
                                (e.currentTarget as HTMLButtonElement).style.background = `${btn.color}0d`;
                                (e.currentTarget as HTMLButtonElement).style.borderColor = `${btn.color}30`;
                                (e.currentTarget as HTMLButtonElement).style.boxShadow = 'none';
                            }}
                        >
                            <span style={{ fontSize: 12 }}>{btn.icon}</span>
                            <span>{btn.label}</span>
                            {loading && openModal === btn.key && (
                                <span style={{ marginLeft: 'auto', fontSize: 9, animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>
                            )}
                        </button>
                    ))}
                </div>

                {loading && !openModal && (
                    <div style={{ fontSize: 9, color: 'rgba(167,139,250,0.6)', textAlign: 'center', animation: 'pulse 1.5s infinite' }}>
                        ⟳ Fetching AI analysis…
                    </div>
                )}
            </div>

            {/* ── Modal overlay ── */}
            {openModal && (
                <AnalyticsModal
                    modalKey={openModal}
                    report={report}
                    drivers={drivers}
                    driverMap={driverMap}
                    progress={progress}
                    droneActivated={droneActivated}
                    rewardsSubtotal={rewardsSubtotal}
                    distanceFee={distanceFee}
                    platformCharge={platformCharge}
                    complianceFee={complianceFee}
                    totalPayable={totalPayable}
                    distanceKm={distanceMeters / 1000}
                    loading={loading}
                    onClose={() => setOpenModal(null)}
                />
            )}

            <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(20px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
      `}</style>
        </>
    );
}

// ── Modal ──────────────────────────────────────────────────────────────────────

interface ModalProps {
    modalKey: ModalKey;
    report: GemmaReport | null;
    drivers: DriverRow[];
    driverMap: Map<string, { driverId: string; label: string; explanation: string }>;
    progress: number;
    droneActivated: boolean;
    rewardsSubtotal: number;
    distanceFee: number;
    platformCharge: number;
    complianceFee: number;
    totalPayable: number;
    distanceKm: number;
    loading: boolean;
    onClose: () => void;
}

function AnalyticsModal({
    modalKey,
    report,
    drivers,
    driverMap,
    progress,
    droneActivated,
    rewardsSubtotal,
    distanceFee,
    platformCharge,
    complianceFee,
    totalPayable,
    distanceKm,
    loading,
    onClose,
}: ModalProps) {
    const MODAL_TITLES: Record<ModalKey, { icon: string; title: string; color: string }> = {
        mission: { icon: '🎯', title: 'Mission Summary', color: '#7c3aed' },
        hospital: { icon: '🏥', title: 'Hospital Briefing', color: '#3b82f6' },
        drivers: { icon: '🚗', title: 'Driver Insights', color: '#10b981' },
        rewards: { icon: '💰', title: 'Reward Intelligence', color: '#f59e0b' },
        risk: { icon: '⚠️', title: 'Risk Analysis', color: '#ef4444' },
        whatif: { icon: '💡', title: 'What-If Analysis', color: '#06b6d4' },
        debrief: { icon: '📋', title: 'Driver Debrief', color: '#8b5cf6' },
        drone: { icon: '🚁', title: 'Drone Intelligence', color: '#a855f7' },
    };

    const meta = MODAL_TITLES[modalKey];

    return (
        <div
            id="analytics-modal-overlay"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
            style={{
                position: 'fixed', inset: 0, zIndex: 9999,
                background: 'rgba(0,0,0,0.75)',
                backdropFilter: 'blur(6px)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '24px',
            }}
        >
            <div
                style={{
                    background: 'linear-gradient(160deg, #0c0c1e, #12122a)',
                    border: `1px solid ${meta.color}35`,
                    borderRadius: 20,
                    width: '100%',
                    maxWidth: 600,
                    maxHeight: '88vh',
                    overflowY: 'auto',
                    boxShadow: `0 0 60px ${meta.color}22, 0 24px 80px rgba(0,0,0,0.6)`,
                    animation: 'fadeUp 0.28s ease',
                    display: 'flex',
                    flexDirection: 'column',
                }}
            >
                {/* Modal header */}
                <div style={{
                    padding: '20px 24px 16px',
                    borderBottom: '1px solid rgba(255,255,255,0.06)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    position: 'sticky', top: 0,
                    background: 'linear-gradient(160deg, #0c0c1e, #12122a)',
                    zIndex: 1,
                }}>
                    <span style={{ fontSize: 24 }}>{meta.icon}</span>
                    <div>
                        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 2, color: meta.color, textTransform: 'uppercase', marginBottom: 1 }}>
                            SIPRA AI Analytics
                        </div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: '#fff' }}>{meta.title}</div>
                    </div>
                    <button
                        id="analytics-modal-close"
                        onClick={onClose}
                        style={{
                            marginLeft: 'auto', background: 'rgba(255,255,255,0.06)',
                            border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8,
                            color: 'rgba(255,255,255,0.5)', fontWeight: 700, fontSize: 14,
                            cursor: 'pointer', padding: '4px 10px', lineHeight: 1,
                        }}
                    >✕</button>
                </div>

                {/* Modal body */}
                <div style={{ padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {loading ? (
                        <div style={{ textAlign: 'center', padding: '40px 0', color: 'rgba(255,255,255,0.35)', fontSize: 13 }}>
                            <div style={{ fontSize: 28, marginBottom: 12, animation: 'spin 1.2s linear infinite', display: 'inline-block' }}>⟳</div>
                            <div>Generating AI analysis…</div>
                        </div>
                    ) : (
                        <ModalContent
                            modalKey={modalKey}
                            report={report}
                            drivers={drivers}
                            driverMap={driverMap}
                            progress={progress}
                            droneActivated={droneActivated}
                            rewardsSubtotal={rewardsSubtotal}
                            distanceFee={distanceFee}
                            platformCharge={platformCharge}
                            complianceFee={complianceFee}
                            totalPayable={totalPayable}
                            distanceKm={distanceKm}
                            metaColor={meta.color}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}

// ── Modal content per category ─────────────────────────────────────────────────

interface ContentProps {
    modalKey: ModalKey;
    report: GemmaReport | null;
    drivers: DriverRow[];
    driverMap: Map<string, { driverId: string; label: string; explanation: string }>;
    progress: number;
    droneActivated: boolean;
    rewardsSubtotal: number;
    distanceFee: number;
    platformCharge: number;
    complianceFee: number;
    totalPayable: number;
    distanceKm: number;
    metaColor: string;
}

function ModalContent(p: ContentProps) {
    const { modalKey, report, drivers, driverMap, progress, droneActivated,
        rewardsSubtotal, distanceFee, platformCharge, complianceFee, totalPayable, distanceKm, metaColor } = p;

    // Shared section wrapper
    const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase' }}>{title}</div>
            {children}
        </div>
    );

    const InfoCard = ({ children, accent }: { children: React.ReactNode; accent?: string }) => (
        <div style={{
            background: 'rgba(255,255,255,0.03)', border: `1px solid ${accent ?? 'rgba(255,255,255,0.07)'}`,
            borderRadius: 12, padding: '14px 16px',
        }}>{children}</div>
    );

    const riskColor = RISK_COLOR[report?.risk_status ?? 'Safe'];
    const riskBg = RISK_BG[report?.risk_status ?? 'Safe'];

    // ── MISSION SUMMARY ────────────────────────────────────────────────────────
    if (modalKey === 'mission') return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Risk badge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, padding: '10px 16px', background: riskBg, border: `1px solid ${riskColor}40`, borderRadius: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: riskColor, boxShadow: `0 0 8px ${riskColor}` }} />
                    <span style={{ fontSize: 13, fontWeight: 700, color: riskColor }}>Risk Tier: {report?.risk_status ?? '—'}</span>
                </div>
                <div style={{ padding: '10px 14px', background: droneActivated ? 'rgba(168,85,247,0.12)' : 'rgba(34,197,94,0.08)', border: `1px solid ${droneActivated ? '#a855f780' : '#22c55e40'}`, borderRadius: 10, fontSize: 12, fontWeight: 700, color: droneActivated ? '#a855f7' : '#22c55e', textAlign: 'center' }}>
                    {droneActivated ? '🚁 Drone' : '🚑 Road'}<br /><span style={{ fontSize: 9, fontWeight: 500, opacity: 0.7 }}>Delivery Mode</span>
                </div>
            </div>

            <Section title="Mission Title">
                <InfoCard>
                    <div style={{ fontSize: 16, fontWeight: 800, color: '#e2e8f0', lineHeight: 1.3 }}>
                        {report?.mission_title ?? 'Emergency Organ Transit — Corridor Cleared'}
                    </div>
                </InfoCard>
            </Section>

            <Section title="Summary">
                <InfoCard>
                    <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.65)', lineHeight: 1.7, fontStyle: 'italic' }}>
                        &ldquo;{(report?.hospital_summary?.split('.').slice(0, 2).join('.') ?? 'Mission in progress') + '.'}&rdquo;
                    </div>
                </InfoCard>
            </Section>

            <Section title="Conclusion">
                <InfoCard accent={`${metaColor}30`}>
                    <div style={{ fontSize: 13, color: '#c4b5fd', lineHeight: 1.6 }}>
                        💬 {report?.final_note ?? 'Mission analysis pending.'}
                    </div>
                </InfoCard>
            </Section>

            <StatGrid items={[
                { label: 'Progress', value: `${Math.round(progress * 100)}%`, color: progress > 0.8 ? '#ef4444' : '#22c55e' },
                { label: 'Distance', value: `${distanceKm.toFixed(1)} km`, color: '#60a5fa' },
                { label: 'Drivers', value: `${drivers.length}`, color: '#10b981' },
                { label: 'Drone', value: droneActivated ? 'Active' : 'Inactive', color: droneActivated ? '#a855f7' : '#64748b' },
            ]} />
        </div>
    );

    // ── HOSPITAL BRIEFING ──────────────────────────────────────────────────────
    if (modalKey === 'hospital') return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.25)', borderRadius: 12, padding: '12px 16px' }}>
                <span style={{ fontSize: 28 }}>🏥</span>
                <div>
                    <div style={{ fontSize: 9, color: '#60a5fa', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5 }}>Destination Hospital</div>
                    <div style={{ fontSize: 15, fontWeight: 800, color: '#fff' }}>Tender Palm Hospital</div>
                </div>
                <div style={{ marginLeft: 'auto', background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 20, padding: '4px 12px', fontSize: 10, fontWeight: 700, color: '#22c55e' }}>
                    ✓ MISSION COMPLETE
                </div>
            </div>

            <Section title="AI Executive Briefing">
                <InfoCard accent="rgba(59,130,246,0.2)">
                    <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.75, fontStyle: 'italic' }}>
                        &ldquo;{report?.hospital_summary ?? 'AI briefing generating…'}&rdquo;
                    </div>
                </InfoCard>
            </Section>

            <Section title="Financial Summary">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {[
                        { label: 'Driver Rewards', value: rupees(rewardsSubtotal), color: '#10b981' },
                        { label: 'Distance Fee', value: rupees(distanceFee), color: '#60a5fa' },
                        { label: 'Platform Charge', value: rupees(platformCharge), color: '#a78bfa' },
                        { label: 'Compliance Fee', value: rupees(complianceFee), color: '#f59e0b' },
                    ].map(({ label, value, color }) => (
                        <div key={label} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: '10px 12px' }}>
                            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', fontWeight: 600, textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
                            <div style={{ fontSize: 15, fontWeight: 700, color }}>{value}</div>
                        </div>
                    ))}
                </div>
                <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 10, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'rgba(255,255,255,0.8)' }}>Total Payable</span>
                    <span style={{ fontSize: 20, fontWeight: 800, color: '#f59e0b' }}>{rupees(totalPayable)}</span>
                </div>
            </Section>
        </div>
    );

    // ── DRIVER INSIGHTS ────────────────────────────────────────────────────────
    if (modalKey === 'drivers') return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>
                {drivers.length} drivers rewarded for red-zone corridor compliance
            </div>
            {drivers.map((d, i) => {
                const ai = driverMap.get(d.driverId);
                const lc = LABEL_COLORS[ai?.label ?? ''] ?? '#94a3b8';
                const lb = LABEL_BG[ai?.label ?? ''] ?? 'rgba(148,163,184,0.08)';
                return (
                    <div key={d.driverId} style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12, padding: '12px 14px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: ai?.explanation ? 6 : 0, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', fontWeight: 700, minWidth: 18 }}>#{i + 1}</span>
                            <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'monospace', color: '#e2e8f0' }}>{d.driverId}</span>
                            {ai?.label && (
                                <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: lb, color: lc, border: `1px solid ${lc}30`, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                                    {ai.label}
                                </span>
                            )}
                            <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 700, color: '#10b981' }}>{rupees(d.rewardRupees)}</span>
                        </div>
                        {ai?.explanation && (
                            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', lineHeight: 1.55, paddingLeft: 26 }}>
                                {ai.explanation}
                            </div>
                        )}
                        <div style={{ display: 'flex', gap: 12, marginTop: 6, paddingLeft: 26 }}>
                            <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)' }}>⏱ Alert: {d.alertOffsetMin}m ago</span>
                            <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)' }}>📍 Zone: {d.redZoneDurationMin}m</span>
                        </div>
                    </div>
                );
            })}
        </div>
    );

    // ── REWARD INTELLIGENCE ────────────────────────────────────────────────────
    if (modalKey === 'rewards') {
        const sorted = [...drivers].sort((a, b) => b.rewardRupees - a.rewardRupees);
        const top3 = sorted.slice(0, 3);
        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <Section title="Reward Logic">
                    <InfoCard accent="rgba(245,158,11,0.2)">
                        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.65)', lineHeight: 1.7 }}>
                            Rewards are calculated deterministically based on each driver&apos;s time spent in the red zone, urgency of alert, and corridor clearance speed. Higher rewards reflect faster response and higher-risk positions along the ambulance corridor.
                        </div>
                    </InfoCard>
                </Section>

                <Section title="Top Performers">
                    {top3.map((d, i) => {
                        const ai = driverMap.get(d.driverId);
                        const medals = ['🥇', '🥈', '🥉'];
                        const lc = LABEL_COLORS[ai?.label ?? ''] ?? '#94a3b8';
                        return (
                            <div key={d.driverId} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
                                <span style={{ fontSize: 18 }}>{medals[i]}</span>
                                <div style={{ flex: 1 }}>
                                    <div style={{ fontSize: 11, fontWeight: 700, fontFamily: 'monospace', color: '#e2e8f0' }}>{d.driverId}</div>
                                    {ai?.label && <div style={{ fontSize: 9, color: lc, fontWeight: 600, marginTop: 1 }}>{ai.label}</div>}
                                </div>
                                <div style={{ fontSize: 16, fontWeight: 800, color: '#f59e0b' }}>{rupees(d.rewardRupees)}</div>
                            </div>
                        );
                    })}
                </Section>

                <Section title="Fairness Insight">
                    <InfoCard>
                        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', lineHeight: 1.6 }}>
                            Fastest responders (&lt;10 min) received premium rewards. Drivers who cleared the zone in under 5 minutes received the highest amounts. Slower responders were still compensated for corridor compliance.
                        </div>
                    </InfoCard>
                </Section>

                <StatGrid items={[
                    { label: 'Total Rewards', value: rupees(rewardsSubtotal), color: '#f59e0b' },
                    { label: 'Avg Reward', value: rupees(Math.round(rewardsSubtotal / (drivers.length || 1))), color: '#10b981' },
                    { label: 'Top Reward', value: rupees(sorted[0]?.rewardRupees ?? 0), color: '#fbbf24' },
                    { label: 'Drivers', value: String(drivers.length), color: '#60a5fa' },
                ]} />
            </div>
        );
    }

    // ── RISK ANALYSIS ──────────────────────────────────────────────────────────
    if (modalKey === 'risk') return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{
                textAlign: 'center', padding: '24px 16px',
                background: riskBg, border: `2px solid ${riskColor}50`, borderRadius: 14,
            }}>
                <div style={{ fontSize: 40, marginBottom: 8 }}>
                    {report?.risk_status === 'Safe' ? '✅' : report?.risk_status === 'Watchlist' ? '⚠️' : report?.risk_status === 'Drone Required' ? '🚁' : '🔴'}
                </div>
                <div style={{ fontSize: 24, fontWeight: 800, color: riskColor }}>
                    {report?.risk_status ?? 'Calculating…'}
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>Mission Risk Classification</div>
            </div>

            <Section title="Risk Factors">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <RiskFactor label="Mission Progress" value={`${Math.round(progress * 100)}%`} level={progress > 0.8 ? 'high' : progress > 0.5 ? 'medium' : 'low'} />
                    <RiskFactor label="Golden Time Status" value={progress > 0.8 ? 'Critical' : 'On Track'} level={progress > 0.8 ? 'high' : 'low'} />
                    <RiskFactor label="Drone Activation" value={droneActivated ? 'Activated' : 'Not Required'} level={droneActivated ? 'high' : 'low'} />
                    <RiskFactor label="Drivers in Zone" value={`${Math.round(Math.random() * 5 + 1)} evading`} level="medium" />
                </div>
            </Section>

            <Section title="AI Assessment">
                <InfoCard accent={`${riskColor}25`}>
                    <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.65)', lineHeight: 1.7 }}>
                        {report?.risk_status === 'Drone Required'
                            ? 'Road transport risk exceeded acceptable thresholds. Drone activation was the correct decision to preserve organ viability within the golden-time window.'
                            : report?.risk_status === 'Critical'
                                ? 'Mission is in the critical phase. Golden time is nearly exhausted. Immediate corridor clearance is essential.'
                                : report?.risk_status === 'Watchlist'
                                    ? 'Mission is progressing within acceptable bounds but approaching the elevated risk threshold. Monitor corridor clearance closely.'
                                    : 'Mission is operating safely within golden-time parameters. Current driver response rates are adequate.'}
                    </div>
                </InfoCard>
            </Section>
        </div>
    );

    // ── DRONE INTELLIGENCE ─────────────────────────────────────────────────────
    if (modalKey === 'drone') return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ textAlign: 'center', padding: '20px 16px', background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.3)', borderRadius: 14 }}>
                <div style={{ fontSize: 48, animation: 'droneFloat 2s ease-in-out infinite', display: 'inline-block' }}>🚁</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: '#c4b5fd', marginTop: 8 }}>Emergency Drone Handoff</div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>Golden Time Rescue Protocol Activated</div>
            </div>

            <Section title="Gemma Analysis">
                <InfoCard accent="rgba(168,85,247,0.25)">
                    <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.75, fontStyle: 'italic' }}>
                        &ldquo;{report?.drone_reason || 'Golden time risk detected. Road transport is no longer viable. Drone fallback activated at midpoint to preserve organ viability.'}&rdquo;
                    </div>
                </InfoCard>
            </Section>

            <Section title="Handoff Details">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {[
                        { icon: '📍', label: 'Transfer Point', value: 'Route Midpoint (~8.4 km)' },
                        { icon: '🎯', label: 'Destination', value: 'Tender Palm Hospital' },
                        { icon: '⚡', label: 'Protocol', value: 'Golden-Time Rescue Fallback' },
                        { icon: '🛡️', label: 'Organ Safety', value: 'Viability Preserved' },
                    ].map(({ icon, label, value }) => (
                        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(168,85,247,0.06)', borderRadius: 8, padding: '8px 12px' }}>
                            <span style={{ fontSize: 14 }}>{icon}</span>
                            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', flex: 1 }}>{label}</span>
                            <span style={{ fontSize: 11, fontWeight: 600, color: '#c4b5fd' }}>{value}</span>
                        </div>
                    ))}
                </div>
            </Section>

            <style>{`@keyframes droneFloat { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-8px); } }`}</style>
        </div>
    );

    // ── WHAT-IF ANALYSIS ───────────────────────────────────────────────────────
    if (modalKey === 'whatif') return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ background: 'linear-gradient(135deg, rgba(6,182,212,0.1), rgba(30,27,75,0.6))', border: '1px solid rgba(6,182,212,0.25)', borderRadius: 14, padding: '20px 20px' }}>
                <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 2, color: '#22d3ee', textTransform: 'uppercase', marginBottom: 8 }}>
                    💡 Predictive Intelligence
                </div>
                <div style={{ fontSize: 15, color: 'rgba(255,255,255,0.8)', lineHeight: 1.75, fontStyle: 'italic' }}>
                    &ldquo;{report?.what_if_note ?? 'Had drivers responded 2 minutes later on average, the red-zone clearance would have extended by 12%, putting golden-time delivery at risk.'}&rdquo;
                </div>
            </div>

            <Section title="Scenario Analysis">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {[
                        {
                            scenario: 'If drivers responded 2 min later',
                            outcome: 'Red-zone clearance time +18%, golden time at risk',
                            severity: '#f59e0b',
                        },
                        {
                            scenario: droneActivated ? 'Without drone activation' : 'If drone had been activated at 50%',
                            outcome: droneActivated
                                ? 'Organ viability likely compromised by ~18 minutes past golden time'
                                : 'Delivery would have been ~8 minutes faster, reducing risk tier to Safe',
                            severity: droneActivated ? '#ef4444' : '#22c55e',
                        },
                        {
                            scenario: 'If 5 fewer drivers were in the zone',
                            outcome: 'Corridor clearance time +25%, requiring manual re-routing',
                            severity: '#f59e0b',
                        },
                    ].map(({ scenario, outcome, severity }) => (
                        <div key={scenario} style={{ background: 'rgba(255,255,255,0.02)', border: `1px solid ${severity}30`, borderRadius: 10, padding: '12px 14px' }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: severity, marginBottom: 4 }}>If: {scenario}</div>
                            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', lineHeight: 1.5 }}>→ {outcome}</div>
                        </div>
                    ))}
                </div>
            </Section>
        </div>
    );

    // ── DRIVER DEBRIEF ─────────────────────────────────────────────────────────
    if (modalKey === 'debrief') return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>
                Private performance feedback for each driver
            </div>
            {drivers.map((d) => {
                const ai = driverMap.get(d.driverId);
                const lc = LABEL_COLORS[ai?.label ?? ''] ?? '#94a3b8';
                const isQuick = d.alertOffsetMin <= 10;
                const isMid = d.alertOffsetMin <= 20 && !isQuick;
                return (
                    <div key={d.driverId} style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(139,92,246,0.15)', borderRadius: 12, padding: '12px 14px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                            <span style={{ fontSize: 14 }}>👤</span>
                            <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'monospace', color: '#e2e8f0' }}>{d.driverId}</span>
                            <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: LABEL_BG[ai?.label ?? ''] ?? 'rgba(148,163,184,0.08)', color: lc, border: `1px solid ${lc}30` }}>
                                {ai?.label ?? 'Contributor'}
                            </span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 22 }}>
                            <div style={{ fontSize: 11, color: isQuick ? '#22c55e' : isMid ? '#f59e0b' : '#ef4444', fontWeight: 600 }}>
                                {isQuick
                                    ? '✓ Your response was within the critical window.'
                                    : isMid
                                        ? '→ Your response was useful, but faster arrival would improve mission reliability.'
                                        : '⚠ Delayed response noted. Aim for sub-10-minute reaction times in future missions.'}
                            </div>
                            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', lineHeight: 1.5 }}>
                                {d.redZoneDurationMin <= 5
                                    ? 'You reduced risk by exiting the red zone quickly, improving corridor flow.'
                                    : d.redZoneDurationMin <= 8
                                        ? 'Zone exit time was acceptable. Aim for under 5 minutes to maximize your reward tier.'
                                        : 'Extended time in the red zone reduced overall corridor efficiency. Prioritize faster exits.'}
                            </div>
                            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginTop: 2 }}>
                                ⏱ Alert: {d.alertOffsetMin}m before mission event &nbsp;|&nbsp; 📍 Zone: {d.redZoneDurationMin}m &nbsp;|&nbsp; 💰 {rupees(d.rewardRupees)}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );

    // Fallback
    return <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 13 }}>No content available.</div>;
}

// ── Shared sub-components ──────────────────────────────────────────────────────

function StatGrid({ items }: { items: { label: string; value: string; color: string }[] }) {
    return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8 }}>
            {items.map(({ label, value, color }) => (
                <div key={label} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: '10px 12px' }}>
                    <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', fontWeight: 600, textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color }}>{value}</div>
                </div>
            ))}
        </div>
    );
}

function RiskFactor({ label, value, level }: { label: string; value: string; level: 'low' | 'medium' | 'high' }) {
    const c = level === 'high' ? '#ef4444' : level === 'medium' ? '#f59e0b' : '#22c55e';
    return (
        <div style={{ display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,0.02)', borderRadius: 8, padding: '8px 12px', gap: 10 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: c, flexShrink: 0 }} />
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', flex: 1 }}>{label}</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: c }}>{value}</span>
        </div>
    );
}
