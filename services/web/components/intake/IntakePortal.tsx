export default function IntakePortal() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
      <section className="max-w-2xl w-full rounded-2xl border border-slate-800 bg-slate-900/60 backdrop-blur-sm shadow-[0_0_40px_-10px_rgba(239,68,68,0.25)] p-8">
        <h1 className="text-2xl font-semibold tracking-tight">Hospital Intake Portal</h1>
        <p className="mt-2 text-sm text-slate-400">
          Authorize a critical corridor for medical transit.
        </p>
        <button
          type="button"
          disabled
          className="mt-8 w-full rounded-md bg-red-600/70 text-white uppercase tracking-[0.3em] font-semibold py-4 text-sm disabled:opacity-60 disabled:cursor-not-allowed"
        >
          Initiate Critical Corridor
        </button>
      </section>
    </main>
  );
}
