import { describe, it } from "node:test";
import assert from "node:assert";
import { loadFromString } from "./spec-loader";
import { normalizeOperations, normalizeSchema } from "./normalizer";

describe("Normalizer", () => {
  it("normalizes operations", () => {
    const spec = loadFromString(`
openapi: "3.0.3"
info:
  title: T
  version: "1.0.0"
paths:
  /users:
    get:
      operationId: listUsers
      parameters:
        - name: limit
          in: query
          schema: { type: integer }
      responses:
        "200":
          content:
            application/json:
              schema:
                type: array
                items: { type: object }
`);
    const ops = normalizeOperations(spec);
    assert.strictEqual(ops.length, 1);
    assert.strictEqual(ops[0].method, "get");
    assert.strictEqual(ops[0].parameters[0].name, "limit");
    assert.strictEqual(ops[0].responses["200"].type, "array");
  });

  it("normalizes schema with oneOf", () => {
    const schema = normalizeSchema({ oneOf: [{ type: "string" }, { type: "integer" }] });
    assert.strictEqual(schema.type, "oneOf");
    assert.strictEqual(schema.oneOf?.length, 2);
  });
});
