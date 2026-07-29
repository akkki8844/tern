
import { describe, it } from "node:test";
import assert from "node:assert";
import { DefaultMigrationEngine } from "./engine";
import { BreakingChange, AffectedUsage } from "@tern/shared";

describe("DefaultMigrationEngine", () => {
  it("renames request field deterministically", async () => {
    const engine = new DefaultMigrationEngine();
    const change: BreakingChange = { id: "c1", type: "request-field-renamed", path: "/charges", method: "post", operationId: "createCharge", description: "Rename source to payment_method", severity: "breaking" };
    const usage: AffectedUsage = { id: "u1", file: "client.ts", line: 1, column: 1, functionName: "createCharge", snippet: "source: token", contextBefore: "", contextAfter: "", confidence: "high", breakingChangeId: "c1" };
    const patches = await engine.generatePatches(".", [change], [usage]);
    assert.strictEqual(patches.length, 1);
    assert.ok(patches[0].modified.includes("payment_method"));
    assert.strictEqual(patches[0].validationStatus, "valid");
    assert.ok(patches[0].appliedRules?.includes("request-field-renamed"));
  });

  it("rejects patches that modify forbidden files", async () => {
    const engine = new DefaultMigrationEngine();
    const change: BreakingChange = { id: "c1", type: "request-field-renamed", path: "/charges", method: "post", operationId: "createCharge", description: "Rename source to payment_method", severity: "breaking" };
    const usage: AffectedUsage = { id: "u1", file: "package.json", line: 1, column: 1, functionName: "x", snippet: "source", contextBefore: "", contextAfter: "", confidence: "high", breakingChangeId: "c1" };
    const patches = await engine.generatePatches(".", [change], [usage]);
    assert.strictEqual(patches.length, 0);
  });

  it("tracks stats", async () => {
    const engine = new DefaultMigrationEngine();
    const change: BreakingChange = { id: "c1", type: "request-field-renamed", path: "/charges", method: "post", operationId: "createCharge", description: "Rename source to payment_method", severity: "breaking" };
    const usage: AffectedUsage = { id: "u1", file: "client.ts", line: 1, column: 1, functionName: "createCharge", snippet: "source: token", contextBefore: "", contextAfter: "", confidence: "high", breakingChangeId: "c1" };
    await engine.generatePatches(".", [change], [usage]);
    const stats = engine.getStats();
    assert.strictEqual(stats.rulesApplied, 1);
  });
});
