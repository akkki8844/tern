
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PageShell } from "@/components/page-shell";
import { ArrowRight, GitBranch, Shield, Zap } from "lucide-react";

export default function HomePage() {
  return (
    <PageShell title="Tern" subtitle="Automatically migrate your TypeScript repositories when OpenAPI specifications change.">
      <div className="grid gap-6 md:grid-cols-3">
        <FeatureCard
          icon={GitBranch}
          title="Detect API changes"
          description="Compare OpenAPI specs and pinpoint breaking changes before they reach production."
        />
        <FeatureCard
          icon={Zap}
          title="Migrate code"
          description="Apply deterministic, validated patches to TypeScript call sites and SDKs."
        />
        <FeatureCard
          icon={Shield}
          title="Stay safe"
          description="Every patch is sandboxed, validated, and reviewed by your team before merging."
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/dashboard">
          <Button size="lg">Open Dashboard <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" /></Button>
        </Link>
        <Link href="/repositories">
          <Button variant="outline" size="lg">Connect Repository</Button>
        </Link>
      </div>
    </PageShell>
  );
}

function FeatureCard({ icon: Icon, title, description }: { icon: React.ElementType; title: string; description: string }) {
  return (
    <div className="rounded-2xl border bg-card p-6 shadow-sm">
      <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
        <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
      </div>
      <h3 className="font-semibold mb-1">{title}</h3>
      <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
    </div>
  );
}
