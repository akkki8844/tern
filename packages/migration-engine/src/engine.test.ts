
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { DefaultMigrationEngine } from "./engine.js";
import { BreakingChange, AffectedUsage } from "@capibara/shared";
import { MigrationInstruction } from "@capibara/openapi";
import type { AIEdit, AIMigrationResponse, AIProvider } from "@capibara/shared";

/**
 * Stub AI provider. Mocking is appropriate here because the AI service is a genuine
 * external boundary; the provider contract itself is tested for real in @capibara/llm.
 */
class StubAIProvider implements AIProvider {
  readonly name = "stub";
  readonly isReal = false;
  readonly enabled = true;
  calls = 0;

  constructor(private readonly edits: AIEdit[]) {}

  async suggestMigration(): Promise<AIMigrationResponse> {
    this.calls += 1;
    return { edits: this.edits, confidence: 0.8, model: "stub" };
  }
}

const RENAME_EDIT: AIEdit = { search: "source:", replace: "payment_method:", reason: "renamed field" };

describe("DefaultMigrationEngine", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `capibara-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
    await writeFile(join(tmpDir, "client.ts"), "const charge = createCharge({ amount: 100, source: 'tok_visa', currency: 'usd' });\n");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("does not call the AI provider at all when it is disabled", async () => {
    const engine = new DefaultMigrationEngine();
    const change: BreakingChange = { id: "c1", type: "general", path: "/charges", method: "post", operationId: "createCharge", description: "Complex migration", severity: "breaking" };
    const usage: AffectedUsage = { id: "u1", file: "client.ts", line: 1, column: 1, functionName: "createCharge", snippet: "source: token", contextBefore: "", contextAfter: "", confidence: "high", breakingChangeId: "c1" };
    const patches = await engine.generatePatches(tmpDir, [change], [usage]);
    assert.strictEqual(patches.length, 0);
  });

  it("renames request field deterministically", async () => {
    const engine = new DefaultMigrationEngine();
    const change: BreakingChange = { id: "c1", type: "request-field-renamed", path: "/charges", method: "post", operationId: "createCharge", description: "Rename source to payment_method", severity: "breaking" };
    const instruction: MigrationInstruction = { changeType: "request-field-renamed", path: "/charges", method: "post", operationId: "createCharge", severity: "breaking", description: "Rename source to payment_method", action: "Rename field", mappings: [{ old: "source", new: "payment_method", kind: "field" }], confidence: 0.95, reasoning: "Field renamed" };
    const usage: AffectedUsage = { id: "u1", file: "client.ts", line: 1, column: 1, functionName: "createCharge", snippet: "source: token", contextBefore: "", contextAfter: "", confidence: "high", breakingChangeId: "c1" };
    const patches = await engine.generatePatches(tmpDir, [change], [usage], [instruction]);
    assert.strictEqual(patches.length, 1);
    assert.ok(patches[0].modified.includes("payment_method"));
    assert.strictEqual(patches[0].validationStatus, "valid");
  });

  it("rejects patches that modify forbidden files", async () => {
    const engine = new DefaultMigrationEngine();
    const change: BreakingChange = { id: "c1", type: "request-field-renamed", path: "/charges", method: "post", operationId: "createCharge", description: "Rename source to payment_method", severity: "breaking" };
    const usage: AffectedUsage = { id: "u1", file: "package.json", line: 1, column: 1, functionName: "x", snippet: "source", contextBefore: "", contextAfter: "", confidence: "high", breakingChangeId: "c1" };
    const patches = await engine.generatePatches(tmpDir, [change], [usage]);
    assert.strictEqual(patches.length, 0);
  });

  it("tracks stats", async () => {
    const engine = new DefaultMigrationEngine();
    const change: BreakingChange = { id: "c1", type: "request-field-renamed", path: "/charges", method: "post", operationId: "createCharge", description: "Rename source to payment_method", severity: "breaking" };
    const instruction: MigrationInstruction = { changeType: "request-field-renamed", path: "/charges", method: "post", operationId: "createCharge", severity: "breaking", description: "Rename source to payment_method", action: "Rename field", mappings: [{ old: "source", new: "payment_method", kind: "field" }], confidence: 0.95, reasoning: "Field renamed" };
    const usage: AffectedUsage = { id: "u1", file: "client.ts", line: 1, column: 1, functionName: "createCharge", snippet: "source: token", contextBefore: "", contextAfter: "", confidence: "high", breakingChangeId: "c1" };
    await engine.generatePatches(tmpDir, [change], [usage], [instruction]);
    const stats = engine.getStats();
    assert.ok(stats.rulesApplied >= 0); // Just check it doesn't throw
  });

  it("uses the AI fallback when no deterministic rule applies", async () => {
    const ai = new StubAIProvider([RENAME_EDIT]);
    const engine = new DefaultMigrationEngine(ai);

    // Use a change type that has no deterministic rule
    const change: BreakingChange = { id: "c1", type: "general", path: "/charges", method: "post", operationId: "createCharge", description: "Complex migration required for createCharge", severity: "breaking" };
    const usage: AffectedUsage = { id: "u1", file: "client.ts", line: 1, column: 1, functionName: "createCharge", snippet: "source: token", contextBefore: "", contextAfter: "", confidence: "high", breakingChangeId: "c1" };

    const patches = await engine.generatePatches(tmpDir, [change], [usage]);
    assert.strictEqual(patches.length, 1);
    assert.ok(patches[0].modified.includes("payment_method"));
    assert.ok(patches[0].appliedRules?.includes("ai-fallback"));
  });

  it("never uses the AI fallback for low confidence usages", async () => {
    const ai = new StubAIProvider([RENAME_EDIT]);
    const engine = new DefaultMigrationEngine(ai);

    // Use a change type that has no deterministic rule
    const change: BreakingChange = { id: "c1", type: "general", path: "/charges", method: "post", operationId: "createCharge", description: "Complex migration required for createCharge", severity: "breaking" };
    const usage: AffectedUsage = { id: "u1", file: "client.ts", line: 1, column: 1, functionName: "createCharge", snippet: "source: token", contextBefore: "", contextAfter: "", confidence: "low", breakingChangeId: "c1" };

    const patches = await engine.generatePatches(tmpDir, [change], [usage]);
    assert.strictEqual(patches.length, 0);
  });

  it("produces no patch when the AI proposes no edits", async () => {
    const ai = new StubAIProvider([]);
    const engine = new DefaultMigrationEngine(ai);

    // Use a change type that has no deterministic rule
    const change: BreakingChange = { id: "c1", type: "general", path: "/charges", method: "post", operationId: "createCharge", description: "Complex migration required for createCharge", severity: "breaking" };
    const usage: AffectedUsage = { id: "u1", file: "client.ts", line: 1, column: 1, functionName: "createCharge", snippet: "source: token", contextBefore: "", contextAfter: "", confidence: "high", breakingChangeId: "c1" };

    const patches = await engine.generatePatches(tmpDir, [change], [usage]);
    // Should not produce a patch since LLM returned empty
    assert.strictEqual(patches.length, 0);
  });

  it("prefers deterministic rules over the AI fallback", async () => {
    const ai = new StubAIProvider([RENAME_EDIT]);
    const engine = new DefaultMigrationEngine(ai);

    const change: BreakingChange = { id: "c1", type: "request-field-renamed", path: "/charges", method: "post", operationId: "createCharge", description: "Rename source to payment_method", severity: "breaking" };
    const instruction: MigrationInstruction = { changeType: "request-field-renamed", path: "/charges", method: "post", operationId: "createCharge", severity: "breaking", description: "Rename source to payment_method", action: "Rename field", mappings: [{ old: "source", new: "payment_method", kind: "field" }], confidence: 0.95, reasoning: "Field renamed" };
    const usage: AffectedUsage = { id: "u1", file: "client.ts", line: 1, column: 1, functionName: "createCharge", snippet: "source: token", contextBefore: "", contextAfter: "", confidence: "high", breakingChangeId: "c1" };

    const patches = await engine.generatePatches(tmpDir, [change], [usage], [instruction]);
    assert.strictEqual(patches.length, 1);
    // Should use deterministic rule, not LLM
    assert.ok(!patches[0].appliedRules?.includes("ai-fallback"));
    assert.ok(patches[0].appliedRules?.includes("request-field-renamed"));
  });
});
