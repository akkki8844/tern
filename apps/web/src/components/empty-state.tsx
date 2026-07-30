import { FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="flex flex-col items-center justify-center space-y-4 rounded-lg border border-dashed p-8 text-center">
      <FileQuestion className="h-8 w-8 text-muted-foreground" />
      <div className="space-y-1">
        <h3 className="text-lg font-medium">{title}</h3>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {action && <Button onClick={action.onClick}>{action.label}</Button>}
    </div>
  );
}
