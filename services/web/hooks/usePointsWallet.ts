'use client';

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'sipra.points';

export interface PointsWallet {
  points: number;
  add: (n: number) => void;
}

export function usePointsWallet(): PointsWallet {
  const [points, setPoints] = useState(0);

  // SSR-safe: read localStorage only on the client after mount.
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) {
      const parsed = parseInt(stored, 10);
      if (!isNaN(parsed)) setPoints(parsed);
    }
  }, []);

  const add = useCallback((n: number) => {
    setPoints(prev => {
      const next = prev + n;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  return { points, add };
}
