export default function CreateAnalysisPage() {
  return (
    <main className="mx-auto w-full max-w-3xl p-6">
      <h1 className="text-2xl font-semibold">Create analysis</h1>
      <p className="mt-3 text-zinc-400">Connect previous and current OpenAPI specs (URL or upload) for one API provider.</p>
      <div className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-300">
        Demo inputs are preloaded for AcmePay in demo mode.
      </div>
    </main>
  );
}
