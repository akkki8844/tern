import type { ApiChange, Severity, SpecChangeReport } from "./diff/changes.js";
import type { SpecChangeAnalysis } from "./diff/engine.js";
import { describeChange } from "./diff/legacy.js";
import { RULE_CATALOG } from "./diff/rules.js";

export interface RenderOptions {
  /** Include NON_BREAKING changes. Off by default to keep reports actionable. */
  includeNonBreaking?: boolean;
  /** Maximum number of changes rendered per severity group. */
  maxPerGroup?: number;
}

const SEVERITY_ORDER: Severity[] = ["BREAKING", "CONDITIONAL", "UNKNOWN", "NON_BREAKING"];

const SEVERITY_LABEL: Record<Severity, string> = {
  BREAKING: "BREAKING",
  CONDITIONAL: "CONDITIONAL (depends on how the repository uses the API)",
  UNKNOWN: "UNKNOWN (Capibara could not determine compatibility)",
  NON_BREAKING: "NON-BREAKING"
};

/**
 * Render a change report as plain text.
 *
 * The format is designed to answer, for each finding, the four questions a reviewer
 * actually asks: what changed, where, why it matters, and how much to trust it.
 */
export function formatChangeReport(analysis: SpecChangeAnalysis, options: RenderOptions = {}): string {
  const includeNonBreaking = options.includeNonBreaking ?? false;
  const maxPerGroup = options.maxPerGroup ?? 50;
  const lines: string[] = [];

  lines.push(`API change report  ${analysis.oldVersion || "?"} -> ${analysis.newVersion || "?"}`);
  lines.push(
    `OpenAPI ${analysis.oldOpenApiVersion} -> ${analysis.newOpenApiVersion}   ` +
      `${analysis.summary.breaking} breaking, ${analysis.summary.conditional} conditional, ` +
      `${analysis.summary.nonBreaking} non-breaking, ${analysis.summary.unknown} unknown`
  );
  lines.push("");

  for (const severity of SEVERITY_ORDER) {
    if (severity === "NON_BREAKING" && !includeNonBreaking) continue;
    const group = analysis.changes.filter((change) => change.severity === severity);
    if (group.length === 0) continue;

    lines.push(`## ${SEVERITY_LABEL[severity]}  (${group.length})`);
    lines.push("");
    for (const change of group.slice(0, maxPerGroup)) {
      lines.push(...renderChange(change));
      lines.push("");
    }
    if (group.length > maxPerGroup) {
      lines.push(`  … and ${group.length - maxPerGroup} more`);
      lines.push("");
    }
  }

  if (analysis.renameCandidates.length > 0) {
    lines.push(`## RENAME HYPOTHESES  (${analysis.renameCandidates.length})`);
    lines.push("  Not classifications. Structural evidence only; verify before relying on them.");
    lines.push("");
    for (const rename of analysis.renameCandidates) {
      lines.push(`  ${rename.location.displayPath}`);
      lines.push(`    ${rename.from} -> ${rename.to}   [${rename.kind}, ${rename.confidence}]`);
      for (const evidence of rename.evidence) lines.push(`    evidence: ${evidence}`);
      lines.push("");
    }
  }

  const changedComponents = analysis.componentUsage.filter((usage) => usage.changed);
  if (changedComponents.length > 0) {
    lines.push(`## SHARED SCHEMA IMPACT  (${changedComponents.length})`);
    lines.push("");
    for (const usage of changedComponents) {
      lines.push(`  ${usage.component} changed, used by:`);
      if (usage.usedBy.length === 0) {
        lines.push("    (no operation references it)");
      }
      for (const site of usage.usedBy) {
        lines.push(`    ${site.direction.padEnd(8)} ${site.operationKey}`);
      }
      lines.push("");
    }
  }

  if (analysis.unsupported.length > 0) {
    lines.push(`## NOT ANALYSED  (${analysis.unsupported.length})`);
    lines.push("  Capibara makes no compatibility claim for these constructs.");
    lines.push("");
    for (const note of analysis.unsupported) {
      lines.push(`  ${note.displayPath}`);
      lines.push(`    ${note.feature}: ${note.detail}`);
    }
    lines.push("");
  }

  if (analysis.changes.length === 0) {
    lines.push("No semantic changes detected.");
  }

  return lines.join("\n");
}

function renderChange(change: ApiChange): string[] {
  const definition = RULE_CATALOG[change.rule];
  const lines = [`  ${describeChange(change)}`, `    at        ${change.location.displayPath}`];
  if (change.oldValue !== undefined || change.newValue !== undefined) {
    lines.push(`    change    ${short(change.oldValue)} -> ${short(change.newValue)}`);
  }
  lines.push(`    direction ${change.direction}`);
  lines.push(`    rule      ${change.rule}`);
  lines.push(`    reason    ${change.reason}`);
  lines.push(`    confidence ${change.confidence}`);
  if (definition.limitations) lines.push(`    caveat    ${definition.limitations}`);
  return lines;
}

function short(value: unknown): string {
  if (value === undefined || value === null) return "none";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

/** Compact, machine-oriented projection used when embedding a report in JSON. */
export function toReportJson(analysis: SpecChangeAnalysis): SpecChangeReport {
  return {
    oldVersion: analysis.oldVersion,
    newVersion: analysis.newVersion,
    oldOpenApiVersion: analysis.oldOpenApiVersion,
    newOpenApiVersion: analysis.newOpenApiVersion,
    changes: analysis.changes,
    renameCandidates: analysis.renameCandidates,
    unsupported: analysis.unsupported,
    summary: analysis.summary
  };
}
