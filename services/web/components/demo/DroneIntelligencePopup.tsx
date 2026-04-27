'use client';

/**
 * DroneIntelligencePopup
 *
 * Overlay card shown when emergency drone mode is activated.
 * Shows a purple animated drone header, Gemma-generated drone_reason text,
 * and a dramatic mission summary.
 */

import { useState, useEffect, useCallback } from 'react';
import type { GemmaTripInput } from '../../app/api/gemma/route';

interface DroneIntelligencePopupProps {
    isEmergencyMode: boolean;
    emergencyPhase: 'none' | 'ambulance-to-midpoint' | 'transfer' | 'drone-flight' | 'arrived';
    distanceMeters: number;
    onDismiss?: () => void;
}

const INSTANT_DRONE_TEXT =
    'Golden time risk detected. Road transport is no longer viable. Drone fallback activated at midpoint to preserve organ viability.';

export default function DroneIntelligencePopup({
    isEmergencyMode,
    emergencyPhase,
    distanceMeters,
    onDismiss,
}: DroneIntelligencePopupProps) {
    const [visible, setVisible] = useState(false);
    const [droneReason, setDroneReason] = useState(INSTANT_DRONE_TEXT);
    const [aiLoaded, setAiLoaded] = useState(false);
    const [dismissed, setDismissed] = useState(false);

    // Show popup when emergency is triggered
    useEffect(() => {
        if (isEmergencyMode && emergencyPhase !== 'none') {
            setVisible(true);
            setDismissed(false);
        }
    }, [isEmergencyMode, emergencyPhase]);

    // Fetch Gemma drone reason in background (instant fallback shown first)
    const fetchDroneReason = useCallback(async () => {
        try {
            const tripInput: GemmaTripInput = {
                trip_id: `drone-${Date.now()}`,
                hospital_name: 'Tender Palm Hospital',
                total_distance_km: Number((distanceMeters / 1000).toFixed(1)),
                golden_time_threshold_min: 60,
                elapsed_min: 35,
                progress_percent: 55,
                drone_activated: true,
                drivers: [],
                rewards_subtotal: 0,
                distance_fee: 0,
                platform_charge: 0,
                compliance_fee: 0,
                total_payable: 0,
            };
            const res = await fetch('/api/gemma', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(tripInput),
            });
            if (!res.ok) return;
            const data = await res.json();
            if (data?.drone_reason && data.drone_reason.length > 10) {
                setDroneReason(data.drone_reason);
                setAiLoaded(true);
            }
        } catch {
            // keep default text
        }
    }, [distanceMeters]);

    useEffect(() => {
        if (isEmergencyMode && !aiLoaded) {
            fetchDroneReason();
        }
    }, [isEmergencyMode, aiLoaded, fetchDroneReason]);

    const handleDismiss = () => {
        setDismissed(true);
        onDismiss?.();
    };

    if (!visible || dismissed) return null;

    const phaseLabel =
        emergencyPhase === 'ambulance-to-midpoint'
            ? '🚑 Ambulance racing to pickup point…'
            : emergencyPhase === 'transfer'
                ? '⚡ Transferring organ to drone!'
                : emergencyPhase === 'drone-flight'
                    ? '🚁 Drone at altitude — en route to hospital'
                    : '✅ Drone arrived at destination!';

    return (
        <div
            style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 9999,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(0,0,0,0.7)',
                backdropFilter: 'blur(4px)',
            }}
        >
            <div
                style={{
                    background: 'linear-gradient(135deg, #0c0c1a, #1a0a2e)',
                    border: '1px solid rgba(168,85,247,0.4)',
                    borderRadius: 20,
                    padding: '28px 28px',
                    maxWidth: 420,
                    width: '90vw',
                    boxShadow: '0 0 60px rgba(168,85,247,0.3), 0 0 120px rgba(168,85,247,0.12)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 16,
                    animation: 'slideIn 0.35s ease',
                }}
            >
                {/* Drone animation header */}
                <div style={{ textAlign: 'center', position: 'relative' }}>
                    <div
                        style={{
                            fontSize: 48,
                            animation: 'droneFloat 2s ease-in-out infinite',
                            display: 'inline-block',
                        }}
                    >
                        🚁
                    </div>
                    <div
                        style={{
                            position: 'absolute',
                            top: '50%',
                            left: '50%',
                            transform: 'translate(-50%, -50%)',
                            width: 80,
                            height: 80,
                            borderRadius: '50%',
                            border: '2px solid rgba(168,85,247,0.3)',
                            animation: 'ripple 2s ease-out infinite',
                        }}
                    />
                    <div
                        style={{
                            position: 'absolute',
                            top: '50%',
                            left: '50%',
                            transform: 'translate(-50%, -50%)',
                            width: 110,
                            height: 110,
                            borderRadius: '50%',
                            border: '1px solid rgba(168,85,247,0.15)',
                            animation: 'ripple 2s ease-out infinite 0.5s',
                        }}
                    />
                </div>

                {/* Title */}
                <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, color: '#a855f7', textTransform: 'uppercase', marginBottom: 4 }}>
                        SIPRA AI — Critical Alert
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: '#fff', lineHeight: 1.2 }}>
                        Emergency Drone Handoff
                    </div>
                </div>

                {/* Phase status */}
                <div
                    style={{
                        background: 'rgba(168,85,247,0.12)',
                        border: '1px solid rgba(168,85,247,0.3)',
                        borderRadius: 10,
                        padding: '8px 14px',
                        textAlign: 'center',
                        fontSize: 11,
                        fontWeight: 700,
                        color: '#c4b5fd',
                        animation: 'pulse 1.5s ease-in-out infinite',
                    }}
                >
                    {phaseLabel}
                </div>

                {/* AI-generated drone reason */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: 'rgba(167,139,250,0.6)', textTransform: 'uppercase' }}>
                            AI Analysis
                        </span>
                        {aiLoaded && (
                            <span style={{ fontSize: 8, background: 'rgba(34,197,94,0.15)', color: '#22c55e', padding: '1px 5px', borderRadius: 4, fontWeight: 700 }}>
                                GEMMA
                            </span>
                        )}
                    </div>
                    <div
                        style={{
                            fontSize: 12,
                            color: 'rgba(255,255,255,0.7)',
                            lineHeight: 1.6,
                            fontStyle: aiLoaded ? 'normal' : 'italic',
                        }}
                    >
                        {droneReason}
                    </div>
                </div>

                {/* Stats */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                    {[
                        { label: 'Mode', value: 'Aerial', color: '#a855f7' },
                        { label: 'Status', value: 'Active', color: '#22c55e' },
                        { label: 'Route', value: 'Direct', color: '#3c8cff' },
                    ].map(({ label, value, color }) => (
                        <div key={label} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '8px', textAlign: 'center' }}>
                            <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.35)', fontWeight: 600, textTransform: 'uppercase' }}>{label}</div>
                            <div style={{ fontSize: 12, fontWeight: 700, color, marginTop: 2 }}>{value}</div>
                        </div>
                    ))}
                </div>

                {/* Dismiss */}
                <button
                    id="drone-popup-dismiss-btn"
                    onClick={handleDismiss}
                    style={{
                        width: '100%',
                        padding: '10px 0',
                        borderRadius: 10,
                        border: '1px solid rgba(168,85,247,0.35)',
                        background: 'rgba(168,85,247,0.12)',
                        color: '#c4b5fd',
                        fontWeight: 700,
                        fontSize: 12,
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                    }}
                >
                    Acknowledge Mission Update
                </button>
            </div>

            <style>{`
        @keyframes droneFloat {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-8px); }
        }
        @keyframes ripple {
          0% { opacity: 0.6; transform: translate(-50%, -50%) scale(0.8); }
          100% { opacity: 0; transform: translate(-50%, -50%) scale(1.8); }
        }
        @keyframes slideIn {
          from { opacity: 0; transform: scale(0.93) translateY(-16px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
      `}</style>
        </div>
    );
}
