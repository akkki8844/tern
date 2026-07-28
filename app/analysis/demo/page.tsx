export default function DemoAnalysisPage() {
  return (
    <main className="mx-auto w-full max-w-5xl p-6">
      <h1 className="text-2xl font-semibold">AcmePay demo mode</h1>
      <p className="mt-2 text-zinc-400">Runs full analysis, migration preview, test simulation, and PR output without GitHub credentials.</p>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="font-medium">PR output</h2>
          <p className="text-sm text-zinc-300">fix: migrate for AcmePay breaking API change</p>
          <p className="text-xs text-zinc-500">tern/api-migration-&lt;timestamp&gt;</p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="font-medium">Test result</h2>
          <p className="text-sm text-emerald-400">All AcmePay migration checks passed</p>
        </div>
      </div>
    </main>
  );
}
