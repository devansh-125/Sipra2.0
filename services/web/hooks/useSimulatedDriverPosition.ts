import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';

interface LatLng {
  lat: number;
  lng: number;
}

export function useSimulatedDriverPosition(
  center: LatLng,
  radiusM: number = 500,
  tickMs: number = 1000,
): LatLng {
  const searchParams = useSearchParams();
  const overrideLat = searchParams.get('lat');
  const overrideLng = searchParams.get('lng');

  const startRef = useRef(Date.now());
  const [position, setPosition] = useState<LatLng>(center);

  useEffect(() => {
    const parsedLat = overrideLat !== null ? parseFloat(overrideLat) : NaN;
    const parsedLng = overrideLng !== null ? parseFloat(overrideLng) : NaN;

    if (!isNaN(parsedLat) && !isNaN(parsedLng)) {
      setPosition({ lat: parsedLat, lng: parsedLng });
      return;
    }

    const tick = () => {
      const elapsed = (Date.now() - startRef.current) / 1000;
      const angle = (2 * Math.PI * elapsed) / 60;
      const latOff = (radiusM / 111320) * Math.sin(angle);
      const lngOff =
        (radiusM / (111320 * Math.cos((center.lat * Math.PI) / 180))) * Math.cos(angle);
      setPosition({ lat: center.lat + latOff, lng: center.lng + lngOff });
    };

    tick();
    const id = setInterval(tick, tickMs);
    return () => clearInterval(id);
  }, [center.lat, center.lng, radiusM, tickMs, overrideLat, overrideLng]);

  return position;
}
