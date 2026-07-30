import React from "react";
import { PageShell } from "@/components/page-shell";
import { MigrationList } from "@/components/migration-list";

export default function MigrationsPage() {
  return (
    <PageShell>
      <h1 className="text-3xl font-bold">Migrations</h1>
      <MigrationList />
    </PageShell>
  );
}
