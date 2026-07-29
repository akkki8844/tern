
    import { describe, it } from "node:test";
    import assert from "node:assert";
    import { DefaultDiffEngine } from "./diff-engine";
    import { loadFromString } from "./spec-loader";

    describe("DefaultDiffEngine", () => {
      const oldSpec = loadFromString(`
openapi: "3.0.0"
info:
  title: Test
  version: "1.0.0"
servers:
  - url: https://api.example.com/v1
paths:
  /charges:
    post:
      operationId: createCharge
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [amount]
              properties:
                amount: { type: integer }
                source: { type: string }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: string }
                  status: { type: string }
`);
      const newSpec = loadFromString(`
openapi: "3.0.0"
info:
  title: Test
  version: "2.0.0"
servers:
  - url: https://api.example.com/v2
paths:
  /charges:
    post:
      operationId: createPayment
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [amount, payment_method]
              properties:
                amount: { type: integer }
                payment_method: { type: string }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: string }
                  state: { type: string }
`);
      it("detects operation id, server, and field changes", async () => {
        const engine = new DefaultDiffEngine();
        const changes = await engine.diff(oldSpec, newSpec);
        const types = changes.map(c => c.type);
        assert.ok(types.includes("operation-id-removed"));
        assert.ok(types.includes("general"));
        assert.ok(types.includes("required-parameter-added"));
        assert.ok(types.includes("response-field-removed"));
        assert.ok(types.includes("response-field-renamed"));
      });
    });
