
import Link from "next/link";

export default function LandingPage() {
  return (
    <div className="flex min-h-[80vh] flex-col items-center justify-center text-center">
      <h1 className="text-6xl font-bold tracking-tight">Tern</h1>
      <p className="mt-4 max-w-xl text-lg text-neutral-400">Detect breaking OpenAPI changes, find affected code, and generate tested migration patches — automatically.</p>
      <div className="mt-8 flex gap-4">
        <Link href="/dashboard" className="rounded-md bg-white px-6 py-3 text-sm font-medium text-neutral-950 hover:bg-neutral-200 transition">Open Dashboard</Link>
        <a href="https://github.com/apps/tern" className="rounded-md border border-neutral-700 px-6 py-3 text-sm font-medium hover:border-neutral-500 transition">Install GitHub App</a>
      </div>
    </div>
  );
}
