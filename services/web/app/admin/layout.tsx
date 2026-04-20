import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Sipra — Admin Chaos Panel',
  description: 'Dev/judge chaos injection panel. Gated on NEXT_PUBLIC_CHAOS_ENABLED.',
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="shrink-0 border-b border-border px-6 py-3 flex items-center gap-3">
        <span className="font-mono text-xs text-muted-foreground uppercase tracking-widest">
          Sipra
        </span>
        <span className="text-border">·</span>
        <span className="font-mono text-xs text-destructive-foreground uppercase tracking-widest">
          Admin
        </span>
      </header>
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
