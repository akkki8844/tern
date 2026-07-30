import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export function MigrationList() {
  return (
    <Card>
      <CardHeader><CardTitle>Migrations</CardTitle></CardHeader>
      <CardContent><p className="text-sm text-muted-foreground">No migrations found.</p></CardContent>
    </Card>
  );
}
