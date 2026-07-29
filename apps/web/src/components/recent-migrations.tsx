
import { EmptyState } from "@/components/empty-state";
import { GitBranch } from "lucide-react";

export async function RecentMigrations() {
  const migrations: any[] = [];
  if (migrations.length === 0) {
    return (
      <div className="mt-4">
        <EmptyState
          icon={GitBranch}
          title="No migrations yet"
          description="Connect a repository and push an OpenAPI spec change to trigger your first migration."
        />
      </div>
    );
  }
  return (
    <div className="rounded-2xl border bg-card">
      <ul className="divide-y">
        {migrations.map((m) => (
          <li key={m.id} className="px-5 py-4 flex items-center justify-between">
            <div>
              <div className="font-medium">{m.title}</div>
              <div className="text-sm text-muted-foreground">{m.repo}</div>
            </div>
            <div className="text-sm text-muted-foreground">{m.status}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
