import { PageShell } from "../components/page-shell";
import { Card, CardHeader, CardTitle, CardContent } from "../components/card";
import { Button } from "../components/button";

export default function DisconnectPage() {
  return (
    <PageShell>
      <h1 className="text-3xl font-bold">Disconnect</h1>
      <Card>
        <CardHeader><CardTitle>Account</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">Remove the Tern GitHub App from your account. This will stop all analyses and revoke access.</p>
          <Button variant="destructive">Disconnect Account</Button>
        </CardContent>
      </Card>
    </PageShell>
  );
}
