
import { Suspense } from "react";
import { PageShell } from "@/components/page-shell";
import { LoadingState } from "@/components/loading-state";
import { RepositoryList } from "@/components/repository-list";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

export default function RepositoriesPage() {
  return (
    <PageShell
      title="Repositories"
      subtitle="GitHub repositories connected to Tern."
      actions={<Button size="sm"><Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Install App</Button>}
    >
      <Suspense fallback={<LoadingState message="Loading repositories..." />}>
        <RepositoryList />
      </Suspense>
    </PageShell>
  );
}
