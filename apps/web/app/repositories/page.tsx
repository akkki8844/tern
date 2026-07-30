import { PageShell } from "../components/page-shell";
import { Card, CardHeader, CardTitle, CardContent } from "../components/card";

export default function RepositoriesPage() {
  return (
    <PageShell>
      <h1 className="text-3xl font-bold">Repositories</h1>
      <Card>
        <CardHeader><CardTitle>Connected Repositories</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">No repositories connected. Install the GitHub App to add repositories.</p></CardContent>
      </Card>
    </PageShell>
  );
}
