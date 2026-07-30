import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ErrorState({ title, description, retry }: { title: string; description?: string; retry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center space-y-4 rounded-lg border p-8 text-center">
      <AlertTriangle className="h-8 w-8 text-destructive" />
      <div className="space-y-1">
        <h3 className="text-lg font-medium">{title}</h3>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {retry && <Button onClick={retry}>Try again</Button>}
    </div>
  );
}
