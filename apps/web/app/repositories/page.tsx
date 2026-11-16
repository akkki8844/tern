import { PageShell } from "../components/page-shell";
import { Card, CardHeader, CardTitle, CardContent } from "../components/card";
import { listRepositories, type DataResult, type RepositoryRow } from "../_data";

export const dynamic = "force-dynamic";

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export default async function RepositoriesPage() {
  const result: DataResult<RepositoryRow[]> = await listRepositories();

  return (
    <PageShell>
      <h1 className="text-3xl font-bold">Repositories</h1>
      <Card>
        <CardHeader><CardTitle>Connected Repositories</CardTitle></CardHeader>
        <CardContent>
          {!result.ok ? (
            <>
              <p className="text-sm text-muted-foreground">
                The repository list could not be loaded because the database is not reachable.
              </p>
              <p className="mt-2 font-mono text-xs text-muted-foreground/70 break-all">{result.reason}</p>
            </>
          ) : result.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No repositories connected. Install the GitHub App to add repositories.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pb-2">Repository</th>
                  <th className="pb-2">Default branch</th>
                  <th className="pb-2">Visibility</th>
                  <th className="pb-2">Status</th>
                  <th className="pb-2">Connected</th>
                </tr>
              </thead>
              <tbody>
                {result.data.map((repo) => (
                  <tr key={repo.id} className="border-t border-border/50">
                    <td className="py-2 font-mono text-xs">{repo.owner}/{repo.name}</td>
                    <td className="py-2">{repo.defaultBranch}</td>
                    <td className="py-2">{repo.isPrivate ? "private" : "public"}</td>
                    <td className="py-2">{repo.archivedAt ? "archived" : "active"}</td>
                    <td className="py-2 text-muted-foreground">{formatDate(repo.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}
