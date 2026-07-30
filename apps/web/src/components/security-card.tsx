import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export function SecurityCard() {
  return (
    <Card>
      <CardHeader><CardTitle>Security</CardTitle></CardHeader>
      <CardContent><p className="text-sm text-muted-foreground">Security posture is healthy.</p></CardContent>
    </Card>
  );
}
