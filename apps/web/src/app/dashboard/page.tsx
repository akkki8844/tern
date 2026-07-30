import React from "react";
import { PageShell } from "@/components/page-shell";
import { StatsCard } from "@/components/stats-card";
import { RecentMigrations } from "@/components/recent-migrations";

export default function DashboardPage() {
  return (
    <PageShell>
      <h1 className="text-3xl font-bold">Dashboard</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatsCard title="Repositories" value="0" />
        <StatsCard title="Migrations" value="0" />
        <StatsCard title="API Compatibility" value="100%" />
      </div>
      <RecentMigrations />
    </PageShell>
  );
}
