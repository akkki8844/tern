import { PageShell } from "../components/page-shell";
import { StatsCard } from "../components/stats-card";
import { Card, CardHeader, CardTitle, CardContent } from "../components/card";

export default function DashboardPage() {
  return (
    <PageShell>
      <h1 className="text-3xl font-bold">Dashboard</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatsCard title="Repositories" value="0" subtitle="Connected GitHub repos" />
        <StatsCard title="Migrations" value="0" subtitle="Total pipeline runs" />
        <StatsCard title="API Compatibility" value="100%" subtitle="Current spec coverage" />
      </div>
      <Card>
        <CardHeader><CardTitle>Recent Activity</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">No recent activity. Connect a repository and start an analysis.</p></CardContent>
      </Card>
    </PageShell>
  );
}
