
import { EmptyState } from "@/components/empty-state";
import { GitBranch } from "lucide-react";

export async function MigrationList() {
  const migrations: any[] = [];
  if (migrations.length === 0) {
    return (
      <EmptyState
        icon={GitBranch}
        title="No migrations yet"
        description="When a connected repository detects an OpenAPI change, Tern will run a migration and display it here."
      />
    );
  }
  return (
    <div className="grid gap-4">
      {migrations.map((m) => (
        <div key={m.id} className="rounded-2xl border bg-card p-5">
          <div className="flex items-center justify-between">
            <div className="font-medium">{m.title}</div>
            <div className="text-xs uppercase tracking-wider font-medium text-muted-foreground">{m.status}</div>
          </div>
          <div className="text-sm text-muted-foreground mt-1">{m.repo}</div>
        </div>
      ))}
    </div>
  );
}
