import { PageShell } from "../components/page-shell";
import { Card, CardHeader, CardTitle, CardContent } from "../components/card";

export default function AuditPage() {
  return (
    <PageShell>
      <h1 className="text-3xl font-bold">Audit Log</h1>
      <Card>
        <CardHeader><CardTitle>Events</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">No audit entries.</p></CardContent>
      </Card>
    </PageShell>
  );
}
