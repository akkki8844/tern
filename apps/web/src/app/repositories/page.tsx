import React from "react";
import { PageShell } from "@/components/page-shell";
import { RepositoryList } from "@/components/repository-list";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

export default function RepositoriesPage() {
  return (
    <PageShell>
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Repositories</h1>
        <Button size="sm">
          <Plus className="mr-2 h-4 w-4" />
          Add
        </Button>
      </div>
      <RepositoryList />
    </PageShell>
  );
}
