import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-6 py-14">
      <div className="space-y-4">
        <p className="text-sm uppercase tracking-widest text-emerald-400">Tern</p>
        <h1 className="text-4xl font-semibold">When an API changes, Tern finds the broken code and opens the fix.</h1>
        <p className="max-w-2xl text-zinc-400">API changed → 3 usages found → PR opened → tests passed</p>
      </div>
      <div className="grid gap-4 rounded-xl border border-zinc-800 bg-zinc-900 p-6 md:grid-cols-2">
        <Link href="/dashboard" className="rounded-lg border border-zinc-700 p-4 hover:border-emerald-400">Open dashboard</Link>
        <Link href="/analysis/demo" className="rounded-lg border border-zinc-700 p-4 hover:border-emerald-400">Run AcmePay demo mode</Link>
      </div>
    </main>
  );
}
