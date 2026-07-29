
import { Shield } from "lucide-react";

export function SecurityCard({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-2xl border bg-card p-5">
      <div className="flex items-start gap-3">
        <Shield className="h-5 w-5 text-primary mt-0.5" aria-hidden="true" />
        <div>
          <h3 className="font-medium mb-1">{title}</h3>
          <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
        </div>
      </div>
    </div>
  );
}
