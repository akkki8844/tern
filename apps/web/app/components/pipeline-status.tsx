"use client";

import { cn } from "./utils";
import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";

export type StageStatus = "pending" | "running" | "completed" | "failed";

export interface PipelineStage {
  id: string;
  label: string;
  description: string;
  status: StageStatus;
}

const stages: PipelineStage[] = [
  { id: "spec-diff", label: "API Changes Detected", description: "Comparing old and new OpenAPI specifications", status: "pending" },
  { id: "scan", label: "Repository Scanned", description: "Finding affected call sites with Tree-sitter", status: "pending" },
  { id: "usages", label: "Affected Usages Found", description: "Matching call sites to breaking changes", status: "pending" },
  { id: "migration", label: "Migration Generated", description: "Applying deterministic rewrites and LLM patches", status: "pending" },
  { id: "validation", label: "Validation Completed", description: "Checking patches against security policy", status: "pending" },
  { id: "sandbox", label: "Tests Passed", description: "Running tests in ephemeral sandbox", status: "pending" },
  { id: "pr", label: "Pull Request Ready", description: "Generating senior-engineer-quality PR", status: "pending" }
];

function StageIcon({ status }: { status: StageStatus }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="h-5 w-5 text-green-500" />;
    case "running":
      return <Loader2 className="h-5 w-5 animate-spin text-primary" />;
    case "failed":
      return <XCircle className="h-5 w-5 text-destructive" />;
    default:
      return <Circle className="h-5 w-5 text-muted-foreground/40" />;
  }
}

export function PipelineStatus({ currentStage }: { currentStage?: string }) {
  const activeIndex = currentStage ? stages.findIndex(s => s.id === currentStage) : -1;

  return (
    <div className="space-y-1">
      {stages.map((stage, index) => {
        const status: StageStatus = index < activeIndex ? "completed" : index === activeIndex ? "running" : "pending";
        return (
          <div key={stage.id} className={cn("flex items-start gap-3 rounded-lg px-3 py-2 transition-colors", status === "running" && "bg-primary/5")}>
            <div className="mt-0.5">
              <StageIcon status={status} />
            </div>
            <div className="flex-1 min-w-0">
              <p className={cn("text-sm font-medium", status === "pending" ? "text-muted-foreground/60" : "text-foreground")}>
                {stage.label}
              </p>
              <p className="text-xs text-muted-foreground">{stage.description}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
