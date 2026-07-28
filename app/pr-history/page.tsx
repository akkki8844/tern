export default function PrHistoryPage() {
  return (
    <main className="mx-auto w-full max-w-4xl p-6">
      <h1 className="text-2xl font-semibold">PR history</h1>
      <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <p>#42 fix: migrate for AcmePay breaking API change</p>
        <p className="text-sm text-zinc-400">Status: open · Human review required</p>
      </div>
    </main>
  );
}
