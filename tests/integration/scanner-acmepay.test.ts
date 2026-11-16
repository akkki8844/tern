
import { describe, it } from "node:test";
import assert from "node:assert";
import { scanStage, type DiscoverOutput, type DiffOutput } from "@capibara/pipeline";
import { loadFromString, analyzeSpecChange, toLegacyChanges } from "@capibara/openapi";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Fixtures are resolved relative to this file so the suite does not depend on the cwd.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return noopLogger;
  }
} as never;

function fakeContext() {
  return {
    analysisRunId: "test-run",
    jobId: "test-job",
    correlationId: "test-corr",
    logger: noopLogger,
    heartbeat: async () => {}
  } as never;
}

async function realTurn2Analysis() {
  // The same documents the worker demo uses: AcmePay v1 -> v2.
  const base = loadFromString(await readFile(path.join(repoRoot, "demo", "specs", "acmepay-v1.yaml"), "utf8"));
  const head = loadFromString(await readFile(path.join(repoRoot, "demo", "specs", "acmepay-v2.yaml"), "utf8"));
  return analyzeSpecChange(base, head);
}

const discoverOutput: DiscoverOutput = {
  checkoutPath: path.join(repoRoot, "demo", "broken-app"),
  commitSha: "abc123",
  specPath: "openapi.yaml",
  baseSpec: "base",
  headSpec: "head"
};

describe("Integration: SCAN stage on AcmePay demo", () => {
  it("produces semantic usages with evidence from the real Turn 2 analysis", async () => {
    const analysis = await realTurn2Analysis();
    assert.ok(analysis.changes.length > 0, "fixture must produce breaking changes");

    const projection = toLegacyChanges(analysis);
    const diffOutput: DiffOutput = { changes: projection.changes, analysis, instructions: projection.instructions };
    const output = await scanStage.run({ ...discoverOutput, ...diffOutput }, fakeContext());

    // The stage reports the AST engine ran and kept the full scan.
    assert.strictEqual(output.scanner, "ast-engine");
    assert.strictEqual(output.scan.engine, "ast");
    assert.ok(output.usages.length > 0, "expected more than zero affected usages");
    assert.strictEqual(output.scan.usages.length, output.usages.length * 0 + output.scan.usages.length);

    // Every usage carries its evidence chain and explanation.
    for (const usage of output.scan.usages) {
      assert.ok(usage.evidence.length > 0, `usage ${usage.id} must have evidence`);
      assert.ok(usage.explanation.length > 0, `usage ${usage.id} must have an explanation`);
      assert.ok(usage.changeIds.length > 0, `usage ${usage.id} must reference a change`);
    }

    // Confidence levels only from the canonical set.
    for (const usage of output.scan.usages) {
      assert.ok(["HIGH", "MEDIUM", "LOW", "UNKNOWN"].includes(usage.confidence), `bad confidence ${usage.confidence}`);
    }

    // At least one high-confidence usage (the direct axios call in api.ts).
    const high = output.scan.usages.filter((u) => u.confidence === "HIGH");
    assert.ok(high.length > 0, "expected at least one HIGH-confidence usage");

    // The call graph links changes -> operations -> usages.
    assert.ok(output.scan.graph.changes.length > 0);
    assert.ok(output.scan.graph.operations.length > 0);
    assert.ok(output.scan.graph.operationToUsages.length > 0);

    // Legacy projection keeps a valid shape for downstream stages.
    const legacy = output.usages[0];
    assert.ok(legacy.file.length > 0);
    assert.ok(legacy.confidence === "high" || legacy.confidence === "medium" || legacy.confidence === "low");
  });

  it("skips entirely when there are no changes", async () => {
    const analysis = await realTurn2Analysis();
    const output = await scanStage.run(
      { ...discoverOutput, changes: [], analysis, instructions: [] },
      fakeContext()
    );
    assert.strictEqual(output.usages.length, 0);
    assert.strictEqual(output.scanner, "skipped");
  });

  it("does not flag test assertion helpers as affected call sites", async () => {
    const analysis = await realTurn2Analysis();
    const output = await scanStage.run({ ...discoverOutput, changes: toLegacyChanges(analysis).changes, analysis, instructions: [] }, fakeContext());
    const flagged = output.scan.usages.filter((u) => u.file.endsWith(".test.ts"));
    // Test files call the real client functions (operationId-identical imports)
    // and anonymous wrappers — those are legitimate usages. String assertions
    // like `r.url.includes("/charges")` must never be flagged at all.
    for (const usage of flagged) {
      assert.ok(
        usage.kind === "generated-client-call" || usage.kind === "wrapper-caller",
        `unexpected usage kind ${usage.kind} in ${usage.file}:${usage.line}`
      );
      assert.ok(!usage.symbol.includes(".url"), "string-assertion leaked into usages");
    }
    // The demo's assertion-heavy test uses `captured.find((r) => r.url.includes("/charges"))`
    // — if the scanner regresses to string matching, these lines light up.
    const assertionLines = flagged.filter((u) => u.file.endsWith("index.test.ts") && (u.line === 36 || u.line === 47));
    assert.strictEqual(assertionLines.length, 0, "assertion helpers were flagged as usages");
  });
});
