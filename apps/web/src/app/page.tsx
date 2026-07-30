import React from "react";
import { PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import { GitBranch, ArrowRight } from "lucide-react";
import Link from "next/link";

export default function Home() {
  return (
    <PageShell>
      <div className="space-y-4">
        <h1 className="text-4xl font-bold tracking-tight">Tern</h1>
        <p className="text-xl text-muted-foreground">The safest automated API migration system.</p>
        <div className="flex gap-3">
          <Button >
            <Link href="/repositories">
              <GitBranch className="mr-2 h-4 w-4" />
              Connect Repository
            </Link>
          </Button>
          <Button variant="outline" >
            <Link href="/migrations">
              View Migrations
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
