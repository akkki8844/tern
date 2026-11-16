import { PageShell } from "../components/page-shell";
import { Card, CardHeader, CardTitle, CardContent } from "../components/card";
import { listPullRequests, type DataResult, type PullRequestRow } from "../_data";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const result: DataResult<PullRequestRow[]> = await listPullRequests();

  return (
    <PageShell>
      <h1 className="text-3xl font-bold">Pull Request History</h1>
      <Card>
        <CardHeader><CardTitle>Migrations</CardTitle></CardHeader>
        <CardContent>
          {!result.ok ? (
            <>
              <p className="text-sm text-muted-foreground">
                Pull request history could not be loaded because the database is not reachable.
              </p>
              <p className="mt-2 font-mono text-xs text-muted-foreground/70 break-all">{result.reason}</p>
            </>
          ) : result.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pull requests opened yet.</p>
          ) : (
            <ul className="space-y-3">
              {result.data.map((pr) => (
                <li key={pr.id} className="flex flex-col gap-1 border-b border-border/40 pb-3 last:border-b-0">
                  <div className="flex items-center justify-between">
                    <a href={pr.url} className="text-sm font-medium hover:underline" rel="noreferrer">
                      #{pr.number} {pr.title}
                    </a>
                    <span className="text-xs rounded-full border border-border px-2 py-0.5 text-muted-foreground">
                      {pr.status.toLowerCase()}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    <span className="font-mono">{pr.repository.owner}/{pr.repository.name}</span>
                    {" · branch "}
                    <span className="font-mono">{pr.branch}</span>
                    {" · opened for human review "}
                    {pr.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}
