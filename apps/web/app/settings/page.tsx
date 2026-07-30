import { PageShell } from "../components/page-shell";
import { Card, CardHeader, CardTitle, CardContent } from "../components/card";
import { Button } from "../components/button";

export default function SettingsPage() {
  return (
    <PageShell>
      <h1 className="text-3xl font-bold">Settings</h1>
      <Card>
        <CardHeader><CardTitle>Integration</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">Configure Tern settings, environment, and notifications.</p>
          <Button variant="outline">Save</Button>
        </CardContent>
      </Card>
    </PageShell>
  );
}
