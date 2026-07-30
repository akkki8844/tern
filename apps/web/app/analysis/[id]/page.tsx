import { PageShell } from "../../components/page-shell";
import { Card, CardHeader, CardTitle, CardContent } from "../../components/card";

export default function AnalysisReportPage({ params }: { params: { id: string } }) {
  return (
    <PageShell>
      <h1 className="text-3xl font-bold">Analysis Report</h1>
      <p className="text-muted-foreground">Analysis ID: <span className="font-mono text-sm">{params.id}</span></p>
      <Card>
        <CardHeader><CardTitle>Status</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">This analysis is queued or in progress. Results will appear here.</p></CardContent>
      </Card>
    </PageShell>
  );
}
