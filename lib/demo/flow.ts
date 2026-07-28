import { detectBreakingChanges } from "@/lib/openapi/diff";
import { scanTypeScriptUsages } from "@/lib/scanner/typescript-usage-scanner";
import { buildDeterministicPatches } from "@/lib/migration/engine";
import { validatePatch } from "@/lib/migration/patch-validator";
import { buildMigrationPrBody } from "@/lib/github/pr-body";
import { getDemoRepositoryFiles } from "@/lib/demo/repo";
import { newSpec, oldSpec } from "@/lib/demo/specs";
import { runDemoTests } from "@/lib/demo/test-runner";
import type { AnalysisResult } from "@/lib/types";

export function runDemoMigration() {
  const migrationMap = { statusText: "state" };
  const breakingChanges = detectBreakingChanges(oldSpec, newSpec, migrationMap);
  const files = getDemoRepositoryFiles();
  const scanInput = Object.entries(files).map(([path, content]) => ({ path, content }));
  const affectedUsages = scanTypeScriptUsages(scanInput, breakingChanges);
  const patches = buildDeterministicPatches(files, affectedUsages, breakingChanges);

  const invalidPatch = patches.find((patch) => !validatePatch({ patch: patch.patch, allowedFiles: Object.keys(files) }).valid);
  if (invalidPatch) {
    throw new Error(`Invalid patch generated for ${invalidPatch.filePath}`);
  }

  const updatedFiles = { ...files };
  for (const patch of patches) {
    const newContent = patch.patch
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1))
      .join("\n");
    updatedFiles[patch.filePath] = newContent;
  }

  const testCommand = "npm test";
  const tests = runDemoTests(updatedFiles);
  const analysis: AnalysisResult = {
    commitSha: "demo-sha",
    confidence: Math.min(0.99, 0.7 + affectedUsages.length * 0.05),
    breakingChanges,
    affectedUsages,
    patches,
  };

  return {
    analysis,
    testCommand,
    testResult: tests,
    pr: {
      branch: `tern/api-migration-${Date.now()}`,
      title: "fix: migrate for AcmePay breaking API change",
      body: buildMigrationPrBody("AcmePay", analysis, testCommand, tests.passed ? "passed" : "failed", "http://localhost:3000/analysis/demo"),
      url: "https://github.com/demo/acmepay/pull/42",
      number: 42,
    },
  };
}
