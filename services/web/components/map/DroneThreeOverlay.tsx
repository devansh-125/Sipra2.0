'use client';

import { useEffect, useRef } from 'react';
import { AdvancedMarker, AdvancedMarkerAnchorPoint } from '@vis.gl/react-google-maps';
import * as THREE from 'three';

// Canvas size for the 3D drone render (square, in CSS px).
const CANVAS_PX = 200;

// ---------------------------------------------------------------------------
// Three.js drone scene — built entirely from primitive geometries.
// ---------------------------------------------------------------------------
function buildDroneScene(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setSize(CANVAS_PX, CANVAS_PX);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0, 0);

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(3.0, 4.2, 3.0);
  camera.lookAt(0, 0, 0);

  // Lighting
  scene.add(new THREE.AmbientLight(0xd8b4fe, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(5, 9, 5);
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x7c3aed, 0.5);
  rim.position.set(-4, -3, -4);
  scene.add(rim);

  const droneGroup = new THREE.Group();
  scene.add(droneGroup);

  // ── Body ─────────────────────────────────────────────────────────────────
  droneGroup.add(new THREE.Mesh(
    new THREE.BoxGeometry(0.55, 0.14, 0.55),
    new THREE.MeshPhongMaterial({ color: 0x6d28d9, shininess: 90, specular: 0xa78bfa }),
  ));

  // Top accent stripe
  const stripe = new THREE.Mesh(
    new THREE.BoxGeometry(0.57, 0.04, 0.22),
    new THREE.MeshPhongMaterial({ color: 0x8b5cf6 }),
  );
  stripe.position.set(0, 0.09, 0);
  droneGroup.add(stripe);

  // ── Camera pod ────────────────────────────────────────────────────────────
  const pod = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 10, 10),
    new THREE.MeshPhongMaterial({ color: 0x0f0c29, shininess: 180, specular: 0x6060cc }),
  );
  pod.position.set(0, -0.11, 0.12);
  droneGroup.add(pod);

  const glare = new THREE.Mesh(
    new THREE.CircleGeometry(0.035, 8),
    new THREE.MeshBasicMaterial({ color: 0xddd6fe, transparent: true, opacity: 0.8 }),
  );
  glare.position.set(0.03, -0.065, 0.207);
  glare.rotation.x = -0.35;
  droneGroup.add(glare);

  // ── Arms + motor hubs + propellers ───────────────────────────────────────
  const armMat   = new THREE.MeshPhongMaterial({ color: 0x7c3aed });
  const motorMat = new THREE.MeshPhongMaterial({ color: 0x4c1d95, shininess: 50 });
  const propellers: THREE.Mesh[] = [];

  ([[1, 1], [-1, 1], [1, -1], [-1, -1]] as [number, number][]).forEach(([dx, dz]) => {
    const R = 0.48;
    const ex = dx * R;
    const ez = dz * R;

    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.62), armMat);
    arm.position.set(ex * 0.5, 0.02, ez * 0.5);
    arm.rotation.y = Math.atan2(dx, dz);
    droneGroup.add(arm);

    const motor = new THREE.Mesh(
      new THREE.CylinderGeometry(0.065, 0.07, 0.1, 10),
      motorMat,
    );
    motor.position.set(ex, 0.04, ez);
    droneGroup.add(motor);

    const prop = new THREE.Mesh(
      new THREE.CylinderGeometry(0.26, 0.26, 0.012, 24),
      new THREE.MeshPhongMaterial({
        color: 0xa78bfa, transparent: true, opacity: 0.84, side: THREE.DoubleSide,
      }),
    );
    prop.position.set(ex, 0.11, ez);
    droneGroup.add(prop);
    propellers.push(prop);
  });

  // ── Landing legs ─────────────────────────────────────────────────────────
  const legMat = new THREE.MeshPhongMaterial({ color: 0x5b21b6 });
  ([-0.22, 0.22] as number[]).forEach(x => {
    const leg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.018, 0.018, 0.22, 6),
      legMat,
    );
    leg.rotation.z = (x < 0 ? 1 : -1) * 0.28;
    leg.position.set(x, -0.17, 0);
    droneGroup.add(leg);
  });

  // ── Pulsing glow ring beneath the drone ──────────────────────────────────
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x7c3aed, transparent: true, opacity: 0.35, side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.06, 8, 32), ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.42;
  scene.add(ring);

  return { renderer, scene, camera, droneGroup, propellers, ringMat };
}

// ---------------------------------------------------------------------------
// DroneScene — renders Three.js onto the canvas ref, reacts to bearing changes.
// Mounted/unmounted by the parent; lifecycle === Three.js lifecycle.
// ---------------------------------------------------------------------------
function DroneScene({ bearingDeg }: { bearingDeg: number }) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const bearingRef = useRef(bearingDeg);

  // Keep bearing up-to-date without restarting the render loop.
  useEffect(() => { bearingRef.current = bearingDeg; }, [bearingDeg]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { renderer, scene, camera, droneGroup, propellers, ringMat } = buildDroneScene(canvas);

    let rafId: number;
    let prevBearing = bearingRef.current;

    const animate = (time: number) => {
      const bd = bearingRef.current;

      // Tilt nose forward when bearing is changing (drone is moving).
      const moving = Math.abs(bd - prevBearing) > 0.001;
      droneGroup.rotation.x = THREE.MathUtils.lerp(
        droneGroup.rotation.x,
        moving ? 0.2 : 0.0,
        0.04,
      );
      prevBearing = bd;

      // Gentle hover bob.
      droneGroup.position.y = Math.sin(time * 0.0025) * 0.055;

      // Heading yaw — smoothly rotate to face travel direction.
      const targetYaw = -(bd * Math.PI / 180);
      const dy = targetYaw - droneGroup.rotation.y;
      droneGroup.rotation.y += ((((dy % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) * 0.07;

      // Spin propellers (alternating CW/CCW).
      propellers.forEach((prop, i) => {
        prop.rotation.y += 0.28 * (i % 2 === 0 ? 1 : -1);
      });

      // Pulse glow ring.
      ringMat.opacity = 0.15 + Math.sin(time * 0.004) * 0.15;

      renderer.render(scene, camera);
      rafId = requestAnimationFrame(animate);
    };

    rafId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafId);
      scene.traverse(obj => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) {
            obj.material.forEach(m => m.dispose());
          } else {
            (obj.material as THREE.Material).dispose();
          }
        }
      });
      renderer.dispose();
    };
  }, []); // canvas never changes; bearingRef handles heading updates

  return (
    <canvas
      ref={canvasRef}
      width={CANVAS_PX}
      height={CANVAS_PX}
      style={{ display: 'block', pointerEvents: 'none' }}
    />
  );
}

// ---------------------------------------------------------------------------
// Public component — renders an <AdvancedMarker> at the drone's position.
// AdvancedMarker sits in Google Maps' topmost pane (above all Deck.gl layers),
// so the Three.js canvas is always visible.
// ---------------------------------------------------------------------------
interface DroneThreeOverlayProps {
  lat: number;
  lng: number;
  bearingDeg: number;
  active: boolean;
}

export default function DroneThreeOverlay({ lat, lng, bearingDeg, active }: DroneThreeOverlayProps) {
  if (!active) return null;

  return (
    <AdvancedMarker
      position={{ lat, lng }}
      anchorPoint={AdvancedMarkerAnchorPoint.CENTER}
    >
      <DroneScene bearingDeg={bearingDeg} />
    </AdvancedMarker>
  );
}
