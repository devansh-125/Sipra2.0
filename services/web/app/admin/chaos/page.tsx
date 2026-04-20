import ChaosPanel from '../../../components/chaos/ChaosPanel';

export default function ChaosDemoPage() {
  if (process.env.NEXT_PUBLIC_CHAOS_ENABLED !== 'true') {
    return (
      <div className="flex h-[calc(100vh-49px)] items-center justify-center">
        <div className="text-center space-y-2 px-4">
          <p className="text-muted-foreground font-mono text-sm">
            Chaos disabled — set{' '}
            <span className="text-foreground">NEXT_PUBLIC_CHAOS_ENABLED=true</span> to
            enable
          </p>
          <p className="text-muted-foreground font-mono text-xs">
            Also requires backend: <span className="text-foreground">CHAOS_ENABLED=true</span>
          </p>
        </div>
      </div>
    );
  }

  return <ChaosPanel />;
}
