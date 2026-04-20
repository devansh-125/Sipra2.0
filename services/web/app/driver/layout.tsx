import type { Viewport } from 'next';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function DriverLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-[420px] mx-auto pb-[env(safe-area-inset-bottom)]">
      {children}
    </div>
  );
}
