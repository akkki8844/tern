import { PageShell } from "./components/page-shell";
import { Button } from "./components/button";
import { GitBranch, ArrowRight } from "lucide-react";
import Link from "next/link";

export default function LandingPage() {
  return (
    <PageShell>
      <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
        <h1 className="text-5xl font-bold tracking-tight">Tern</h1>
        <p className="mt-4 max-w-xl text-lg text-muted-foreground">
          Detect breaking OpenAPI changes, find affected code, and generate tested migration patches — automatically.
        </p>
        <div className="mt-8 flex gap-3">
          <Button size="lg">
            <Link href="/dashboard" className="flex items-center">
              <GitBranch className="mr-2 h-4 w-4" />
              Open Dashboard
            </Link>
          </Button>
          <Button variant="outline" size="lg">
            <Link href="/analysis" className="flex items-center">
              Start Analysis
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
