import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeSpecChange } from "./engine.js";
import { loadFromString } from "../spec-loader.js";
import { RULE_CATALOG } from "./rules.js";
import { analyze, jsonBody, jsonResponse, makeSpec } from "../testing/fixtures.js";
import type { OpenApiDocument } from "../interfaces.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Invariants the engine must hold for every input.
 *
 * These are the properties Tern's trustworthiness rests on: no false positives from
 * cosmetic edits, identical output on repeated runs, and a complete explanation
 * attached to every finding.
 */

const RICH_SPEC = {
  openapi: "3.0.3",
  info: { title: "Rich", version: "1.0.0" },
  servers: [{ url: "https://api.example.com/v1" }],
  paths: {
    "/users/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      get: {
        operationId: "getUser",
        parameters: [{ name: "expand", in: "query", schema: { type: "string", enum: ["orders", "profile"] } }],
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } }
          },
          "404": { description: "Missing" }
        }
      },
      patch: {
        operationId: "updateUser",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } }
        },
        responses: { "200": { description: "OK" } }
      }
    }
  },
  components: {
    schemas: {
      User: {
        type: "object",
        required: ["id", "email"],
        properties: {
          id: { type: "string", format: "uuid" },
          email: { type: "string", format: "email" },
          status: { type: "string", enum: ["active", "suspended"] },
          orders: { type: "array", items: { $ref: "#/components/schemas/Order" } }
        }
      },
      Order: {
        type: "object",
        properties: { id: { type: "string" }, total: { type: "integer", minimum: 0 } }
      }
    }
  }
};

const richSpec = () => loadFromString(JSON.stringify(RICH_SPEC));

describe("invariant: diff(A, A) is empty", () => {
  it("produces no changes for an identical document", () => {
    const analysis = analyzeSpecChange(richSpec(), richSpec());
    assert.deepEqual(analysis.changes, []);
    assert.deepEqual(analysis.renameCandidates, []);
    assert.equal(analysis.summary.total, 0);
  });

  it("produces no changes for a recursive document compared with itself", () => {
    const document = () =>
      makeSpec({
        paths: { "/n": { get: { operationId: "n", responses: jsonResponse({ $ref: "#/components/schemas/Node" }) } } },
        components: {
          schemas: {
            Node: {
              type: "object",
              properties: { next: { $ref: "#/components/schemas/Node" }, name: { type: "string" } }
            }
          }
        }
      });
    assert.deepEqual(analyzeSpecChange(document(), document()).changes, []);
  });
});

describe("invariant: cosmetic edits produce no semantic changes", () => {
  it("key reordering is not a change", () => {
    const reordered = JSON.parse(JSON.stringify(RICH_SPEC));
    const user = reordered.components.schemas.User;
    reordered.components.schemas.User = {
      properties: user.properties,
      required: [...user.required].reverse(),
      type: user.type
    };
    reordered.paths["/users/{id}"] = {
      patch: reordered.paths["/users/{id}"].patch,
      get: reordered.paths["/users/{id}"].get,
      parameters: reordered.paths["/users/{id}"].parameters
    };
    assert.deepEqual(analyzeSpecChange(richSpec(), loadFromString(JSON.stringify(reordered))).changes, []);
  });

  it("YAML vs JSON representation is not a change", () => {
    const asYaml = [
      'openapi: "3.0.3"',
      "info:",
      "  title: Same",
      '  version: "1.0.0"',
      "paths:",
      "  /things:",
      "    get:",
      "      operationId: listThings",
      "      responses:",
      '        "200":',
      "          description: OK"
    ].join("\n");
    const asJson = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Same", version: "1.0.0" },
      paths: { "/things": { get: { operationId: "listThings", responses: { "200": { description: "OK" } } } } }
    });
    assert.deepEqual(analyzeSpecChange(loadFromString(asYaml), loadFromString(asJson)).changes, []);
  });

  it("whitespace and description edits are not compatibility changes", () => {
    const before = makeSpec({
      paths: {
        "/a": {
          get: { operationId: "a", description: "Old prose", responses: jsonResponse({ type: "object" }) }
        }
      }
    });
    const after = makeSpec({
      paths: {
        "/a": {
          get: { operationId: "a", description: "Completely rewritten prose", responses: jsonResponse({ type: "object" }) }
        }
      }
    });
    assert.deepEqual(analyze(before, after).changes, []);
  });

  it("reordering enum values and required entries is not a change", () => {
    const before = makeSpec({
      components: {
        schemas: {
          S: { type: "object", required: ["a", "b"], properties: { a: { type: "string", enum: ["x", "y"] }, b: { type: "string" } } }
        }
      }
    });
    const after = makeSpec({
      components: {
        schemas: {
          S: { type: "object", required: ["b", "a"], properties: { b: { type: "string" }, a: { type: "string", enum: ["y", "x"] } } }
        }
      }
    });
    assert.deepEqual(analyze(before, after).changes, []);
  });

  it("inlining a schema that is structurally identical to its $ref target is not a change", () => {
    const withRef = makeSpec({
      paths: { "/a": { get: { operationId: "a", responses: jsonResponse({ $ref: "#/components/schemas/S" }) } } },
      components: { schemas: { S: { type: "object", properties: { id: { type: "string" } } } } }
    });
    const inlined = makeSpec({
      paths: {
        "/a": { get: { operationId: "a", responses: jsonResponse({ type: "object", properties: { id: { type: "string" } } }) } }
      },
      components: { schemas: { S: { type: "object", properties: { id: { type: "string" } } } } }
    });
    assert.deepEqual(analyze(withRef, inlined).changes, []);
  });

  it("an extra hop in a $ref chain is not a change", () => {
    const direct = makeSpec({
      paths: { "/a": { get: { operationId: "a", responses: jsonResponse({ $ref: "#/components/schemas/Target" }) } } },
      components: { schemas: { Target: { type: "object", properties: { id: { type: "string" } } } } }
    });
    const indirect = makeSpec({
      paths: { "/a": { get: { operationId: "a", responses: jsonResponse({ $ref: "#/components/schemas/Alias" }) } } },
      components: {
        schemas: {
          Alias: { $ref: "#/components/schemas/Target" },
          Target: { type: "object", properties: { id: { type: "string" } } }
        }
      }
    });
    const changes = analyze(direct, indirect).changes.filter((c) => c.kind !== "component");
    assert.deepEqual(changes, []);
  });
});

describe("invariant: results are deterministic", () => {
  const mutated = () => {
    const next = JSON.parse(JSON.stringify(RICH_SPEC));
    next.info.version = "2.0.0";
    next.servers = [{ url: "https://api.example.com/v2" }];
    delete next.components.schemas.User.properties.email;
    next.components.schemas.User.required = ["id"];
    next.components.schemas.User.properties.emailAddress = { type: "string", format: "email" };
    next.components.schemas.User.properties.status.enum = ["active", "closed"];
    next.paths["/users/{id}"].get.parameters[0].required = true;
    return loadFromString(JSON.stringify(next));
  };

  it("produces byte-identical output across repeated runs", () => {
    const first = JSON.stringify(analyzeSpecChange(richSpec(), mutated()));
    for (let i = 0; i < 10; i += 1) {
      assert.equal(JSON.stringify(analyzeSpecChange(richSpec(), mutated())), first);
    }
  });

  it("assigns stable ids that do not depend on run order", () => {
    const a = analyzeSpecChange(richSpec(), mutated()).changes.map((c) => c.id);
    const b = analyzeSpecChange(richSpec(), mutated()).changes.map((c) => c.id);
    assert.deepEqual(a, b);
    assert.equal(new Set(a).size, a.length, "change ids must be unique");
  });

  it("emits changes in a stable sorted order", () => {
    const changes = analyzeSpecChange(richSpec(), mutated()).changes;
    const paths = changes.map((c) => c.location.displayPath);
    assert.deepEqual(paths, [...paths].sort());
  });

  it("is not affected by document key order", () => {
    const shuffle = (value: any): any => {
      if (Array.isArray(value)) return value.map(shuffle);
      if (value === null || typeof value !== "object") return value;
      const entries = Object.entries(value).reverse();
      return Object.fromEntries(entries.map(([k, v]) => [k, shuffle(v)]));
    };
    const shuffledOld = loadFromString(JSON.stringify(shuffle(RICH_SPEC)));
    const normal = analyzeSpecChange(richSpec(), mutated());
    const shuffled = analyzeSpecChange(shuffledOld, mutated());
    assert.deepEqual(
      shuffled.changes.map((c) => `${c.rule}@${c.location.displayPath}`),
      normal.changes.map((c) => `${c.rule}@${c.location.displayPath}`)
    );
  });
});

describe("invariant: every change is fully explained", () => {
  const mutated = () => {
    const next = JSON.parse(JSON.stringify(RICH_SPEC));
    next.components.schemas.User.properties.status.enum = ["active"];
    next.components.schemas.User.properties.id.type = "integer";
    delete next.paths["/users/{id}"].get.responses["404"];
    next.paths["/users/{id}"].get.parameters[0].required = true;
    next.components.schemas.Order.properties.total.minimum = 10;
    return loadFromString(JSON.stringify(next));
  };

  it("attaches a rule, location, reason, direction and confidence to every change", () => {
    const analysis = analyzeSpecChange(richSpec(), mutated());
    assert.ok(analysis.changes.length > 0);
    for (const change of analysis.changes) {
      assert.ok(RULE_CATALOG[change.rule], `unknown rule ${change.rule}`);
      assert.ok(change.location.displayPath.length > 0, "every change needs a location");
      assert.ok(change.reason.length > 10, `reason too short for ${change.rule}`);
      assert.ok(["request", "response", "both", "unknown"].includes(change.direction));
      assert.ok(["HIGH", "MEDIUM", "LOW", "UNKNOWN"].includes(change.confidence));
      assert.equal(change.breaking, change.severity === "BREAKING");
      assert.equal(typeof change.id, "string");
      assert.equal(change.id.length, 16);
    }
  });

  it("locates operation-level changes with path, method and operationId", () => {
    const analysis = analyzeSpecChange(richSpec(), mutated());
    const operationChanges = analysis.changes.filter((c) => c.location.path !== undefined);
    assert.ok(operationChanges.length > 0);
    for (const change of operationChanges) {
      assert.ok(change.location.method, `missing method on ${change.rule}`);
      assert.ok(change.location.operationId, `missing operationId on ${change.rule}`);
    }
  });

  it("keeps a summary consistent with the change list", () => {
    const analysis = analyzeSpecChange(richSpec(), mutated());
    const { summary, changes } = analysis;
    assert.equal(summary.total, changes.length);
    assert.equal(summary.breaking, changes.filter((c) => c.severity === "BREAKING").length);
    assert.equal(summary.conditional, changes.filter((c) => c.severity === "CONDITIONAL").length);
    assert.equal(summary.nonBreaking, changes.filter((c) => c.severity === "NON_BREAKING").length);
    assert.equal(summary.unknown, changes.filter((c) => c.severity === "UNKNOWN").length);
  });
});

describe("OpenAPI 3.1", () => {
  const v31 = (schema: any): OpenApiDocument =>
    makeSpec({
      openapi: "3.1.0",
      paths: {
        "/things": {
          post: { operationId: "createThing", requestBody: jsonBody(schema), responses: { "200": { description: "OK" } } }
        }
      }
    });

  it("analyses a 3.1 document", () => {
    const before = v31({ type: ["string", "null"] });
    const after = v31({ type: "string" });
    const changes = analyze(before, after).changes;
    assert.equal(changes.length, 1);
    assert.equal(changes[0].rule, "NULLABLE_REMOVED");
    assert.equal(changes[0].severity, "BREAKING");
  });

  it("handles 3.1 numeric exclusive bounds", () => {
    const before = v31({ type: "number", exclusiveMinimum: 0 });
    const after = v31({ type: "number", exclusiveMinimum: 10 });
    const changes = analyze(before, after).changes;
    assert.equal(changes[0].rule, "NUMERIC_RANGE_NARROWED");
  });

  it("treats a 3.0 document and its 3.1 equivalent as the same API", () => {
    const v30Document = makeSpec({
      openapi: "3.0.3",
      paths: {
        "/things": {
          post: {
            operationId: "createThing",
            requestBody: jsonBody({ type: "object", properties: { name: { type: "string", nullable: true } } }),
            responses: { "200": { description: "OK" } }
          }
        }
      }
    });
    const v31Document = makeSpec({
      openapi: "3.1.0",
      paths: {
        "/things": {
          post: {
            operationId: "createThing",
            requestBody: jsonBody({ type: "object", properties: { name: { type: ["string", "null"] } } }),
            responses: { "200": { description: "OK" } }
          }
        }
      }
    });
    assert.deepEqual(analyze(v30Document, v31Document).changes, []);
  });
});
