import { PageShell } from "../../components/page-shell";
import { Card, CardHeader, CardTitle, CardContent } from "../../components/card";
import { analysisDetail } from "../../_data";

export const dynamic = "force-dynamic";

const STAGE_ORDER = ["DISCOVER", "DIFF", "SCAN", "PLAN", "MIGRATE", "VALIDATE", "TEST", "PUBLISH"];

export default async function AnalysisReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await analysisDetail(id);

  if (!result.ok) {
    return (
      <PageShell>
        <h1 className="text-3xl font-bold">Analysis Report</h1>
        <p className="text-muted-foreground">Analysis ID: <span className="font-mono text-sm">{id}</span></p>
        <Card>
          <CardHeader><CardTitle>Unavailable</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              This analysis could not be loaded because the database is not reachable.
            </p>
            <p className="mt-2 font-mono text-xs text-muted-foreground/70 break-all">{result.reason}</p>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  const run = result.data;
  if (run === null) {
    return (
      <PageShell>
        <h1 className="text-3xl font-bold">Analysis Report</h1>
        <Card>
          <CardHeader><CardTitle>Not found</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              No analysis exists with ID <span className="font-mono text-sm">{id}</span>.
            </p>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  const stages = [...run.stages].sort(
    (a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage)
  );

  return (
    <PageShell>
      <h1 className="text-3xl font-bold">Analysis Report</h1>
      <p className="text-muted-foreground">
        <span className="font-mono text-sm">{run.repository.owner}/{run.repository.name}</span>
        {" · "}
        <span className="font-mono text-xs">{run.baseCommitSha.slice(0, 7)}..{run.headCommitSha.slice(0, 7)}</span>
        {" · "}
        <span>{run.status.toLowerCase()}</span>
      </p>

      <Card>
        <CardHeader><CardTitle>Pipeline stages</CardTitle></CardHeader>
        <CardContent>
          <ul className="space-y-1 text-sm">
            {stages.map((stage) => (
              <li key={stage.stage} className="flex items-center justify-between">
                <span className="font-mono text-xs">{stage.stage}</span>
                <span className="text-muted-foreground">{stage.status.toLowerCase()}</span>
                <span className="text-xs text-muted-foreground/70">
                  {stage.durationMs === null ? "—" : `${stage.durationMs} ms`}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Breaking changes ({run.changes.length})</CardTitle></CardHeader>
        <CardContent>
          {run.changes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No breaking changes detected.</p>
          ) : (
            <ul className="space-y-2">
              {run.changes.map((change) => (
                <li key={change.id} className="text-sm">
                  <span className="font-mono text-xs">{change.type}</span>
                  {" "}
                  <span className="text-muted-foreground">{change.description}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Affected usages ({run.usages.length})</CardTitle></CardHeader>
        <CardContent>
          {run.usages.length === 0 ? (
            <p className="text-sm text-muted-foreground">No affected usages found.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pb-2">File</th>
                  <th className="pb-2">Symbol</th>
                  <th className="pb-2">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {run.usages.map((usage) => (
                  <tr key={usage.id} className="border-t border-border/50">
                    <td className="py-1.5 font-mono text-xs">{usage.filePath}:{usage.line}</td>
                    <td className="py-1.5 font-mono text-xs">{usage.symbol}</td>
                    <td className="py-1.5">{usage.confidence.toLowerCase()}</td>
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
