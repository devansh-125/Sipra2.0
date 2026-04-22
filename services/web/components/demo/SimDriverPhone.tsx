'use client';

/**
 * SimDriverPhone
 *
 * Right column of the three-panel Mission Control demo layout.
 * Mobile phone mockup showing a Swiggy-style driver POV that reacts
 * to the shared simulation state:
 *   - peaceful: blue route, "Navigating to drop-off"
 *   - alert:    amber detour, red flash + "EVACUATE CORRIDOR" modal
 *
 * State sharing: triggers the alert when `isRunning` is true AND
 * at least 1 driver is inside the exclusion zone.
 */

import { useEffect, useRef, useState, useMemo } from 'react';
import { Map, useMap } from '@vis.gl/react-google-maps';
import { GoogleMapsOverlay } from '@deck.gl/google-maps';
import { ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import type { Layer, Position } from '@deck.gl/core';
import type { CorridorSimState, SimDriver, DriverStatus } from '../../hooks/useCorridorSimulation';

interface SimDriverPhoneProps {
  sim: CorridorSimState;
}

type PovState = 'peaceful' | 'alert';

// DeckGLOverlay
function DeckGLOverlay({ layers }: { layers: (Layer | null)[] }) {
  const map = useMap();
  const overlayRef = useRef<GoogleMapsOverlay | null>(null);

  useEffect(() => {
    if (!map) return;
    const overlay = new GoogleMapsOverlay({ layers: [] });
    overlayRef.current = overlay;
    const rafId = requestAnimationFrame(() => {
      if (overlayRef.current === overlay) overlay.setMap(map);
    });
    return () => {
      cancelAnimationFrame(rafId);
      overlay.setMap(null);
      overlayRef.current = null;
    };
  }, [map]);

  useEffect(() => {
    overlayRef.current?.setProps({
      layers: layers.filter((l): l is Layer => l !== null),
    });
  });

  return null;
}

function PhoneMapScene({ sim, targetDriver, povState }: { sim: CorridorSimState, targetDriver: SimDriver | undefined, povState: PovState }) {
  const driverStatus = targetDriver?.status || 'safe';
  
  const routeLayer = useMemo(() => {
    if (sim.routePoints.length < 2) return null;
    return new PathLayer({
      id: 'phone-route',
      data: [{ path: sim.routePoints.map((p: any) => [p.lng, p.lat] as Position) }],
      getPath: (d: { path: Position[] }) => d.path,
      getColor: povState === 'alert' ? [245, 158, 11, 200] : [59, 130, 246, 200],
      getWidth: 8,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
    });
  }, [sim.routePoints, povState]);

  const driverLayer = useMemo(() => {
    if (!targetDriver) return null;
    return new ScatterplotLayer({
      id: 'phone-driver',
      data: [targetDriver],
      getPosition: (d: SimDriver) => [d.lng, d.lat],
      getRadius: 16,
      getFillColor: [37, 99, 235, 255],
      getLineColor: [255, 255, 255, 255],
      getLineWidth: 3,
      lineWidthUnits: 'pixels',
      radiusUnits: 'pixels',
      stroked: true,
      pickable: false,
      transitions: { getPosition: { duration: 300 } },
    });
  }, [targetDriver]);

  const ambulanceLayer = useMemo(() => {
    return new ScatterplotLayer({
      id: 'phone-ambulance',
      data: [sim.ambulancePosition],
      getPosition: (d: any) => [d.lng, d.lat],
      getRadius: 16,
      getFillColor: [255, 255, 255, 255],
      getLineColor: [220, 0, 0, 255],
      getLineWidth: 4,
      lineWidthUnits: 'pixels',
      radiusUnits: 'pixels',
      stroked: true,
      pickable: false,
      transitions: { getPosition: { duration: 300 } },
    });
  }, [sim.ambulancePosition]);

  return <DeckGLOverlay layers={[routeLayer, ambulanceLayer, driverLayer]} />;
}


export default function SimDriverPhone({ sim }: SimDriverPhoneProps) {
  const [povState, setPovState] = useState<PovState>('peaceful');
  const [showFlash, setShowFlash] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [barFull, setBarFull] = useState(false);
  const [targetDriverId, setTargetDriverId] = useState<string | null>(null);
  const prevInZoneRef = useRef(0);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  function clearTimers() {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }

  function track(id: ReturnType<typeof setTimeout>) {
    timersRef.current.push(id);
  }

  useEffect(() => () => clearTimers(), []);

  // Select target driver
  useEffect(() => {
    if (!targetDriverId && sim.drivers.length > 0) {
      const alerted = sim.drivers.find((d: any) => d.status !== 'safe');
      if (alerted) {
        setTargetDriverId(alerted.id);
      }
    }
  }, [sim.drivers, targetDriverId]);

  const targetDriver = useMemo(() => {
    if (targetDriverId) {
      const found = sim.drivers.find((d: any) => d.id === targetDriverId);
      if (found) return found;
    }
    return sim.drivers[0];
  }, [sim.drivers, targetDriverId]);

  // Trigger alert when drivers enter the zone during simulation
  useEffect(() => {
    if (!sim.isRunning) {
      // Reset when paused
      if (povState === 'alert' && sim.driversInZone === 0) {
        clearTimers();
        setPovState('peaceful');
        setShowFlash(false);
        setShowModal(false);
        setBarFull(false);
      }
      return;
    }

    // Transition to alert when first driver enters zone
    if (sim.driversInZone > 0 && prevInZoneRef.current === 0 && povState === 'peaceful') {
      clearTimers();
      setPovState('alert');
      setShowFlash(true);
      track(setTimeout(() => setShowFlash(false), 800));
      setShowModal(true);
      track(setTimeout(() => setBarFull(true), 50));
      track(
        setTimeout(() => {
          setShowModal(false);
          setBarFull(false);
        }, 3000),
      );
    }

    // Return to peaceful when zone clears
    if (sim.driversInZone === 0 && prevInZoneRef.current > 0 && povState === 'alert') {
      clearTimers();
      setPovState('peaceful');
      setShowFlash(false);
      setShowModal(false);
      setBarFull(false);
    }

    prevInZoneRef.current = sim.driversInZone;
  }, [sim.isRunning, sim.driversInZone, povState]);

  // Reset on simulation reset
  useEffect(() => {
    if (sim.progress === 0) {
      clearTimers();
      setPovState('peaceful');
      setShowFlash(false);
      setShowModal(false);
      setBarFull(false);
      setTargetDriverId(null);
      prevInZoneRef.current = 0;
    }
  }, [sim.progress]);

  const statusColor = povState === 'alert' ? '#f59e0b' : '#3b82f6';

  return (
    <div
      style={{
        height: '100%',
        background: '#0c0c1a',
        borderLeft: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        fontFamily: "'Inter', -apple-system, sans-serif",
        padding: '16px 12px',
      }}
    >
      {/* Title */}
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', marginBottom: 12, textAlign: 'center' }}>
        Driver POV
      </div>

      {/* Phone bezel */}
      <div
        style={{
          position: 'relative',
          width: 240,
          maxHeight: 'calc(100% - 40px)',
          aspectRatio: '9/19.5',
          borderRadius: 36,
          border: '10px solid #1e293b',
          background: '#000',
          boxShadow: '0 20px 60px -10px rgba(0,0,0,0.8), inset 0 0 0 1px rgba(255,255,255,0.05)',
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        {/* Notch */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 80,
            height: 18,
            background: '#1e293b',
            borderRadius: '0 0 14px 14px',
            zIndex: 10,
          }}
        />

        {/* Screen */}
        <div style={{ position: 'absolute', inset: 0, background: '#f1f5f9', display: 'flex', flexDirection: 'column' }}>
          {/* Status bar */}
          <div style={{ height: 24, background: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', flexShrink: 0 }}>
            <span style={{ fontSize: 9, fontWeight: 600, color: '#334155' }}>10:47</span>
            <div style={{ display: 'flex', gap: 3 }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: '#64748b' }} />
              <div style={{ width: 8, height: 8, borderRadius: 2, background: '#64748b' }} />
              <div style={{ width: 12, height: 8, borderRadius: 2, background: '#64748b' }} />
            </div>
          </div>

          {/* Nav banner */}
          <div
            style={{
              background: statusColor,
              color: '#fff',
              fontSize: 10,
              fontWeight: 600,
              padding: '6px 12px',
              flexShrink: 0,
              transition: 'background 0.3s',
            }}
          >
            {povState === 'alert'
              ? '⚠ Detour active — avoiding exclusion zone'
              : 'Navigating to drop-off'}
          </div>

          {/* Map area */}
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#e2e8f0' }}>
            <Map
              center={targetDriver ? { lat: targetDriver.lat, lng: targetDriver.lng } : { lat: 26.84, lng: 80.94 }}
              zoom={13}
              disableDefaultUI
              gestureHandling="none"
              mapId="sim-driver-pov"
              style={{ width: '100%', height: '100%' }}
            >
              <PhoneMapScene sim={sim} targetDriver={targetDriver} povState={povState} />
            </Map>

            {/* Flash */}
            {showFlash && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'rgba(239,68,68,0.3)',
                  pointerEvents: 'none',
                  animation: 'phonePulse 0.4s ease-in-out 2',
                }}
              />
            )}

            {/* Alert modal */}
            {showModal && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: '#dc2626',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  padding: 16,
                }}
              >
                <div style={{ fontSize: 28 }}>⚠️</div>
                <p style={{ color: '#fff', textAlign: 'center', fontWeight: 700, fontSize: 12, lineHeight: 1.4 }}>
                  🚨 CRITICAL MEDICAL TRANSIT APPROACHING
                </p>
                <p style={{ color: 'rgba(255,200,200,0.9)', fontSize: 9, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase' }}>
                  REROUTING IMMEDIATELY
                </p>
                <div style={{ width: '100%', height: 4, background: 'rgba(127,29,29,0.6)', borderRadius: 4, overflow: 'hidden', marginTop: 4 }}>
                  <div
                    style={{
                      height: '100%',
                      background: '#fff',
                      borderRadius: 4,
                      transition: 'width 3s linear',
                      width: barFull ? '100%' : '0%',
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Bottom card */}
          <div
            style={{
              background: '#fff',
              borderTop: '1px solid #e2e8f0',
              padding: '8px 12px',
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  background: '#e2e8f0',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  fontWeight: 700,
                  color: '#64748b',
                  flexShrink: 0,
                }}
              >
                R
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                  <span style={{ fontSize: 16, fontWeight: 700, color: '#0f172a' }}>8 min</span>
                  <span style={{ fontSize: 9, color: '#94a3b8' }}>away</span>
                </div>
                <span style={{ fontSize: 9, color: '#94a3b8' }}>101 MG Road</span>
              </div>
            </div>
            <button
              style={{
                width: '100%',
                marginTop: 6,
                padding: '6px 0',
                borderRadius: 8,
                border: 'none',
                background: povState === 'alert' ? '#f59e0b' : '#22c55e',
                color: '#fff',
                fontSize: 10,
                fontWeight: 700,
                cursor: 'pointer',
                transition: 'background 0.3s',
              }}
            >
              {povState === 'alert' ? 'Rerouting…' : 'Start Navigation'}
            </button>
          </div>
        </div>
      </div>

      {/* Status text below phone */}
      <div style={{ marginTop: 12, textAlign: 'center', fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
        {povState === 'alert' ? (
          <span style={{ color: '#f59e0b', fontWeight: 600 }}>⚠ Webhook received — rerouting</span>
        ) : sim.isRunning ? (
          <span>Monitoring corridor…</span>
        ) : (
          <span>Press Play to begin simulation</span>
        )}
      </div>

      <style>{`@keyframes phonePulse { 0%,100% { opacity: 0 } 50% { opacity: 1 } }`}</style>
    </div>
  );
}
