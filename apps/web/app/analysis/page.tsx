
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function AnalysisPage() {
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const res = await fetch("/api/analyze", { method: "POST", body: JSON.stringify({ owner, repo, oldSpecPath: "demo/acmepay-openapi-old.yaml", newSpecPath: "demo/acmepay-openapi-new.yaml" }), headers: { "Content-Type": "application/json" } });
    const data = await res.json();
    setLoading(false);
    if (data.id) router.push(`/analysis/${data.id}`);
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold">Create Analysis</h1>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <div>
          <label className="block text-sm text-neutral-400">Owner</label>
          <input value={owner} onChange={e => setOwner(e.target.value)} className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500" placeholder="tern-demo" />
        </div>
        <div>
          <label className="block text-sm text-neutral-400">Repository</label>
          <input value={repo} onChange={e => setRepo(e.target.value)} className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500" placeholder="acmepay-demo" />
        </div>
        <button disabled={loading} className="rounded-md bg-white px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-neutral-200 disabled:opacity-50">{loading ? "Starting..." : "Start Analysis"}</button>
      </form>
    </div>
  );
}
