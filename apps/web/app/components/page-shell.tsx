import { cn } from "./utils";

export function PageShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("mx-auto max-w-6xl space-y-6", className)}>{children}</div>;
}
