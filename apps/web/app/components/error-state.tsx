import { AlertTriangle } from "lucide-react";
import { Button } from "./button";

export function ErrorState({ title, description, retry }: { title: string; description?: string; retry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center space-y-4 rounded-lg border border-destructive/50 p-8 text-center">
      <AlertTriangle className="h-8 w-8 text-destructive" />
      <div className="space-y-1">
        <h3 className="text-lg font-medium">{title}</h3>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {retry && <Button variant="outline" onClick={retry}>Try again</Button>}
    </div>
  );
}
