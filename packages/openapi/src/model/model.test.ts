import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenAPIError } from "@capibara/shared";
import { buildApiModel } from "../model/build.js";
import { classifyRef, escapePointerSegment, pointer, resolvePointer } from "../model/refs.js";
import { loadFromString } from "../spec-loader.js";
import { makeSpec, jsonBody, jsonResponse } from "../testing/fixtures.js";
import { DEFAULT_LIMITS } from "../limits.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

describe("JSON pointers and $ref classification", () => {
  it("escapes and builds pointers", () => {
    assert.equal(escapePointerSegment("/users/{id}"), "~1users~1{id}");
    assert.equal(escapePointerSegment("a~b"), "a~0b");
    assert.equal(pointer("#", "paths", "/users", "get"), "#/paths/~1users/get");
  });

  it("classifies internal references", () => {
    assert.deepEqual(classifyRef("#/components/schemas/User"), {
      kind: "internal",
      segments: ["components", "schemas", "User"]
    });
  });

  it("classifies every non-fragment reference as external", () => {
    for (const ref of [
      "https://example.com/api.yaml#/x",
      "http://169.254.169.254/latest/meta-data",
      "file:///etc/passwd",
      "common.yaml#/components/schemas/Error",
      "../shared/models.yaml",
      "urn:example:schema"
    ]) {
      assert.equal(classifyRef(ref).kind, "external", `${ref} must be external`);
    }
  });

  it("treats malformed fragments as external rather than guessing", () => {
    assert.equal(classifyRef("#").kind, "external");
    assert.equal(classifyRef("#not-a-pointer").kind, "external");
    assert.equal(classifyRef("").kind, "external");
  });

  it("resolves pointers using own properties only", () => {
    const document = JSON.parse('{"a":{"b":[1,2,3]}}');
    assert.deepEqual(resolvePointer(document, ["a", "b"]), [1, 2, 3]);
    assert.equal(resolvePointer(document, ["a", "b", "1"]), 2);
    assert.equal(resolvePointer(document, ["a", "missing"]), undefined);
    assert.equal(resolvePointer(document, ["constructor"]), undefined);
    assert.equal(resolvePointer(document, ["a", "toString"]), undefined);
  });
});

describe("canonical model", () => {
  it("indexes operations by method and path, sorted deterministically", () => {
    const model = buildApiModel(
      makeSpec({
        paths: {
          "/z": { get: { responses: { "200": { description: "OK" } } } },
          "/a": {
            post: { responses: { "200": { description: "OK" } } },
            get: { responses: { "200": { description: "OK" } } }
          }
        }
      })
    );
    assert.deepEqual(
      model.operations.map((op) => op.key),
      ["GET /a", "GET /z", "POST /a"]
    );
  });

  it("merges path-level parameters and lets operation-level ones win", () => {
    const model = buildApiModel(
      makeSpec({
        paths: {
          "/things/{id}": {
            parameters: [
              { name: "id", in: "path", required: true, schema: { type: "string" } },
              { name: "trace", in: "header", schema: { type: "string" } }
            ],
            get: {
              parameters: [{ name: "trace", in: "header", required: true, schema: { type: "string" } }],
              responses: { "200": { description: "OK" } }
            }
          }
        }
      })
    );
    const parameters = model.operations[0].parameters;
    assert.deepEqual(
      parameters.map((p) => `${p.in}:${p.name}:${p.required}`),
      ["header:trace:true", "path:id:true"]
    );
  });

  it("treats a path parameter as required even when the flag is absent", () => {
    const model = buildApiModel(
      makeSpec({
        paths: {
          "/things/{id}": {
            get: {
              parameters: [{ name: "id", in: "path", schema: { type: "string" } }],
              responses: { "200": { description: "OK" } }
            }
          }
        }
      })
    );
    assert.equal(model.operations[0].parameters[0].required, true);
  });

  it("keeps every media type rather than only the first", () => {
    const model = buildApiModel(
      makeSpec({
        paths: {
          "/things": {
            post: {
              requestBody: {
                required: true,
                content: {
                  "application/json": { schema: { type: "object" } },
                  "application/xml": { schema: { type: "object" } }
                }
              },
              responses: { "200": { description: "OK" } }
            }
          }
        }
      })
    );
    assert.deepEqual(
      model.operations[0].requestBody?.content.map((c) => c.mediaType),
      ["application/json", "application/xml"]
    );
  });
});

describe("reference resolution", () => {
  it("resolves a chain A -> B -> C to the final target", () => {
    const model = buildApiModel(
      makeSpec({
        paths: { "/a": { get: { responses: jsonResponse({ $ref: "#/components/schemas/A" }) } } },
        components: {
          schemas: {
            A: { $ref: "#/components/schemas/B" },
            B: { $ref: "#/components/schemas/C" },
            C: { type: "object", properties: { value: { type: "string" } } }
          }
        }
      })
    );
    const schemaId = model.operations[0].responses[0].content[0].schema!;
    assert.equal(schemaId, "#/components/schemas/C");
    assert.deepEqual(model.registry.get(schemaId)!.types, ["object"]);
  });

  it("terminates on a self-recursive schema", () => {
    const model = buildApiModel(
      makeSpec({
        paths: { "/n": { get: { responses: jsonResponse({ $ref: "#/components/schemas/Node" }) } } },
        components: {
          schemas: {
            Node: {
              type: "object",
              properties: {
                value: { type: "string" },
                children: { type: "array", items: { $ref: "#/components/schemas/Node" } }
              }
            }
          }
        }
      })
    );
    const node = model.registry.get("#/components/schemas/Node")!;
    const children = model.registry.get(node.properties.get("children")!)!;
    assert.equal(children.items, "#/components/schemas/Node");
  });

  it("terminates on a mutually recursive pair A -> B -> A", () => {
    const model = buildApiModel(
      makeSpec({
        paths: { "/a": { get: { responses: jsonResponse({ $ref: "#/components/schemas/A" }) } } },
        components: {
          schemas: {
            A: { type: "object", properties: { b: { $ref: "#/components/schemas/B" } } },
            B: { type: "object", properties: { a: { $ref: "#/components/schemas/A" } } }
          }
        }
      })
    );
    const a = model.registry.get("#/components/schemas/A")!;
    const b = model.registry.get(a.properties.get("b")!)!;
    assert.equal(b.properties.get("a"), "#/components/schemas/A");
  });

  it("preserves provenance: a shared schema keeps one canonical id", () => {
    const model = buildApiModel(
      makeSpec({
        paths: {
          "/users": {
            get: { responses: jsonResponse({ $ref: "#/components/schemas/User" }) },
            post: {
              requestBody: jsonBody({ $ref: "#/components/schemas/User" }),
              responses: { "200": { description: "OK" } }
            }
          }
        },
        components: { schemas: { User: { type: "object", properties: { id: { type: "string" } } } } }
      })
    );
    const get = model.operations.find((op) => op.method === "get")!;
    const post = model.operations.find((op) => op.method === "post")!;
    assert.equal(get.responses[0].content[0].schema, "#/components/schemas/User");
    assert.equal(post.requestBody!.content[0].schema, "#/components/schemas/User");
    assert.deepEqual(model.registry.get("#/components/schemas/User")!.origin, {
      kind: "component",
      name: "User"
    });
  });

  it("rejects an unresolvable internal reference instead of treating it as empty", () => {
    assert.throws(
      () =>
        buildApiModel(
          makeSpec({
            paths: { "/a": { get: { responses: jsonResponse({ $ref: "#/components/schemas/Missing" }) } } }
          })
        ),
      (error: unknown) => {
        assert.ok(error instanceof OpenAPIError);
        assert.equal(error.code, "OPENAPI_REF_UNRESOLVED");
        return true;
      }
    );
  });

  it("rejects a pure $ref cycle with no content", () => {
    assert.throws(
      () =>
        buildApiModel(
          makeSpec({
            paths: { "/a": { get: { responses: jsonResponse({ $ref: "#/components/schemas/A" }) } } },
            components: { schemas: { A: { $ref: "#/components/schemas/B" }, B: { $ref: "#/components/schemas/A" } } }
          })
        ),
      (error: unknown) => {
        assert.equal((error as OpenAPIError).code, "OPENAPI_REF_CYCLE");
        return true;
      }
    );
  });

  it("marks external references as unsupported and never fetches them", () => {
    const model = buildApiModel(
      makeSpec({
        paths: { "/a": { get: { responses: jsonResponse({ $ref: "https://evil.example/schema.json" }) } } }
      })
    );
    const schemaId = model.operations[0].responses[0].content[0].schema!;
    assert.deepEqual(model.registry.get(schemaId)!.origin, {
      kind: "external",
      ref: "https://evil.example/schema.json"
    });
    assert.equal(model.unsupported.some((u) => u.feature === "external-$ref"), true);
  });
});

describe("normalisation", () => {
  it("is deterministic: the same document always builds the same model", () => {
    const document = makeSpec({
      paths: {
        "/things": {
          post: {
            operationId: "create",
            requestBody: jsonBody({
              type: "object",
              required: ["b", "a"],
              properties: { b: { type: "string" }, a: { type: "integer" } }
            }),
            responses: jsonResponse({ type: "object", properties: { z: { type: "string" } } })
          }
        }
      }
    });
    const first = JSON.stringify(serialise(buildApiModel(document)));
    for (let i = 0; i < 5; i += 1) {
      assert.equal(JSON.stringify(serialise(buildApiModel(document))), first);
    }
  });

  it("normalises key order away", () => {
    const a = loadFromString(
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "T", version: "1" },
        paths: { "/x": { get: { operationId: "x", responses: { "200": { description: "OK" } } } } }
      })
    );
    const b = loadFromString(
      JSON.stringify({
        paths: { "/x": { get: { responses: { "200": { description: "OK" } }, operationId: "x" } } },
        info: { version: "1", title: "T" },
        openapi: "3.0.3"
      })
    );
    assert.deepEqual(serialise(buildApiModel(a)), serialise(buildApiModel(b)));
  });

  it("sorts enum values so re-ordering is not a change", () => {
    const a = buildApiModel(makeSpec({ components: { schemas: { S: { enum: ["b", "a", "c"] } } } }));
    const b = buildApiModel(makeSpec({ components: { schemas: { S: { enum: ["c", "b", "a"] } } } }));
    assert.deepEqual(a.registry.get("#/components/schemas/S")!.enum, ["a", "b", "c"]);
    assert.deepEqual(
      a.registry.get("#/components/schemas/S")!.enum,
      b.registry.get("#/components/schemas/S")!.enum
    );
  });

  it("treats 3.0 nullable and 3.1 type arrays as the same statement", () => {
    const v30 = buildApiModel(
      makeSpec({ openapi: "3.0.3", components: { schemas: { S: { type: "string", nullable: true } } } })
    );
    const v31 = buildApiModel(
      makeSpec({ openapi: "3.1.0", components: { schemas: { S: { type: ["string", "null"] } } } })
    );
    const a = v30.registry.get("#/components/schemas/S")!;
    const b = v31.registry.get("#/components/schemas/S")!;
    assert.deepEqual(a.types, ["string"]);
    assert.deepEqual(b.types, ["string"]);
    assert.equal(a.nullable, true);
    assert.equal(b.nullable, true);
  });

  it("ignores `nullable` in 3.1, where the keyword has no meaning", () => {
    const model = buildApiModel(
      makeSpec({ openapi: "3.1.0", components: { schemas: { S: { type: "string", nullable: true } } } })
    );
    assert.equal(model.registry.get("#/components/schemas/S")!.nullable, false);
  });

  it("normalises 3.0 boolean exclusiveMinimum into a numeric bound", () => {
    const v30 = buildApiModel(
      makeSpec({
        openapi: "3.0.3",
        components: { schemas: { S: { type: "number", minimum: 5, exclusiveMinimum: true } } }
      })
    );
    const v31 = buildApiModel(
      makeSpec({ openapi: "3.1.0", components: { schemas: { S: { type: "number", exclusiveMinimum: 5 } } } })
    );
    assert.deepEqual(v30.registry.get("#/components/schemas/S")!.numeric, { exclusiveMinimum: 5 });
    assert.deepEqual(v31.registry.get("#/components/schemas/S")!.numeric, { exclusiveMinimum: 5 });
  });

  it("preserves everything a migration needs", () => {
    const model = buildApiModel(
      makeSpec({
        paths: {
          "/things/{id}": {
            get: {
              operationId: "getThing",
              parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
              responses: jsonResponse({
                type: "object",
                required: ["status"],
                properties: { status: { type: "string", enum: ["active", "closed"] } }
              })
            }
          }
        }
      })
    );
    const operation = model.operations[0];
    assert.equal(operation.operationId, "getThing");
    assert.equal(operation.parameters[0].name, "id");
    assert.equal(operation.responses[0].statusCode, "200");
    const schema = model.registry.get(operation.responses[0].content[0].schema!)!;
    assert.ok(schema.required.has("status"));
    const status = model.registry.get(schema.properties.get("status")!)!;
    assert.deepEqual(status.enum, ["active", "closed"]);
  });
});

describe("conflicting definitions", () => {
  it("rejects a duplicate operationId", () => {
    assert.throws(
      () =>
        buildApiModel(
          makeSpec({
            paths: {
              "/a": { get: { operationId: "same", responses: { "200": { description: "OK" } } } },
              "/b": { get: { operationId: "same", responses: { "200": { description: "OK" } } } }
            }
          })
        ),
      (error: unknown) => {
        assert.equal((error as OpenAPIError).code, "OPENAPI_DUPLICATE_OPERATION_ID");
        return true;
      }
    );
  });

  it("rejects a duplicate parameter", () => {
    assert.throws(
      () =>
        buildApiModel(
          makeSpec({
            paths: {
              "/a": {
                get: {
                  parameters: [
                    { name: "q", in: "query", schema: { type: "string" } },
                    { name: "q", in: "query", schema: { type: "integer" } }
                  ],
                  responses: { "200": { description: "OK" } }
                }
              }
            }
          })
        ),
      (error: unknown) => {
        assert.equal((error as OpenAPIError).code, "OPENAPI_DUPLICATE_PARAMETER");
        return true;
      }
    );
  });

  it("rejects an unknown parameter location", () => {
    assert.throws(
      () =>
        buildApiModel(
          makeSpec({
            paths: {
              "/a": {
                get: {
                  parameters: [{ name: "q", in: "body", schema: { type: "string" } }],
                  responses: { "200": { description: "OK" } }
                }
              }
            }
          })
        ),
      /Unknown parameter location/
    );
  });
});

describe("unsupported constructs", () => {
  it("records unanalysed keywords instead of ignoring them", () => {
    const model = buildApiModel(
      makeSpec({ components: { schemas: { S: { type: "object", not: { type: "string" } } } } })
    );
    const node = model.registry.get("#/components/schemas/S")!;
    assert.deepEqual(node.unsupported, ["not"]);
    assert.ok(node.unsupportedSignature);
    assert.ok(model.unsupported.some((u) => u.feature === "not"));
  });

  it("records discriminator as unanalysed", () => {
    const model = buildApiModel(
      makeSpec({
        components: {
          schemas: { S: { oneOf: [{ type: "object" }], discriminator: { propertyName: "kind" } } }
        }
      })
    );
    assert.ok(model.registry.get("#/components/schemas/S")!.unsupported.includes("discriminator"));
  });
});

describe("resource limits", () => {
  it("rejects a schema nested past the depth limit", () => {
    let schema: any = { type: "string" };
    for (let i = 0; i < 150; i += 1) schema = { type: "object", properties: { child: schema } };
    assert.throws(
      () => buildApiModel(makeSpec({ components: { schemas: { Deep: schema } } })),
      (error: unknown) => {
        assert.equal((error as OpenAPIError).code, "OPENAPI_SCHEMA_TOO_DEEP");
        return true;
      }
    );
  });

  it("rejects an enum larger than the limit", () => {
    const values = Array.from({ length: 20 }, (_, i) => `v${i}`);
    assert.throws(
      () =>
        buildApiModel(makeSpec({ components: { schemas: { S: { enum: values } } } }), {
          limits: { ...DEFAULT_LIMITS, maxEnumValues: 10 }
        }),
      /Enum exceeds/
    );
  });

  it("rejects a document with more operations than the limit", () => {
    const paths: Record<string, any> = {};
    for (let i = 0; i < 30; i += 1) paths[`/p${i}`] = { get: { responses: { "200": { description: "OK" } } } };
    assert.throws(
      () => buildApiModel(makeSpec({ paths }), { limits: { ...DEFAULT_LIMITS, maxOperations: 10 } }),
      /more than 10 operations/
    );
  });
});

/** Stable, comparable projection of a model, used for determinism assertions. */
function serialise(model: ReturnType<typeof buildApiModel>): unknown {
  return {
    operations: model.operations.map((op) => ({
      key: op.key,
      operationId: op.operationId,
      parameters: op.parameters.map((p) => [p.in, p.name, p.required]),
      requestBody: op.requestBody?.content.map((c) => [c.mediaType, c.schema]),
      responses: op.responses.map((r) => [r.statusCode, r.content.map((c) => [c.mediaType, c.schema])])
    })),
    schemas: model.registry.ids().map((id) => {
      const node = model.registry.get(id)!;
      return [
        id,
        node.types,
        node.nullable,
        node.format ?? null,
        node.enum ?? null,
        [...node.properties.entries()],
        [...node.required].sort(),
        node.numeric,
        node.string,
        node.array
      ];
    })
  };
}
