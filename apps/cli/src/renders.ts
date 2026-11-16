
import pc from "picocolors";
import type { SpecChangeAnalysis } from "@capibara/openapi";
import type { RepositoryScan } from "@capibara/scanner";
import {
  confidenceChip,
  countBar,
  padColumn,
  section,
  severityChip,
  symbols,
  truncate,
  type Confidence,
  type Severity
} from "./ui.js";

/**
 * Report renderers shared by `capibara analyze` and `capibara report`.
 * Everything is deterministic plain text — safe to pipe, greppable, and
 * stable across runs for the same input.
 */

export interface ChangeRow {
  id: string;
  rule: string;
  severity: string;
  description: string;
  location: string;
}

export function changeRows(analysis: SpecChangeAnalysis): ChangeRow[] {
  return analysis.changes.map((change) => ({
    id: change.id,
    rule: String(change.rule),
    severity: change.severity,
    description: change.reason ?? "",
    location: change.location?.displayPath ?? change.location?.path ?? ""
  }));
}

export function renderChanges(rows: ChangeRow[], max = 50): string {
  const out: string[] = [];
  out.push(section("API changes"));
  const shown = rows.slice(0, max);
  for (const row of shown) {
    out.push(`  ${severityChip(row.severity)} ${pc.bold(truncate(row.rule, 34))} ${pc.dim(row.location)}`);
    if (row.description) out.push(`      ${pc.dim(truncate(row.description, 100))}`);
  }
  if (rows.length > max) {
    out.push(pc.dim(`  … ${rows.length - max} more (use --json for the full machine-readable set)`));
  }
  if (rows.length === 0) {
    out.push(`  ${symbols.ok("No API changes detected.")}`);
  }
  return out.join("\n");
}

export function renderSeveritySummary(analysis: SpecChangeAnalysis): string {
  const counts = { BREAKING: 0, CONDITIONAL: 0, NON_BREAKING: 0 } as Record<Severity, number>;
  for (const change of analysis.changes) counts[change.severity as Severity] += 1;
  return countBar([
    { label: "breaking", count: counts.BREAKING, color: pc.red },
    { label: "conditional", count: counts.CONDITIONAL, color: pc.yellow },
    { label: "non-breaking", count: counts.NON_BREAKING, color: pc.green }
  ]);
}

export function renderUsageReport(scan: RepositoryScan, verbose = false): string {
  const out: string[] = [];
  const usages = scan.usages;

  out.push(section("Affected code"));
  if (usages.length === 0) {
    out.push(`  ${symbols.ok("No affected usages found in this repository.")}`);
    return out.join("\n");
  }

  const byConfidence: Record<Confidence, number> = { HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  const byFile = new Map<string, Array<(typeof usages)[number]>>();
  for (const usage of usages) {
    byConfidence[usage.confidence as Confidence] += 1;
    const bucket = byFile.get(usage.file) ?? [];
    bucket.push(usage);
    byFile.set(usage.file, bucket);
  }

  const files = [...byFile.keys()].sort();
  const pathWidth = Math.max(...files.map((f) => f.length)) + 1;
  for (const file of files) {
    out.push(`  ${pc.bold(padColumn(truncate(file, pathWidth - 1), pathWidth))}${pc.dim(`${byFile.get(file)!.length} usage(s)`)}`);
    for (const usage of byFile.get(file)!) {
      const operation = usage.operation ? `${usage.operation.method} ${usage.operation.path}` : "—";
      const line = [
        pc.dim(`L${usage.line}`),
        pc.dim(padColumn(usage.kind, 22)),
        truncate(usage.symbol, 30),
        confidenceChip(usage.confidence),
        pc.dim(truncate(operation, 42))
      ].join("  ");
      out.push(`    ${line}`);
      if (verbose) {
        for (const evidence of usage.evidence) {
          out.push(pc.dim(`        ${evidence.confidence.toLowerCase().padEnd(6)} ${evidence.detail}`));
        }
      }
    }
  }

  out.push("");
  out.push(
    `  ${countBar([
      { label: "HIGH", count: byConfidence.HIGH, color: pc.green },
      { label: "MEDIUM", count: byConfidence.MEDIUM, color: pc.yellow },
      { label: "LOW", count: byConfidence.LOW, color: pc.white },
      { label: "UNKNOWN", count: byConfidence.UNKNOWN, color: pc.magenta }
    ])}`
  );
  out.push(pc.dim(`  ${usages.length} usage(s) across ${files.length} file(s) · ${scan.metrics.matching.refinedOut} refined out by usage evidence`));
  return out.join("\n");
}

export function renderStageTable(stages: Array<{ stage: string; status: string; durationMs?: number }>): string {
  const out: string[] = [];
  out.push(section("Pipeline"));
  for (const stage of stages) {
    const mark = stage.status === "SUCCEEDED" ? symbols.ok() : stage.status === "FAILED" ? symbols.fail() : symbols.warn();
    const ms = stage.durationMs !== undefined ? pc.dim(`${stage.durationMs} ms`) : pc.dim("—");
    out.push(`  ${mark} ${pc.bold(stage.stage.padEnd(10))} ${ms}`);
  }
  return out.join("\n");
}

export function footerHint(): string {
  return pc.dim("exit 1 means breaking changes were found · add --json for machine-readable output · --verbose shows evidence chains");
}
