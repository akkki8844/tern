import { describe, it } from "node:test";
import assert from "node:assert";
import { DefaultDiffEngine } from "./diff-engine.js";
import { loadFromString } from "./spec-loader.js";

function buildOldSpec() {
  return loadFromString([
    'openapi: "3.0.3"',
    "info:",
    '  title: Test',
    '  version: "1.0.0"',
    "servers:",
    "  - url: https://api.example.com/v1",
    "paths:",
    "  /charges:",
    "    post:",
    "      operationId: createCharge",
    "      requestBody:",
    "        required: true",
    "        content:",
    "          application/json:",
    "            schema:",
    "              type: object",
    "              required: [amount]",
    "              properties:",
    "                amount: { type: integer }",
    "                source: { type: string }",
    "                currency: { type: string, enum: [usd, eur] }",
    "      responses:",
    '        "200":',
    "          description: OK",
    "          content:",
    "            application/json:",
    "              schema:",
    "                type: object",
    "                properties:",
    "                  id: { type: string }",
    "                  status: { type: string }"
  ].join("\n"));
}

function buildNewSpec() {
  return loadFromString([
    'openapi: "3.0.3"',
    "info:",
    '  title: Test',
    '  version: "2.0.0"',
    "servers:",
    "  - url: https://api.example.com/v2",
    "paths:",
    "  /charges:",
    "    post:",
    "      operationId: createPayment",
    "      requestBody:",
    "        required: true",
    "        content:",
    "          application/json:",
    "            schema:",
    "              type: object",
    "              required: [amount, payment_method, customer_id]",
    "              properties:",
    "                amount: { type: integer }",
    "                payment_method: { type: string }",
    "                customer_id: { type: string }",
    "                currency: { type: string, enum: [usd, eur, gbp] }",
    "                memo: { type: string }",
    "      responses:",
    '        "200":',
    "          description: OK",
    "          content:",
    "            application/json:",
    "              schema:",
    "                type: object",
    "                properties:",
    "                  id: { type: string }",
    "                  state: { type: string }",
    "                  memo: { type: string }"
  ].join("\n"));
}

describe("DefaultDiffEngine", () => {
  it("detects operation id, server, field, enum, and required changes", async () => {
    const engine = new DefaultDiffEngine();
    const changes = await engine.diff(buildOldSpec(), buildNewSpec());
    const types = changes.map(c => c.type);
    assert.ok(types.includes("operation-id-removed"));
    assert.ok(types.includes("general"));
    assert.ok(types.includes("required-parameter-added"));
    assert.ok(types.includes("response-field-removed"));
    assert.ok(types.includes("request-field-removed"));
    assert.ok(types.includes("enum-value-added"));
    const instructions = engine.getMigrationInstructions();
    assert.ok(instructions.length > 0);
    assert.ok(instructions.every(i => i.confidence >= 0 && i.confidence <= 1));
  });

  it("provides migration instructions with mappings", async () => {
    const engine = new DefaultDiffEngine();
    await engine.diff(buildOldSpec(), buildNewSpec());
    const instructions = engine.getMigrationInstructions();
    const server = instructions.find(i => i.changeType === "general");
    assert.ok(server);
    assert.ok(server!.mappings.some(m => m.kind === "server"));
  });
});
