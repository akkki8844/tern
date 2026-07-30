import { PageShell } from "../components/page-shell";
import { Card, CardHeader, CardTitle, CardContent } from "../components/card";

export default function HistoryPage() {
  return (
    <PageShell>
      <h1 className="text-3xl font-bold">Pull Request History</h1>
      <Card>
        <CardHeader><CardTitle>Migrations</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">No pull requests opened yet.</p></CardContent>
      </Card>
    </PageShell>
  );
}
