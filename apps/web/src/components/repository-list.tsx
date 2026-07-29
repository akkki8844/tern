
import { EmptyState } from "@/components/empty-state";
import { Building2 } from "lucide-react";

export async function RepositoryList() {
  const repos: any[] = [];
  if (repos.length === 0) {
    return (
      <EmptyState
        icon={Building2}
        title="No repositories connected"
        description="Install the Tern GitHub App to select repositories and start monitoring OpenAPI changes."
        actionLabel="Install GitHub App"
        onAction={() => {}}
      />
    );
  }
  return (
    <div className="rounded-2xl border bg-card divide-y">
      {repos.map((repo) => (
        <div key={repo.id} className="px-5 py-4 flex items-center justify-between">
          <div className="font-medium">{repo.owner}/{repo.name}</div>
          <div className="text-sm text-muted-foreground">{repo.defaultBranch}</div>
        </div>
      ))}
    </div>
  );
}
