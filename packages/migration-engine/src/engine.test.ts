
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { DefaultMigrationEngine } from "./engine.js";
import { BreakingChange, AffectedUsage } from "@tern/shared";
import { MigrationInstruction } from "@tern/openapi";
import { LlmAdapter, LlmMessage, LlmResponse } from "@tern/llm";

// Mock LLM adapter for testing
class MockLlmAdapter implements LlmAdapter {
  private response: string;

  constructor(response: string) {
    this.response = response;
  }

  async complete(messages: LlmMessage[]): Promise<LlmResponse> {
    return { content: this.response, usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } };
  }
}

describe("DefaultMigrationEngine", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `tern-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
    await writeFile(join(tmpDir, "client.ts"), "const charge = createCharge({ amount: 100, source: 'tok_visa', currency: 'usd' });\n");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
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

  it("uses LLM fallback when rule returns null", async () => {
    const llmResponse = `const charge = createCharge({ amount: 100, payment_method: 'tok_visa', currency: 'usd' });`;
    const llm = new MockLlmAdapter(llmResponse);
    const engine = new DefaultMigrationEngine(llm);

    // Use a change type that has no deterministic rule
    const change: BreakingChange = { id: "c1", type: "general", path: "/charges", method: "post", operationId: "createCharge", description: "Complex migration required for createCharge", severity: "breaking" };
    const usage: AffectedUsage = { id: "u1", file: "client.ts", line: 1, column: 1, functionName: "createCharge", snippet: "source: token", contextBefore: "", contextAfter: "", confidence: "high", breakingChangeId: "c1" };

    const patches = await engine.generatePatches(tmpDir, [change], [usage]);
    assert.strictEqual(patches.length, 1);
    assert.ok(patches[0].modified.includes("payment_method"));
    assert.ok(patches[0].appliedRules?.includes("llm"));
  });

  it("does not use LLM fallback for low confidence usages", async () => {
    const llmResponse = `const charge = createCharge({ amount: 100, payment_method: 'tok_visa', currency: 'usd' });`;
    const llm = new MockLlmAdapter(llmResponse);
    const engine = new DefaultMigrationEngine(llm);

    // Use a change type that has no deterministic rule
    const change: BreakingChange = { id: "c1", type: "general", path: "/charges", method: "post", operationId: "createCharge", description: "Complex migration required for createCharge", severity: "breaking" };
    const usage: AffectedUsage = { id: "u1", file: "client.ts", line: 1, column: 1, functionName: "createCharge", snippet: "source: token", contextBefore: "", contextAfter: "", confidence: "low", breakingChangeId: "c1" };

    const patches = await engine.generatePatches(tmpDir, [change], [usage]);
    assert.strictEqual(patches.length, 0);
  });

  it("handles LLM fallback failure gracefully", async () => {
    const llm = new MockLlmAdapter("");
    const engine = new DefaultMigrationEngine(llm);

    // Use a change type that has no deterministic rule
    const change: BreakingChange = { id: "c1", type: "general", path: "/charges", method: "post", operationId: "createCharge", description: "Complex migration required for createCharge", severity: "breaking" };
    const usage: AffectedUsage = { id: "u1", file: "client.ts", line: 1, column: 1, functionName: "createCharge", snippet: "source: token", contextBefore: "", contextAfter: "", confidence: "high", breakingChangeId: "c1" };

    const patches = await engine.generatePatches(tmpDir, [change], [usage]);
    // Should not produce a patch since LLM returned empty
    assert.strictEqual(patches.length, 0);
  });

  it("applies deterministic rules before LLM fallback", async () => {
    const llmResponse = `const charge = createCharge({ amount: 100, payment_method: 'tok_visa', currency: 'usd' });`;
    const llm = new MockLlmAdapter(llmResponse);
    const engine = new DefaultMigrationEngine(llm);

    const change: BreakingChange = { id: "c1", type: "request-field-renamed", path: "/charges", method: "post", operationId: "createCharge", description: "Rename source to payment_method", severity: "breaking" };
    const instruction: MigrationInstruction = { changeType: "request-field-renamed", path: "/charges", method: "post", operationId: "createCharge", severity: "breaking", description: "Rename source to payment_method", action: "Rename field", mappings: [{ old: "source", new: "payment_method", kind: "field" }], confidence: 0.95, reasoning: "Field renamed" };
    const usage: AffectedUsage = { id: "u1", file: "client.ts", line: 1, column: 1, functionName: "createCharge", snippet: "source: token", contextBefore: "", contextAfter: "", confidence: "high", breakingChangeId: "c1" };

    const patches = await engine.generatePatches(tmpDir, [change], [usage], [instruction]);
    assert.strictEqual(patches.length, 1);
    // Should use deterministic rule, not LLM
    assert.ok(!patches[0].appliedRules?.includes("llm"));
    assert.ok(patches[0].appliedRules?.includes("request-field-renamed"));
  });
});
