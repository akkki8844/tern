
import { Suspense } from "react";
import { PageShell } from "@/components/page-shell";
import { LoadingState } from "@/components/loading-state";
import { MigrationList } from "@/components/migration-list";

export default function MigrationsPage() {
  return (
    <PageShell title="Migrations" subtitle="Tracked OpenAPI migration runs.">
      <Suspense fallback={<LoadingState message="Loading migrations..." />}>
        <MigrationList />
      </Suspense>
    </PageShell>
  );
}
