import { PageShell } from "../components/page-shell";
import { StatsCard } from "../components/stats-card";
import { Card, CardHeader, CardTitle, CardContent } from "../components/card";
import { dashboardStats, type DataResult, type DashboardStats } from "../_data";

export const dynamic = "force-dynamic";

function Degraded({ reason }: { reason: string }) {
  return (
    <Card>
      <CardHeader><CardTitle>Dashboard unavailable</CardTitle></CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Live statistics could not be loaded because the database is not reachable.
          The worker, API and webhook intake are unaffected by this page.
        </p>
        <p className="mt-2 font-mono text-xs text-muted-foreground/70 break-all">{reason}</p>
      </CardContent>
    </Card>
  );
}

export default async function DashboardPage() {
  const result: DataResult<DashboardStats> = await dashboardStats();

  if (!result.ok) {
    return (
      <PageShell>
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <Degraded reason={result.reason} />
      </PageShell>
    );
  }

  const { repositories, analysisRuns, pullRequests, recentRuns } = result.data;

  return (
    <PageShell>
      <h1 className="text-3xl font-bold">Dashboard</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatsCard title="Repositories" value={String(repositories)} subtitle="Connected GitHub repos" />
        <StatsCard title="Migrations" value={String(analysisRuns)} subtitle="Total pipeline runs" />
        <StatsCard title="Pull requests" value={String(pullRequests)} subtitle="Draft PRs opened for review" />
      </div>
      <Card>
        <CardHeader><CardTitle>Recent Activity</CardTitle></CardHeader>
        <CardContent>
          {recentRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No recent activity. Connect a repository and start an analysis.
            </p>
          ) : (
            <ul className="space-y-2">
              {recentRuns.map((run) => (
                <li key={run.id} className="flex items-center justify-between text-sm">
                  <a href={`/analysis/${run.id}`} className="font-mono text-xs hover:underline">
                    {run.repository.owner}/{run.repository.name}
                  </a>
                  <span className="text-muted-foreground">{run.status.toLowerCase()}</span>
                  <span className="text-xs text-muted-foreground/70">
                    {run.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}
