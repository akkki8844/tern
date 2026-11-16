/**
 * Human-readable usage report for CLI, demo and PR bodies.
 * Deterministic formatting: same scan, same text.
 */
import type { RepositoryScan, DetectedUsage } from "../model/usage.js";

export interface ReportOptions {
  /** Group cap per file (default 25). */
  readonly maxPerFile?: number;
  /** Include NON-affecting context lines (default false). */
  readonly includeMetrics?: boolean;
}

export function formatUsageReport(scan: RepositoryScan, options: ReportOptions = {}): string {
  const maxPerFile = options.maxPerFile ?? 25;
  const lines: string[] = [];
  const byFile = new Map<string, DetectedUsage[]>();
  for (const usage of scan.usages) {
    const list = byFile.get(usage.file) ?? [];
    list.push(usage);
    byFile.set(usage.file, list);
  }
  const files = [...byFile.keys()].sort();
  const breaking = scan.usages.filter((u) => u.severity === "BREAKING").length;
  const conditional = scan.usages.filter((u) => u.severity === "CONDITIONAL").length;
  const unknown = scan.usages.filter((u) => u.severity === "UNKNOWN").length;

  lines.push("Affected usage report");
  lines.push(
    `  ${scan.usages.length} usage(s) in ${files.length} file(s) — ${breaking} breaking, ${conditional} conditional, ${unknown} unknown-severity`
  );
  if (scan.usages.length === 0) {
    lines.push("");
    lines.push("  No code affected by the OpenAPI changes was found.");
  }
  for (const file of files) {
    lines.push("");
    lines.push(`${file}`);
    const usages = byFile.get(file)!.slice(0, maxPerFile);
    for (const usage of usages) {
      lines.push(`  L${usage.line}:${usage.column}  [${usage.kind}] ${usage.symbol}`);
      if (usage.operation !== undefined) {
        lines.push(`      operation: ${usage.operation.method} ${usage.operation.path}${usage.operation.operationId !== undefined ? ` (${usage.operation.operationId})` : ""}`);
      } else if (usage.operationCandidates !== undefined && usage.operationCandidates.length > 0) {
        const keys = usage.operationCandidates.map((o) => `${o.method} ${o.path}`).join(", ");
        lines.push(`      candidate operations: ${keys}`);
      }
      lines.push(`      changes: ${usage.changeRules.join(", ")}`);
      lines.push(`      confidence: ${usage.confidence}${usage.indirect ? " (indirect via wrapper/import chain)" : ""}`);
      for (const item of usage.evidence) {
        lines.push(`      evidence: ${item.detail} [${item.confidence}]`);
      }
    }
    const hidden = byFile.get(file)!.length - usages.length;
    if (hidden > 0) lines.push(`  … ${hidden} more usage(s) in this file`);
  }

  if (options.includeMetrics) {
    lines.push("");
    lines.push("Scan metrics");
    lines.push(`  files: ${scan.metrics.discovery.filesIncluded} analysed, ${scan.metrics.discovery.filesConsidered - scan.metrics.discovery.filesIncluded} excluded`);
    lines.push(`  parse: ${scan.metrics.parsing.filesParsedOk} ok, ${scan.metrics.parsing.filesWithParseErrors} with errors, ${scan.metrics.parsing.filesRefused} refused`);
    lines.push(`  imports: ${scan.metrics.modules.importsResolvedInternal} internal, ${scan.metrics.modules.importsExternal} external, ${scan.metrics.modules.importsUnresolved} unresolved`);
    lines.push(`  symbols: ${scan.metrics.symbols.declarations} declarations, ${scan.metrics.symbols.referencesResolved} call roots resolved, ${scan.metrics.symbols.shadowedBindings} shadowed`);
    lines.push(`  matching: ${scan.metrics.matching.operationsIndexed} changed operations, ${scan.metrics.matching.refinedOut} conditional change(s) refined out by usage evidence, ${scan.metrics.matching.ambiguousMatches} ambiguous`);
    lines.push(`  flow: ${scan.metrics.flow.responseRootsTracked} response roots tracked, ${scan.metrics.flow.untrackedResponseFlows} untracked (.then/complex), ${scan.metrics.flow.dynamicObjectSpreads} spread bodies, ${scan.metrics.flow.truncatedWrapperChains} truncated wrapper chains`);
    lines.push(`  timing: discovery ${scan.timing.discoveryMs}ms, parsing ${scan.timing.parsingMs}ms, resolution ${scan.timing.resolutionMs}ms, detection ${scan.timing.detectionMs}ms, matching ${scan.timing.matchingMs}ms, total ${scan.timing.totalMs}ms`);
  }

  if (scan.parseFailures.length > 0) {
    lines.push("");
    lines.push("Files with parse errors (analysed partially, reported explicitly):");
    for (const failure of scan.parseFailures.slice(0, 20)) {
      lines.push(`  ${failure.file}: ${failure.errors[0] ?? "unknown error"}`);
    }
    if (scan.parseFailures.length > 20) lines.push(`  … ${scan.parseFailures.length - 20} more`);
  }

  return lines.join("\n");
}
