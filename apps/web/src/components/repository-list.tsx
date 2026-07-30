import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export function RepositoryList() {
  return (
    <Card>
      <CardHeader><CardTitle>Repositories</CardTitle></CardHeader>
      <CardContent><p className="text-sm text-muted-foreground">No repositories connected.</p></CardContent>
    </Card>
  );
}
