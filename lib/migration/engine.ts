import type { AffectedUsage, BreakingChange, MigrationPatch } from "@/lib/types";

export function buildDeterministicPatches(files: Record<string, string>, usages: AffectedUsage[], changes: BreakingChange[]): MigrationPatch[] {
  const patches: MigrationPatch[] = [];
  const filesToUpdate = new Set(usages.map((usage) => usage.filePath));

  for (const filePath of filesToUpdate) {
    const original = files[filePath];
    if (!original) continue;
    let updated = original;

    for (const change of changes) {
      if (change.type === "removed_endpoint" && change.endpoint) {
        const normalizedOld = change.endpoint.replace("{chargeId}", "");
        updated = updated.replaceAll(change.endpoint, "/v2/payments/{paymentId}");
        updated = updated.replaceAll(normalizedOld, "/v2/payments/");
      }
      if (change.type === "added_required_request_parameter" && change.newValue) {
        updated = updated.replace(/(amount:\s*\w+,?)/g, `$1\n    ${change.newValue}: "USD",`);
        updated = updated.replace(/(\bamount,\s*)/g, `$1\n    ${change.newValue}: "USD",\n`);
      }
      if (change.type === "removed_response_field" && change.oldValue) {
        updated = updated.replaceAll(change.oldValue, "state");
      }
      if (change.type === "renamed_response_field" && change.oldValue && change.newValue) {
        updated = updated.replaceAll(change.oldValue, change.newValue);
      }
    }

    if (updated !== original) {
      patches.push({
        filePath,
        patch: toUnifiedDiff(filePath, original, updated),
        rule: "deterministic-v1",
        confidence: 0.87,
      });
    }
  }

  return patches;
}

function toUnifiedDiff(filePath: string, oldContent: string, newContent: string): string {
  return `--- a/${filePath}\n+++ b/${filePath}\n@@ -1,${oldContent.split("\n").length} +1,${newContent.split("\n").length} @@\n-${oldContent.split("\n").join("\n-")}\n+${newContent.split("\n").join("\n+")}`;
}
