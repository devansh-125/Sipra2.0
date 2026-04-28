'use client';

/**
 * AmbulanceDispatchMap
 *
 * Full-page Google Maps component for real-time ambulance dispatch.
 *
 * Features:
 *   - Fetches REAL hospitals from Google Places API
 *   - Draws REAL driving routes from Google Directions API
 *   - Filters hospitals along/near the ambulance route
 *   - Animates ambulance movement along real road polylines
 *   - Premium UI with glassmorphism panels, micro-animations
 *
 * Zero dummy data — everything comes from Google APIs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Map, useMap, AdvancedMarker, InfoWindow, Pin } from '@vis.gl/react-google-maps';
import { GoogleMapsOverlay } from '@deck.gl/google-maps';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { Layer, Position } from '@deck.gl/core';

import { useAmbulanceDispatch, type Hospital } from '../../hooks/useAmbulanceDispatch';
import type { GeoPoint } from '../../lib/types';

// ---------------------------------------------------------------------------
// DeckGL Overlay
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Pulsing alpha hook
// ---------------------------------------------------------------------------
function usePulse(period = 2000): number {
  const [alpha, setAlpha] = useState(0.5);
  useEffect(() => {
    let raf: number;
    const start = performance.now();
    const animate = () => {
      const t = (Math.sin(((performance.now() - start) / period) * Math.PI * 2) + 1) / 2;
      setAlpha(0.3 + t * 0.5);
      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, [period]);
  return alpha;
}

// ---------------------------------------------------------------------------
// MapLayers — deck.gl overlay layers
// ---------------------------------------------------------------------------
function MapLayers({
  activeRoute,
  ambulancePosition,
  ambulanceProgress,
  hospitals,
  selectedHospitalId,
}: {
  activeRoute: GeoPoint[];
  ambulancePosition: GeoPoint | null;
  ambulanceProgress: number;
  hospitals: Hospital[];
  selectedHospitalId: string | null;
}) {
  const map = useMap();
  const pulseAlpha = usePulse(2000);
  const didFitRef = useRef(false);

  // Fit bounds when route is ready
  useEffect(() => {
    if (!map || didFitRef.current || activeRoute.length < 2) return;
    const bounds = new google.maps.LatLngBounds();
    activeRoute.forEach(p => bounds.extend({ lat: p.lat, lng: p.lng }));
    // Also include all hospitals
    hospitals.forEach(h => bounds.extend({ lat: h.lat, lng: h.lng }));
    map.fitBounds(bounds, 80);
    didFitRef.current = true;
  }, [map, activeRoute, hospitals]);

  // Reset fit when route changes
  useEffect(() => {
    didFitRef.current = false;
  }, [selectedHospitalId]);

  // Route path layer
  const routeLayer = useMemo(() => {
    if (activeRoute.length < 2) return null;
    return new PathLayer({
      id: 'dispatch-route',
      data: [{ path: activeRoute.map(p => [p.lng, p.lat] as Position) }],
      getPath: (d: { path: Position[] }) => d.path,
      getColor: [66, 133, 244, 180],
      getWidth: 6,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
    });
  }, [activeRoute]);

  // Traversed route (bright highlight)
  const traversedLayer = useMemo(() => {
    if (activeRoute.length < 2 || ambulanceProgress <= 0) return null;
    const endIdx = Math.min(
      Math.floor(ambulanceProgress * (activeRoute.length - 1)) + 1,
      activeRoute.length,
    );
    const traversed = activeRoute.slice(0, endIdx);
    if (traversed.length < 2) return null;
    return new PathLayer({
      id: 'dispatch-route-traversed',
      data: [{ path: traversed.map(p => [p.lng, p.lat] as Position) }],
      getPath: (d: { path: Position[] }) => d.path,
      getColor: [34, 197, 94, 255],
      getWidth: 8,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
    });
  }, [activeRoute, ambulanceProgress]);

  // Ambulance position glow
  const ambulanceGlowLayer = useMemo(() => {
    if (!ambulancePosition) return null;
    return new ScatterplotLayer({
      id: 'dispatch-ambulance-glow',
      data: [ambulancePosition],
      getPosition: (d: GeoPoint) => [d.lng, d.lat],
      getRadius: 400,
      radiusUnits: 'meters',
      getFillColor: [220, 38, 38, Math.round(pulseAlpha * 80)],
      stroked: false,
      pickable: false,
      transitions: { getPosition: { duration: 100 } },
    });
  }, [ambulancePosition, pulseAlpha]);

  // Ambulance marker
  const ambulanceLayer = useMemo(() => {
    if (!ambulancePosition) return null;
    return new ScatterplotLayer({
      id: 'dispatch-ambulance',
      data: [ambulancePosition],
      getPosition: (d: GeoPoint) => [d.lng, d.lat],
      getRadius: 14,
      getFillColor: [255, 255, 255, 255],
      getLineColor: [220, 38, 38, 255],
      getLineWidth: 4,
      lineWidthUnits: 'pixels',
      radiusUnits: 'pixels',
      stroked: true,
      pickable: false,
      transitions: { getPosition: { duration: 100 } },
    });
  }, [ambulancePosition]);

  // Ambulance inner dot
  const ambulanceInnerLayer = useMemo(() => {
    if (!ambulancePosition) return null;
    return new ScatterplotLayer({
      id: 'dispatch-ambulance-inner',
      data: [ambulancePosition],
      getPosition: (d: GeoPoint) => [d.lng, d.lat],
      getRadius: 5,
      getFillColor: [220, 38, 38, 255],
      radiusUnits: 'pixels',
      stroked: false,
      pickable: false,
      transitions: { getPosition: { duration: 100 } },
    });
  }, [ambulancePosition]);

  return (
    <DeckGLOverlay
      layers={[
        routeLayer,
        traversedLayer,
        ambulanceGlowLayer,
        ambulanceInnerLayer,
        ambulanceLayer,
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// HospitalMarkers — Google Maps Advanced Markers for hospitals
// ---------------------------------------------------------------------------
function HospitalMarkers({
  hospitals,
  selectedHospitalId,
  onSelect,
}: {
  hospitals: Hospital[];
  selectedHospitalId: string | null;
  onSelect: (h: Hospital) => void;
}) {
  const [infoHospital, setInfoHospital] = useState<Hospital | null>(null);

  return (
    <>
      {hospitals.map((h) => {
        const isSelected = h.place_id === selectedHospitalId;
        const isOnRoute = h.onRoute;

        return (
          <AdvancedMarker
            key={h.place_id}
            position={{ lat: h.lat, lng: h.lng }}
            onClick={() => {
              onSelect(h);
              setInfoHospital(h);
            }}
            zIndex={isSelected ? 100 : isOnRoute ? 50 : 10}
          >
            <div
              style={{
                background: isSelected
                  ? 'linear-gradient(135deg, #dc2626, #ef4444)'
                  : isOnRoute
                  ? 'linear-gradient(135deg, #059669, #10b981)'
                  : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                color: '#fff',
                padding: '6px 10px',
                borderRadius: 20,
                fontSize: 11,
                fontWeight: 700,
                fontFamily: "'Inter', sans-serif",
                boxShadow: isSelected
                  ? '0 4px 20px rgba(220, 38, 38, 0.5)'
                  : '0 2px 12px rgba(0,0,0,0.3)',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                cursor: 'pointer',
                transform: isSelected ? 'scale(1.15)' : 'scale(1)',
                transition: 'all 0.2s ease',
                border: isSelected ? '2px solid #fff' : '1px solid rgba(255,255,255,0.3)',
                whiteSpace: 'nowrap',
              }}
            >
              <span style={{ fontSize: 14 }}>🏥</span>
              <span>{h.name.length > 25 ? h.name.slice(0, 25) + '…' : h.name}</span>
              {h.rating && (
                <span style={{ 
                  background: 'rgba(255,255,255,0.2)', 
                  padding: '1px 5px', 
                  borderRadius: 8,
                  fontSize: 10 
                }}>
                  ⭐ {h.rating}
                </span>
              )}
            </div>
          </AdvancedMarker>
        );
      })}

      {infoHospital && (
        <InfoWindow
          position={{ lat: infoHospital.lat, lng: infoHospital.lng }}
          onCloseClick={() => setInfoHospital(null)}
          pixelOffset={[0, -40]}
        >
          <div style={{
            fontFamily: "'Inter', sans-serif",
            maxWidth: 280,
            padding: 4,
          }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 700, color: '#1a1a2e' }}>
              🏥 {infoHospital.name}
            </h3>
            <p style={{ margin: '0 0 4px', fontSize: 12, color: '#666' }}>
              📍 {infoHospital.address}
            </p>
            {infoHospital.rating && (
              <p style={{ margin: '0 0 4px', fontSize: 12 }}>
                ⭐ {infoHospital.rating} ({infoHospital.user_ratings_total} reviews)
              </p>
            )}
            {infoHospital.etaSeconds > 0 && (
              <p style={{ margin: '0 0 4px', fontSize: 12, color: '#059669', fontWeight: 600 }}>
                🚑 ETA: {Math.round(infoHospital.etaSeconds / 60)} min •{' '}
                {(infoHospital.routeDistanceMeters / 1000).toFixed(1)} km
              </p>
            )}
            <p style={{ 
              margin: '4px 0 0', 
              fontSize: 11,
              padding: '3px 8px',
              borderRadius: 10,
              display: 'inline-block',
              background: infoHospital.onRoute ? '#dcfce7' : '#f3f4f6',
              color: infoHospital.onRoute ? '#166534' : '#6b7280',
              fontWeight: 600,
            }}>
              {infoHospital.onRoute ? '✅ On Route' : '📌 Off Route'}
            </p>
            <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>
              Place ID: {infoHospital.place_id}
            </div>
          </div>
        </InfoWindow>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// UserLocationMarker
// ---------------------------------------------------------------------------
function UserLocationMarker({ position }: { position: GeoPoint }) {
  return (
    <AdvancedMarker position={{ lat: position.lat, lng: position.lng }} zIndex={200}>
      <div style={{
        width: 20,
        height: 20,
        borderRadius: '50%',
        background: '#3b82f6',
        border: '3px solid #fff',
        boxShadow: '0 0 0 4px rgba(59, 130, 246, 0.3), 0 2px 8px rgba(0,0,0,0.3)',
      }} />
    </AdvancedMarker>
  );
}

// ---------------------------------------------------------------------------
// Sidebar — Hospital list & controls
// ---------------------------------------------------------------------------
function Sidebar({
  dispatch,
  speed,
  onSpeedChange,
}: {
  dispatch: ReturnType<typeof useAmbulanceDispatch>;
  speed: number;
  onSpeedChange: (s: number) => void;
}) {
  const {
    phase,
    hospitals,
    onRouteHospitals,
    selectedHospital,
    activeEtaSeconds,
    activeDistanceMeters,
    ambulanceProgress,
    isSimulating,
    selectHospital,
    startSimulation,
    pauseSimulation,
    resetSimulation,
  } = dispatch;

  const [filter, setFilter] = useState<'all' | 'on-route'>('all');

  const displayHospitals = filter === 'on-route' ? onRouteHospitals : hospitals;

  return (
    <div style={{
      position: 'absolute',
      top: 20,
      left: 20,
      bottom: 20,
      width: 360,
      zIndex: 30,
      background: 'rgba(10, 10, 25, 0.92)',
      backdropFilter: 'blur(24px)',
      WebkitBackdropFilter: 'blur(24px)',
      border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: 20,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      fontFamily: "'Inter', 'SF Pro Display', -apple-system, sans-serif",
      color: '#fff',
      boxShadow: '0 8px 40px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.05)',
    }}>
      {/* Header */}
      <div style={{
        padding: '20px 20px 16px',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 10,
        }}>
          <div style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            background: 'linear-gradient(135deg, #dc2626, #ef4444)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 20,
            boxShadow: '0 4px 12px rgba(220, 38, 38, 0.4)',
          }}>
            🚑
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: 0.3 }}>
              Ambulance Dispatch
            </div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', fontWeight: 500 }}>
              Real-Time Hospital Routing
            </div>
          </div>
        </div>

        {/* Status badge */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 12px',
          borderRadius: 10,
          background: phase === 'ready'
            ? 'rgba(34,197,94,0.15)'
            : phase === 'error'
            ? 'rgba(239,68,68,0.15)'
            : 'rgba(59,130,246,0.15)',
          fontSize: 11,
          fontWeight: 600,
        }}>
          <div style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: phase === 'ready' ? '#22c55e' : phase === 'error' ? '#ef4444' : '#3b82f6',
            animation: phase !== 'ready' && phase !== 'error' ? 'pulse-dot 1.5s infinite' : 'none',
          }} />
          {phase === 'locating' && 'Detecting location…'}
          {phase === 'fetching_hospitals' && 'Fetching hospitals…'}
          {phase === 'routing' && 'Computing routes…'}
          {phase === 'ready' && `${hospitals.length} hospitals found`}
          {phase === 'error' && (dispatch.errorMessage ?? 'Error')}
        </div>
      </div>

      {/* Selected Hospital */}
      {selectedHospital && (
        <div style={{
          padding: '14px 20px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          background: 'rgba(220, 38, 38, 0.08)',
        }}>
          <div style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 1.5,
            color: 'rgba(255,255,255,0.35)',
            marginBottom: 6,
            textTransform: 'uppercase',
          }}>
            Active Destination
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
            🏥 {selectedHospital.name}
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', marginBottom: 8 }}>
            📍 {selectedHospital.address}
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 8,
          }}>
            <div style={{
              background: 'rgba(255,255,255,0.06)',
              borderRadius: 10,
              padding: '8px 10px',
              textAlign: 'center',
            }}>
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', fontWeight: 600, marginBottom: 2 }}>ETA</div>
              <div style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                {Math.round(activeEtaSeconds / 60)}m
              </div>
            </div>
            <div style={{
              background: 'rgba(255,255,255,0.06)',
              borderRadius: 10,
              padding: '8px 10px',
              textAlign: 'center',
            }}>
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', fontWeight: 600, marginBottom: 2 }}>DIST</div>
              <div style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                {(activeDistanceMeters / 1000).toFixed(1)}km
              </div>
            </div>
            <div style={{
              background: 'rgba(255,255,255,0.06)',
              borderRadius: 10,
              padding: '8px 10px',
              textAlign: 'center',
            }}>
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', fontWeight: 600, marginBottom: 2 }}>RATING</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#fbbf24' }}>
                {selectedHospital.rating ? `${selectedHospital.rating}★` : '—'}
              </div>
            </div>
          </div>

          {/* Progress bar */}
          <div style={{
            marginTop: 10,
            background: 'rgba(255,255,255,0.08)',
            borderRadius: 6,
            height: 6,
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: `${Math.round(ambulanceProgress * 100)}%`,
              background: 'linear-gradient(90deg, #22c55e, #16a34a)',
              borderRadius: 6,
              transition: 'width 0.15s ease',
            }} />
          </div>
          <div style={{
            fontSize: 10,
            color: 'rgba(255,255,255,0.4)',
            marginTop: 4,
            textAlign: 'center',
            fontVariantNumeric: 'tabular-nums',
          }}>
            {Math.round(ambulanceProgress * 100)}% completed
          </div>
        </div>
      )}

      {/* Controls */}
      {phase === 'ready' && (
        <div style={{
          padding: '12px 20px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              id="dispatch-play-btn"
              onClick={isSimulating ? pauseSimulation : startSimulation}
              style={{
                flex: 1,
                padding: '10px 0',
                borderRadius: 10,
                border: 'none',
                fontWeight: 700,
                fontSize: 13,
                cursor: 'pointer',
                background: isSimulating
                  ? 'linear-gradient(135deg, #f97316, #ef4444)'
                  : 'linear-gradient(135deg, #22c55e, #16a34a)',
                color: '#fff',
                transition: 'all 0.15s',
              }}
            >
              {isSimulating ? '⏸ Pause' : '▶ Dispatch'}
            </button>
            <button
              id="dispatch-reset-btn"
              onClick={resetSimulation}
              style={{
                padding: '10px 16px',
                borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'rgba(255,255,255,0.06)',
                color: '#fff',
                fontWeight: 600,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              ↻
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[1, 2, 5, 10].map(s => (
              <button
                key={s}
                id={`dispatch-speed-${s}x`}
                onClick={() => onSpeedChange(s)}
                style={{
                  flex: 1,
                  padding: '5px 0',
                  borderRadius: 8,
                  border: speed === s ? '1px solid #22c55e' : '1px solid rgba(255,255,255,0.1)',
                  background: speed === s ? 'rgba(34,197,94,0.2)' : 'rgba(255,255,255,0.04)',
                  color: speed === s ? '#22c55e' : 'rgba(255,255,255,0.5)',
                  fontWeight: 700,
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Filter tabs */}
      {phase === 'ready' && (
        <div style={{
          display: 'flex',
          gap: 4,
          padding: '10px 20px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}>
          <button
            id="filter-all"
            onClick={() => setFilter('all')}
            style={{
              flex: 1,
              padding: '7px 0',
              borderRadius: 8,
              border: 'none',
              background: filter === 'all' ? 'rgba(99,102,241,0.2)' : 'transparent',
              color: filter === 'all' ? '#818cf8' : 'rgba(255,255,255,0.45)',
              fontWeight: 600,
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            All ({hospitals.length})
          </button>
          <button
            id="filter-on-route"
            onClick={() => setFilter('on-route')}
            style={{
              flex: 1,
              padding: '7px 0',
              borderRadius: 8,
              border: 'none',
              background: filter === 'on-route' ? 'rgba(34,197,94,0.2)' : 'transparent',
              color: filter === 'on-route' ? '#22c55e' : 'rgba(255,255,255,0.45)',
              fontWeight: 600,
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            On Route ({onRouteHospitals.length})
          </button>
        </div>
      )}

      {/* Hospital list */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '4px 12px',
      }}>
        {displayHospitals.map((h) => (
          <HospitalCard
            key={h.place_id}
            hospital={h}
            isSelected={h.place_id === selectedHospital?.place_id}
            onClick={() => selectHospital(h)}
          />
        ))}

        {phase === 'ready' && displayHospitals.length === 0 && (
          <div style={{
            textAlign: 'center',
            padding: '40px 20px',
            color: 'rgba(255,255,255,0.35)',
            fontSize: 13,
          }}>
            No hospitals match the current filter.
          </div>
        )}
      </div>

      {/* Refresh button at bottom */}
      {phase === 'ready' && (
        <div style={{
          padding: '12px 20px',
          borderTop: '1px solid rgba(255,255,255,0.08)',
        }}>
          <button
            id="dispatch-refresh"
            onClick={dispatch.refreshHospitals}
            style={{
              width: '100%',
              padding: '10px',
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.1)',
              background: 'rgba(255,255,255,0.04)',
              color: 'rgba(255,255,255,0.6)',
              fontWeight: 600,
              fontSize: 12,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
            }}
          >
            🔄 Refresh Hospitals
          </button>
        </div>
      )}

      <style>{`
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HospitalCard
// ---------------------------------------------------------------------------
function HospitalCard({
  hospital,
  isSelected,
  onClick,
}: {
  hospital: Hospital;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      id={`hospital-${hospital.place_id}`}
      onClick={onClick}
      style={{
        width: '100%',
        textAlign: 'left',
        padding: '12px 14px',
        margin: '3px 0',
        borderRadius: 14,
        border: isSelected
          ? '1px solid rgba(220, 38, 38, 0.5)'
          : '1px solid rgba(255,255,255,0.06)',
        background: isSelected
          ? 'rgba(220, 38, 38, 0.12)'
          : 'rgba(255,255,255,0.03)',
        color: '#fff',
        cursor: 'pointer',
        transition: 'all 0.15s ease',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        fontFamily: "'Inter', sans-serif",
      }}
      onMouseEnter={(e) => {
        if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)';
      }}
      onMouseLeave={(e) => {
        if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{
          fontSize: 13,
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          <span style={{ fontSize: 16 }}>🏥</span>
          {hospital.name.length > 28 ? hospital.name.slice(0, 28) + '…' : hospital.name}
        </div>
        {hospital.onRoute && (
          <span style={{
            fontSize: 9,
            fontWeight: 700,
            padding: '2px 6px',
            borderRadius: 6,
            background: 'rgba(34,197,94,0.2)',
            color: '#22c55e',
          }}>
            ON ROUTE
          </span>
        )}
      </div>

      <div style={{
        fontSize: 11,
        color: 'rgba(255,255,255,0.45)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        📍 {hospital.address}
      </div>

      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontSize: 11,
        color: 'rgba(255,255,255,0.55)',
      }}>
        {hospital.rating && (
          <span>⭐ {hospital.rating}</span>
        )}
        <span style={{ color: '#22c55e', fontWeight: 600 }}>
          {hospital.distanceKm.toFixed(1)} km
        </span>
        {hospital.etaSeconds > 0 && (
          <span style={{ color: '#60a5fa' }}>
            ~{Math.round(hospital.etaSeconds / 60)} min
          </span>
        )}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Loading overlay
// ---------------------------------------------------------------------------
function LoadingOverlay({ phase, message }: { phase: string; message?: string | null }) {
  let text = 'Initializing…';
  if (phase === 'locating') text = '📍 Detecting your location…';
  else if (phase === 'fetching_hospitals') text = '🏥 Fetching nearby hospitals…';
  else if (phase === 'routing') text = '🗺️ Computing driving routes…';
  else if (phase === 'error') text = `❌ ${message || 'Something went wrong'}`;

  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      zIndex: 50,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(10, 10, 25, 0.85)',
      backdropFilter: 'blur(12px)',
      color: '#fff',
      fontFamily: "'Inter', sans-serif",
    }}>
      {phase !== 'error' && (
        <div style={{
          width: 56,
          height: 56,
          border: '3px solid rgba(255,255,255,0.1)',
          borderTopColor: '#22c55e',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
          marginBottom: 20,
        }} />
      )}
      <div style={{
        fontSize: 16,
        fontWeight: 600,
        letterSpacing: 0.3,
        marginBottom: 8,
      }}>
        {text}
      </div>
      {phase === 'routing' && (
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>
          Fetching real routes from Google Directions API…
        </div>
      )}
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------
function Legend() {
  const items = [
    { color: '#fff', border: '#dc2626', label: 'Ambulance' },
    { color: '#3b82f6', border: '#fff', label: 'Your Location' },
    { color: 'linear-gradient(135deg, #dc2626, #ef4444)', border: 'none', label: 'Selected Hospital', dot: false },
    { color: 'linear-gradient(135deg, #059669, #10b981)', border: 'none', label: 'On-Route Hospital', dot: false },
    { color: 'linear-gradient(135deg, #6366f1, #8b5cf6)', border: 'none', label: 'Other Hospital', dot: false },
  ];

  return (
    <div style={{
      position: 'absolute',
      bottom: 24,
      right: 20,
      zIndex: 20,
      background: 'rgba(10, 10, 25, 0.88)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: 12,
      padding: '12px 16px',
      color: '#fff',
      fontFamily: "'Inter', sans-serif",
      boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
    }}>
      <div style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 1.5,
        color: 'rgba(255,255,255,0.35)',
        marginBottom: 6,
        textTransform: 'uppercase',
      }}>
        Legend
      </div>
      {items.map(item => (
        <div key={item.label} style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 3,
          fontSize: 11,
          color: 'rgba(255,255,255,0.7)',
        }}>
          <div style={{
            width: 14,
            height: 14,
            borderRadius: item.dot === false ? 8 : '50%',
            background: item.color,
            border: item.border !== 'none' ? `2px solid ${item.border}` : 'none',
            flexShrink: 0,
          }} />
          {item.label}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AmbulanceDispatchMap — public component
// ---------------------------------------------------------------------------
interface AmbulanceDispatchMapProps {
  apiKey: string;
}

export default function AmbulanceDispatchMap({ apiKey }: AmbulanceDispatchMapProps) {
  const dispatch = useAmbulanceDispatch();
  const [speed, setSpeed] = useState(1);

  const handleSpeedChange = useCallback((s: number) => {
    setSpeed(s);
    dispatch.setSimSpeed(s);
  }, [dispatch]);

  const isLoading = dispatch.phase !== 'ready' && dispatch.phase !== 'error';

  return (
    <div style={{
      width: '100%',
      height: '100%',
      position: 'relative',
      background: '#0a0a14',
    }}>
      <Map
        defaultCenter={{ lat: 26.8467, lng: 80.9462 }}
        defaultZoom={12}
        mapId="sipra-dispatch-map"
        gestureHandling="greedy"
        disableDefaultUI
        style={{ width: '100%', height: '100%' }}
      >
        <MapLayers
          activeRoute={dispatch.activeRoute}
          ambulancePosition={dispatch.ambulancePosition}
          ambulanceProgress={dispatch.ambulanceProgress}
          hospitals={dispatch.hospitals}
          selectedHospitalId={dispatch.selectedHospital?.place_id ?? null}
        />

        {/* Hospital markers */}
        <HospitalMarkers
          hospitals={dispatch.hospitals}
          selectedHospitalId={dispatch.selectedHospital?.place_id ?? null}
          onSelect={dispatch.selectHospital}
        />

        {/* User location marker */}
        {dispatch.userLocation && (
          <UserLocationMarker position={dispatch.userLocation} />
        )}
      </Map>

      {/* Sidebar */}
      <Sidebar
        dispatch={dispatch}
        speed={speed}
        onSpeedChange={handleSpeedChange}
      />

      {/* Legend */}
      <Legend />

      {/* Loading overlay */}
      {isLoading && <LoadingOverlay phase={dispatch.phase} message={dispatch.errorMessage} />}
    </div>
  );
}
