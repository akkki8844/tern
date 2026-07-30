"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PageShell } from "../components/page-shell";
import { Button } from "../components/button";
import { Card, CardHeader, CardTitle, CardContent } from "../components/card";
import { Input } from "../components/input";
import { Label } from "../components/label";

export default function AnalysisPage() {
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [installationId, setInstallationId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        body: JSON.stringify({ owner, repo, installationId: Number(installationId), oldSpecPath: "demo/acmepay-openapi-v1.yaml", newSpecPath: "demo/acmepay-openapi-v2.yaml" }),
        headers: { "Content-Type": "application/json" }
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else if (data.id) {
        router.push(`/analysis/${data.id}`);
      }
    } catch {
      setError("Failed to start analysis");
    } finally {
      setLoading(false);
    }
  }

  return (
    <PageShell>
      <h1 className="text-3xl font-bold">Create Analysis</h1>
      <Card className="max-w-xl">
        <CardHeader><CardTitle>Repository Details</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="owner">Owner</Label>
              <Input id="owner" value={owner} onChange={e => setOwner(e.target.value)} placeholder="tern-demo" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="repo">Repository</Label>
              <Input id="repo" value={repo} onChange={e => setRepo(e.target.value)} placeholder="acmepay-demo" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="installationId">Installation ID</Label>
              <Input id="installationId" value={installationId} onChange={e => setInstallationId(e.target.value)} placeholder="123456" />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button disabled={loading} className="w-full">{loading ? "Starting..." : "Start Analysis"}</Button>
          </form>
        </CardContent>
      </Card>
    </PageShell>
  );
}
