
import { describe, it } from "node:test";
import assert from "node:assert";
import { normalizeSchema } from "@tern/openapi";

describe("Property-based normalizer tests", () => {
  it("always returns a schema with a type", () => {
    const schemas = [
      { type: "string" },
      { properties: {} },
      { items: { type: "number" } },
      { enum: ["a", "b"] },
      { oneOf: [{ type: "string" }, { type: "integer" }] },
      { allOf: [{ type: "object" }] },
      { anyOf: [{ type: "array" }] },
      {}
    ];
    for (const schema of schemas) {
      const normalized = normalizeSchema(schema);
      assert.ok(normalized.type);
      assert.ok(["string", "object", "array", "string", "oneOf", "object", "array", "unknown"].includes(normalized.type));
    }
  });

  it("preserves nested required arrays", () => {
    const schema = {
      type: "object",
      required: ["id", "amount"],
      properties: {
        id: { type: "string" },
        amount: { type: "integer" }
      }
    };
    const normalized = normalizeSchema(schema);
    assert.deepStrictEqual(normalized.required, ["id", "amount"]);
    assert.ok(normalized.properties?.id);
    assert.ok(normalized.properties?.amount);
  });
});
