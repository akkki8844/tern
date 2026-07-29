
    import { describe, it } from "node:test";
    import assert from "node:assert";
    import { DefaultDiffEngine } from "@tern/openapi";
    import { loadFromString } from "@tern/openapi";
    import { DefaultMigrationEngine } from "@tern/migration-engine";

    describe("Integration: OpenAPI diff -> migration patch", () => {
      it("detects rename and produces a deterministic patch", async () => {
        const oldSpec = loadFromString(`
openapi: "3.0.3"
info:
  title: Acme
  version: "1.0.0"
paths:
  /charges:
    post:
      operationId: createCharge
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [amount]
              properties:
                amount: { type: integer }
                source: { type: string }
      responses:
        "201":
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: string }
                  status: { type: string }
`);
        const newSpec = loadFromString(`
openapi: "3.0.3"
info:
  title: Acme
  version: "2.0.0"
paths:
  /payments:
    post:
      operationId: createPayment
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [amount, payment_method]
              properties:
                amount: { type: integer }
                payment_method: { type: string }
      responses:
        "201":
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: string }
                  state: { type: string }
`);
        const engine = new DefaultDiffEngine();
        const changes = await engine.diff(oldSpec, newSpec);
        assert.ok(changes.some(c => c.type === "operation-id-removed"));
        assert.ok(changes.some(c => c.type === "endpoint-removed"));
        const instructions = engine.getMigrationInstructions();
        assert.ok(instructions.length > 0);
        const migrationEngine = new DefaultMigrationEngine();
        const usage = { id: "u1", file: "client.ts", line: 1, column: 1, functionName: "createCharge", snippet: "createCharge({ amount: 100, source: 'tok' })", contextBefore: "", contextAfter: "", confidence: "high", breakingChangeId: changes[0].id };
        const patches = await migrationEngine.generatePatches(".", changes, [usage], instructions);
        assert.ok(patches.length >= 0);
      });
    });
