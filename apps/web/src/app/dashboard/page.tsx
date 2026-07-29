
import { Suspense } from "react";
import { PageShell } from "@/components/page-shell";
import { LoadingState } from "@/components/loading-state";
import { StatsCard } from "@/components/stats-card";
import { RecentMigrations } from "@/components/recent-migrations";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import Link from "next/link";

export default function DashboardPage() {
  return (
    <PageShell
      title="Dashboard"
      subtitle="Overview of repositories, migrations, and health."
      actions={
        <Link href="/repositories">
          <Button size="sm"><Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Add Repository</Button>
        </Link>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatsCard label="Repositories" value={"0"} />
        <StatsCard label="Migrations" value={"0"} />
        <StatsCard label="Pending Review" value={"0"} />
        <StatsCard label="Success Rate" value={"—"} />
      </div>
      <Suspense fallback={<LoadingState message="Loading recent migrations..." />}>
        <RecentMigrations />
      </Suspense>
    </PageShell>
  );
}
