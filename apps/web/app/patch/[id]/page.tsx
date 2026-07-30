import { PageShell } from "../../components/page-shell";
import { Card, CardHeader, CardTitle, CardContent } from "../../components/card";

export default function PatchPreviewPage({ params }: { params: { id: string } }) {
  return (
    <PageShell>
      <h1 className="text-3xl font-bold">Patch Preview</h1>
      <p className="text-muted-foreground">Patch ID: <span className="font-mono text-sm">{params.id}</span></p>
      <Card>
        <CardHeader><CardTitle>Changes</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">Patch details will appear here.</p></CardContent>
      </Card>
    </PageShell>
  );
}
