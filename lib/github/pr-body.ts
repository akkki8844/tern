import type { AnalysisResult } from "@/lib/types";

export function buildMigrationPrBody(apiName: string, analysis: AnalysisResult, testCommand: string, testResult: "passed" | "failed", analysisUrl: string): string {
  const changes = analysis.breakingChanges.map((change) => `- **${change.type}** ${change.endpoint ?? ""} ${change.oldValue ? `(${change.oldValue} -> ${change.newValue ?? "removed"})` : ""}`.trim()).join("\n");
  const usages = analysis.affectedUsages.map((usage) => `- ${usage.filePath}:${usage.line} — \`${usage.snippet}\``).join("\n");
  const patchFiles = analysis.patches.map((patch) => `- ${patch.filePath} (${patch.rule}, confidence ${Math.round(patch.confidence * 100)}%)`).join("\n");

  return `## Tern API migration report\n\n### Summary of API changes\n${changes || "- No changes detected"}\n\n### Affected call sites\n${usages || "- No affected usages found"}\n\n### Exact changes made\n${patchFiles || "- No patches generated"}\n\n### Test command and result\n- Command: \`${testCommand}\`\n- Result: **${testResult.toUpperCase()}**\n\n### Confidence\n- Overall confidence: ${Math.round(analysis.confidence * 100)}%\n\n⚠️ **Suggested migration only. Human developer review is required before merge.**\n\n[View full Tern analysis](${analysisUrl})`;
}
