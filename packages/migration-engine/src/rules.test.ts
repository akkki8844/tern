
import { describe, it } from "node:test";
import assert from "node:assert";
import { getRule, safeReplace, removeField, extractMappings, extractNamesFromDescription } from "./rules.js";
import { BreakingChange, AffectedUsage } from "@tern/shared";
import { MigrationInstruction } from "@tern/openapi";

describe("Migration Rules", () => {
  const createUsage = (overrides: Partial<AffectedUsage> = {}): AffectedUsage => ({
    id: "u1",
    file: "client.ts",
    line: 1,
    column: 1,
    functionName: "testFunction",
    snippet: "testFunction({ param: value })",
    contextBefore: "",
    contextAfter: "",
    confidence: "high",
    breakingChangeId: "c1",
    ...overrides
  });

  const createChange = (overrides: Partial<BreakingChange> = {}): BreakingChange => ({
    id: "c1",
    type: "request-field-renamed",
    path: "/test",
    method: "post",
    description: "Rename field",
    severity: "breaking",
    ...overrides
  });

  describe("getRule", () => {
    it("returns rules for known types", () => {
      assert.ok(getRule("request-field-renamed"));
      assert.ok(getRule("response-field-renamed"));
      assert.ok(getRule("request-field-removed"));
      assert.ok(getRule("response-field-removed"));
      assert.ok(getRule("path-parameter-renamed"));
      assert.ok(getRule("sdk-method-renamed"));
      assert.ok(getRule("sdk-import-renamed"));
      assert.ok(getRule("operation-id-removed"));
      assert.ok(getRule("required-parameter-added"));
      assert.ok(getRule("enum-value-removed"));
      assert.ok(getRule("type-changed"));
      assert.ok(getRule("endpoint-removed"));
      assert.ok(getRule("general"));
    });

    it("returns undefined for unknown types", () => {
      assert.strictEqual(getRule("unknown-type"), undefined);
    });
  });

  describe("safeReplace", () => {
    it("replaces whole words only", () => {
      const result = safeReplace("const source = 'test';", "source", "payment_method");
      assert.strictEqual(result, "const payment_method = 'test';");
    });

    it("does not replace partial matches", () => {
      const result = safeReplace("const sourceId = 'test';", "source", "payment_method");
      assert.strictEqual(result, "const sourceId = 'test';");
    });

    it("handles special regex characters", () => {
      const result = safeReplace("const value = obj.field;", "obj.field", "obj.newField");
      assert.strictEqual(result, "const value = obj.newField;");
    });
  });

  describe("removeField", () => {
    it("removes field from object literal", () => {
      const result = removeField("const obj = { source: 'test', other: 'value' };", "source");
      assert.strictEqual(result, "const obj = { other: 'value' };");
    });

    it("removes property access", () => {
      const result = removeField("const value = obj.source;", "source");
      assert.strictEqual(result, "const value = obj;");
    });
  });

  describe("extractMappings", () => {
    it("extracts mappings from rename description", () => {
      const result = extractMappings("Rename source to payment_method");
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].old, "source");
      assert.strictEqual(result[0].new, "payment_method");
    });

    it("extracts mappings from change description", () => {
      const result = extractMappings("Field status changed to state");
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].old, "status");
      assert.strictEqual(result[0].new, "state");
    });

    it("extracts mappings from remove description", () => {
      const result = extractMappings("Remove field source from request");
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].old, "source");
      assert.strictEqual(result[0].new, "");
    });

    it("extracts mappings from add description", () => {
      const result = extractMappings("Add required parameter customer_id");
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].old, "");
      assert.strictEqual(result[0].new, "customer_id");
    });

    it("returns empty for insufficient names", () => {
      const result = extractMappings("---");
      assert.strictEqual(result.length, 0);
    });
  });

  describe("extractNamesFromDescription", () => {
    it("extracts names from description", () => {
      const result = extractNamesFromDescription("Remove field source from request");
      assert.ok(result.includes("source"));
      assert.ok(result.includes("request"));
    });

    it("returns empty for no names", () => {
      const result = extractNamesFromDescription("---");
      assert.strictEqual(result.length, 0);
    });
  });

  describe("required-parameter-added rule", () => {
    it("adds parameter to object literal", () => {
      const rule = getRule("required-parameter-added")!;
      const change = createChange({
        type: "required-parameter-added",
        description: "Required parameter customer_id added"
      });
      const usage = createUsage({
        functionName: "createPayment",
        snippet: "createPayment({ amount: 100 })",
        line: 1
      });
      const content = "createPayment({ amount: 100 });";
      const result = rule(change, usage, content);
      assert.ok(result);
      assert.ok(result.includes("customer_id"));
    });

    it("adds parameter to function arguments", () => {
      const rule = getRule("required-parameter-added")!;
      const change = createChange({
        type: "required-parameter-added",
        description: "Required parameter customer_id added"
      });
      const usage = createUsage({
        functionName: "createPayment",
        snippet: "createPayment(amount)",
        line: 1
      });
      const content = "createPayment(amount);";
      const result = rule(change, usage, content);
      assert.ok(result);
      assert.ok(result.includes("customer_id"));
    });
  });

  describe("enum-value-removed rule", () => {
    it("removes enum value from string literal", () => {
      const rule = getRule("enum-value-removed")!;
      const change = createChange({
        type: "enum-value-removed",
        description: "Enum values removed from status: pending, cancelled"
      });
      const usage = createUsage({
        snippet: "const status = 'pending';",
        line: 1
      });
      const content = "const status = 'pending';";
      const result = rule(change, usage, content);
      assert.ok(result);
      assert.ok(result.includes("/* TODO: removed enum value */"));
    });

    it("removes enum value from switch case", () => {
      const rule = getRule("enum-value-removed")!;
      const change = createChange({
        type: "enum-value-removed",
        description: "Enum values removed from status: pending"
      });
      const usage = createUsage({
        snippet: "case 'pending':",
        line: 1
      });
      const content = "switch (status) {\n  case 'pending':\n    break;\n}";
      const result = rule(change, usage, content);
      assert.ok(result);
      assert.ok(result.includes("/* TODO: removed enum value */"));
    });
  });

  describe("type-changed rule", () => {
    it("converts string to number", () => {
      const rule = getRule("type-changed")!;
      const change = createChange({
        type: "type-changed",
        description: "Field amount type changed from string to number"
      });
      const usage = createUsage({
        snippet: "const amount = '100';",
        line: 1
      });
      const content = "const amount = '100';";
      const result = rule(change, usage, content);
      assert.ok(result);
      assert.ok(result.includes("Number("));
    });

    it("converts number to string", () => {
      const rule = getRule("type-changed")!;
      const change = createChange({
        type: "type-changed",
        description: "Field amount type changed from number to string"
      });
      const usage = createUsage({
        snippet: "const amount = 100;",
        line: 1
      });
      const content = "const amount = 100;";
      const result = rule(change, usage, content);
      assert.ok(result);
      assert.ok(result.includes("String("));
    });
  });

  describe("endpoint-removed rule", () => {
    it("adds deprecation comment", () => {
      const rule = getRule("endpoint-removed")!;
      const change = createChange({
        type: "endpoint-removed",
        path: "/charges",
        description: "Endpoint /charges removed"
      });
      const usage = createUsage({
        snippet: "await fetch('/charges', { method: 'POST' });",
        line: 1
      });
      const content = "await fetch('/charges', { method: 'POST' });";
      const result = rule(change, usage, content);
      assert.ok(result);
      assert.ok(result.includes("/* TODO: Endpoint /charges has been removed */"));
    });

    it("does not double-comment already commented lines", () => {
      const rule = getRule("endpoint-removed")!;
      const change = createChange({
        type: "endpoint-removed",
        path: "/charges",
        description: "Endpoint /charges removed"
      });
      const usage = createUsage({
        snippet: "// await fetch('/charges');",
        line: 1
      });
      const content = "// await fetch('/charges');";
      const result = rule(change, usage, content);
      assert.strictEqual(result, null);
    });
  });
});
