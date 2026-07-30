import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export function RecentMigrations() {
  return (
    <Card>
      <CardHeader><CardTitle>Recent Migrations</CardTitle></CardHeader>
      <CardContent><p className="text-sm text-muted-foreground">No migrations yet.</p></CardContent>
    </Card>
  );
}
