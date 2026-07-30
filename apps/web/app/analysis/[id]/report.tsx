"use client";

import { Card, CardHeader, CardTitle, CardContent } from "../../components/card";
import { PipelineStatus } from "../../components/pipeline-status";
import { PageShell } from "../../components/page-shell";
import { Badge } from "../../components/badge";

interface BreakingChange {
  id: string;
  type: string;
  description: string;
  severity: string;
  path: string;
  method: string;
}

interface AnalysisData {
  id: string;
  status: string;
  breakingChanges?: BreakingChange[];
  affectedUsages?: number;
  patches?: number;
  currentStage?: string;
}

export function AnalysisReport({ data }: { data: AnalysisData }) {
  return (
    <PageShell>
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Analysis Report</h1>
        <Badge variant={data.status === "completed" ? "default" : data.status === "failed" ? "destructive" : "secondary"}>
          {data.status}
        </Badge>
      </div>
      <p className="text-muted-foreground font-mono text-sm">{data.id}</p>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          {data.breakingChanges && data.breakingChanges.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Breaking Changes ({data.breakingChanges.length})</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {data.breakingChanges.map(change => (
                    <div key={change.id} className="flex items-start gap-3 rounded-lg border p-3">
                      <Badge variant={change.severity === "breaking" ? "destructive" : "secondary"} className="mt-0.5">
                        {change.severity}
                      </Badge>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">{change.description}</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          <span className="font-mono">{change.method.toUpperCase()} {change.path}</span>
                          {" "}&middot;{" "}{change.type}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {data.affectedUsages !== undefined && (
            <Card>
              <CardHeader><CardTitle>Affected Code</CardTitle></CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Found <span className="font-semibold text-foreground">{data.affectedUsages}</span> call sites affected by breaking changes.
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        <div>
          <Card>
            <CardHeader><CardTitle>Pipeline</CardTitle></CardHeader>
            <CardContent>
              <PipelineStatus currentStage={data.currentStage} />
            </CardContent>
          </Card>
        </div>
      </div>
    </PageShell>
  );
}
