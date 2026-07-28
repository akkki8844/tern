export default function RepositoriesPage() {
  return (
    <main className="mx-auto w-full max-w-5xl p-6">
      <h1 className="text-2xl font-semibold">Connected repositories</h1>
      <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <p>acme-inc/payments-service</p>
        <p className="text-sm text-zinc-400">GitHub App installation scoped to this repository only.</p>
      </div>
    </main>
  );
}
