import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyze,
  diffRequestSchema,
  diffResponseSchema,
  expectNoRule,
  expectRule,
  findRule,
  jsonBody,
  jsonResponse,
  makeSpec,
  requestSpec,
  responseSpec
} from "../testing/fixtures.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const objectWith = (properties: any, required: string[] = []) => ({
  type: "object",
  ...(required.length > 0 ? { required } : {}),
  properties
});

describe("property presence", () => {
  it("removing a response property is breaking", () => {
    const changes = diffResponseSchema(
      objectWith({ id: { type: "string" }, email: { type: "string" } }),
      objectWith({ id: { type: "string" } })
    );
    const change = expectRule(changes, "PROPERTY_REMOVED", "BREAKING");
    assert.equal(change.direction, "response");
    assert.equal(change.location.propertyName, "email");
    assert.match(change.location.displayPath, /responses\.200\.content\.application\/json\.schema\.email$/);
  });

  it("removing a request property is conditional, not breaking", () => {
    const changes = diffRequestSchema(
      objectWith({ id: { type: "string" }, email: { type: "string" } }),
      objectWith({ id: { type: "string" } })
    );
    const change = expectRule(changes, "PROPERTY_REMOVED", "CONDITIONAL");
    assert.equal(change.breaking, false);
  });

  it("removing a request property from a closed object IS breaking", () => {
    const changes = diffRequestSchema(
      { ...objectWith({ id: { type: "string" }, email: { type: "string" } }), additionalProperties: false },
      { ...objectWith({ id: { type: "string" } }), additionalProperties: false }
    );
    expectRule(changes, "PROPERTY_REMOVED_FROM_CLOSED_OBJECT", "BREAKING");
    expectNoRule(changes, "PROPERTY_REMOVED");
  });

  it("adding an optional request property is not breaking", () => {
    const changes = diffRequestSchema(objectWith({ id: { type: "string" } }), objectWith({ id: { type: "string" }, memo: { type: "string" } }));
    expectRule(changes, "PROPERTY_ADDED", "NON_BREAKING");
    expectNoRule(changes, "REQUIRED_PROPERTY_ADDED");
  });

  it("adding a required request property is breaking", () => {
    const changes = diffRequestSchema(
      objectWith({ id: { type: "string" } }),
      objectWith({ id: { type: "string" }, memo: { type: "string" } }, ["memo"])
    );
    expectRule(changes, "REQUIRED_PROPERTY_ADDED", "BREAKING");
  });

  it("adding a required RESPONSE property is not breaking (direction matters)", () => {
    const changes = diffResponseSchema(
      objectWith({ id: { type: "string" } }),
      objectWith({ id: { type: "string" }, memo: { type: "string" } }, ["memo"])
    );
    expectRule(changes, "REQUIRED_PROPERTY_ADDED", "NON_BREAKING");
  });

  it("adding a response property is not breaking", () => {
    const changes = diffResponseSchema(objectWith({ id: { type: "string" } }), objectWith({ id: { type: "string" }, memo: { type: "string" } }));
    expectRule(changes, "PROPERTY_ADDED", "NON_BREAKING");
  });
});

describe("required transitions are not symmetric", () => {
  const before = objectWith({ a: { type: "string" } });
  const optional = objectWith({ a: { type: "string" } });
  const required = objectWith({ a: { type: "string" } }, ["a"]);

  it("request: optional -> required is breaking", () => {
    expectRule(diffRequestSchema(optional, required), "PROPERTY_MADE_REQUIRED", "BREAKING");
  });

  it("request: required -> optional is not breaking", () => {
    expectRule(diffRequestSchema(required, optional), "PROPERTY_MADE_OPTIONAL", "NON_BREAKING");
  });

  it("response: optional -> required is not breaking", () => {
    expectRule(diffResponseSchema(optional, required), "PROPERTY_MADE_REQUIRED", "NON_BREAKING");
  });

  it("response: required -> optional IS breaking", () => {
    expectRule(diffResponseSchema(required, optional), "PROPERTY_MADE_OPTIONAL", "BREAKING");
  });

  it("no change when required status is unchanged", () => {
    expectNoRule(diffRequestSchema(before, optional), "PROPERTY_MADE_REQUIRED");
    expectNoRule(diffRequestSchema(before, optional), "PROPERTY_MADE_OPTIONAL");
  });
});

describe("types", () => {
  it("an incompatible type change is breaking in both directions", () => {
    expectRule(diffRequestSchema({ type: "string" }, { type: "boolean" }), "TYPE_CHANGED", "BREAKING");
    expectRule(diffResponseSchema({ type: "string" }, { type: "boolean" }), "TYPE_CHANGED", "BREAKING");
  });

  it("integer -> number widens: safe for requests, breaking for responses", () => {
    expectRule(diffRequestSchema({ type: "integer" }, { type: "number" }), "TYPE_WIDENED", "NON_BREAKING");
    expectRule(diffResponseSchema({ type: "integer" }, { type: "number" }), "TYPE_WIDENED", "BREAKING");
  });

  it("number -> integer narrows: breaking for requests, safe for responses", () => {
    expectRule(diffRequestSchema({ type: "number" }, { type: "integer" }), "TYPE_NARROWED", "BREAKING");
    expectRule(diffResponseSchema({ type: "number" }, { type: "integer" }), "TYPE_NARROWED", "NON_BREAKING");
  });

  it("constraining an unspecified type narrows", () => {
    expectRule(diffRequestSchema({}, { type: "string" }), "TYPE_NARROWED", "BREAKING");
  });

  it("removing the type keyword widens", () => {
    expectRule(diffResponseSchema({ type: "string" }, {}), "TYPE_WIDENED", "BREAKING");
  });

  it("identical types produce no change", () => {
    assert.deepEqual(diffRequestSchema({ type: "string" }, { type: "string" }), []);
  });
});

describe("nullability", () => {
  it("response becoming nullable is breaking", () => {
    expectRule(
      diffResponseSchema({ type: "string" }, { type: "string", nullable: true }),
      "NULLABLE_ADDED",
      "BREAKING"
    );
  });

  it("request becoming nullable is not breaking", () => {
    expectRule(
      diffRequestSchema({ type: "string" }, { type: "string", nullable: true }),
      "NULLABLE_ADDED",
      "NON_BREAKING"
    );
  });

  it("request losing nullability is breaking", () => {
    expectRule(
      diffRequestSchema({ type: "string", nullable: true }, { type: "string" }),
      "NULLABLE_REMOVED",
      "BREAKING"
    );
  });

  it("response losing nullability is not breaking", () => {
    expectRule(
      diffResponseSchema({ type: "string", nullable: true }, { type: "string" }),
      "NULLABLE_REMOVED",
      "NON_BREAKING"
    );
  });
});

describe("enums", () => {
  it("removing a request enum value is breaking", () => {
    const change = expectRule(
      diffRequestSchema({ type: "string", enum: ["a", "b"] }, { type: "string", enum: ["a"] }),
      "ENUM_VALUE_REMOVED",
      "BREAKING"
    );
    assert.equal(change.oldValue, "b");
  });

  it("removing a response enum value is conditional, not breaking", () => {
    const change = expectRule(
      diffResponseSchema({ type: "string", enum: ["a", "b"] }, { type: "string", enum: ["a"] }),
      "ENUM_VALUE_REMOVED",
      "CONDITIONAL"
    );
    assert.equal(change.breaking, false);
  });

  it("adding a request enum value is not breaking", () => {
    expectRule(
      diffRequestSchema({ type: "string", enum: ["a"] }, { type: "string", enum: ["a", "b"] }),
      "ENUM_VALUE_ADDED",
      "NON_BREAKING"
    );
  });

  it("adding a response enum value is conditional (exhaustive handling)", () => {
    expectRule(
      diffResponseSchema({ type: "string", enum: ["a"] }, { type: "string", enum: ["a", "b"] }),
      "ENUM_VALUE_ADDED",
      "CONDITIONAL"
    );
  });

  it("emits one change per value so a migration can act on each", () => {
    const changes = diffRequestSchema(
      { type: "string", enum: ["a", "b", "c"] },
      { type: "string", enum: ["a", "d"] }
    );
    const removed = changes.filter((c) => c.rule === "ENUM_VALUE_REMOVED").map((c) => c.oldValue);
    const added = changes.filter((c) => c.rule === "ENUM_VALUE_ADDED").map((c) => c.newValue);
    assert.deepEqual(removed.sort(), ["b", "c"]);
    assert.deepEqual(added, ["d"]);
  });

  it("introducing an enum constraint is breaking for requests", () => {
    expectRule(
      diffRequestSchema({ type: "string" }, { type: "string", enum: ["a"] }),
      "ENUM_CONSTRAINT_ADDED",
      "BREAKING"
    );
  });

  it("dropping an enum constraint is not breaking for requests but is conditional for responses", () => {
    expectRule(
      diffRequestSchema({ type: "string", enum: ["a"] }, { type: "string" }),
      "ENUM_CONSTRAINT_REMOVED",
      "NON_BREAKING"
    );
    expectRule(
      diffResponseSchema({ type: "string", enum: ["a"] }, { type: "string" }),
      "ENUM_CONSTRAINT_REMOVED",
      "CONDITIONAL"
    );
  });

  it("reordering enum values is not a change", () => {
    assert.deepEqual(
      diffRequestSchema({ type: "string", enum: ["a", "b", "c"] }, { type: "string", enum: ["c", "a", "b"] }),
      []
    );
  });
});

describe("additionalProperties", () => {
  it("closing an object breaks requests but not responses", () => {
    expectRule(
      diffRequestSchema({ type: "object" }, { type: "object", additionalProperties: false }),
      "ADDITIONAL_PROPERTIES_RESTRICTED",
      "BREAKING"
    );
    expectRule(
      diffResponseSchema({ type: "object" }, { type: "object", additionalProperties: false }),
      "ADDITIONAL_PROPERTIES_RESTRICTED",
      "NON_BREAKING"
    );
  });

  it("opening an object is safe for requests and conditional for responses", () => {
    expectRule(
      diffRequestSchema({ type: "object", additionalProperties: false }, { type: "object" }),
      "ADDITIONAL_PROPERTIES_RELAXED",
      "NON_BREAKING"
    );
    expectRule(
      diffResponseSchema({ type: "object", additionalProperties: false }, { type: "object" }),
      "ADDITIONAL_PROPERTIES_RELAXED",
      "CONDITIONAL"
    );
  });

  it("absent and true are the same value", () => {
    assert.deepEqual(diffRequestSchema({ type: "object" }, { type: "object", additionalProperties: true }), []);
  });
});

describe("numeric, length and array constraints", () => {
  it("raising a minimum narrows and breaks requests", () => {
    expectRule(
      diffRequestSchema({ type: "integer", minimum: 0 }, { type: "integer", minimum: 10 }),
      "NUMERIC_RANGE_NARROWED",
      "BREAKING"
    );
  });

  it("lowering a minimum widens and does not break requests", () => {
    expectRule(
      diffRequestSchema({ type: "integer", minimum: 10 }, { type: "integer", minimum: 0 }),
      "NUMERIC_RANGE_WIDENED",
      "NON_BREAKING"
    );
  });

  it("lowering a maximum narrows", () => {
    expectRule(
      diffRequestSchema({ type: "integer", maximum: 100 }, { type: "integer", maximum: 10 }),
      "NUMERIC_RANGE_NARROWED",
      "BREAKING"
    );
  });

  it("reports both directions when one bound tightens and the other loosens", () => {
    const changes = diffRequestSchema(
      { type: "integer", minimum: 0, maximum: 100 },
      { type: "integer", minimum: 10, maximum: 200 }
    );
    assert.ok(findRule(changes, "NUMERIC_RANGE_NARROWED"));
    assert.ok(findRule(changes, "NUMERIC_RANGE_WIDENED"));
  });

  it("treats an exclusive bound as tighter than an inclusive one", () => {
    expectRule(
      diffRequestSchema({ type: "number", minimum: 0 }, { type: "number", minimum: 0, exclusiveMinimum: true }),
      "NUMERIC_RANGE_NARROWED",
      "BREAKING"
    );
  });

  it("raising minLength narrows and breaks requests", () => {
    expectRule(
      diffRequestSchema({ type: "string", minLength: 1 }, { type: "string", minLength: 5 }),
      "LENGTH_RANGE_NARROWED",
      "BREAKING"
    );
  });

  it("raising maxLength widens and is safe for requests", () => {
    expectRule(
      diffRequestSchema({ type: "string", maxLength: 10 }, { type: "string", maxLength: 100 }),
      "LENGTH_RANGE_WIDENED",
      "NON_BREAKING"
    );
  });

  it("lowering maxLength on a response is not breaking", () => {
    expectRule(
      diffResponseSchema({ type: "string", maxLength: 100 }, { type: "string", maxLength: 10 }),
      "LENGTH_RANGE_NARROWED",
      "NON_BREAKING"
    );
  });

  it("tightening maxItems narrows the array", () => {
    expectRule(
      diffRequestSchema({ type: "array", maxItems: 100 }, { type: "array", maxItems: 10 }),
      "ITEMS_RANGE_NARROWED",
      "BREAKING"
    );
  });

  it("requiring unique items narrows", () => {
    expectRule(
      diffRequestSchema({ type: "array" }, { type: "array", uniqueItems: true }),
      "ITEMS_RANGE_NARROWED",
      "BREAKING"
    );
  });

  it("adding a pattern breaks requests but is only conditional for responses", () => {
    expectRule(diffRequestSchema({ type: "string" }, { type: "string", pattern: "^a" }), "PATTERN_ADDED", "BREAKING");
    expectRule(
      diffResponseSchema({ type: "string" }, { type: "string", pattern: "^a" }),
      "PATTERN_ADDED",
      "CONDITIONAL"
    );
  });

  it("changing a pattern is reported without a compatibility verdict", () => {
    const change = expectRule(
      diffRequestSchema({ type: "string", pattern: "^a" }, { type: "string", pattern: "^b" }),
      "PATTERN_CHANGED",
      "CONDITIONAL"
    );
    assert.equal(change.confidence, "LOW");
  });
});

describe("format, default, readOnly and writeOnly", () => {
  it("adding a format is conditional", () => {
    expectRule(
      diffRequestSchema({ type: "string" }, { type: "string", format: "date-time" }),
      "FORMAT_ADDED",
      "CONDITIONAL"
    );
  });

  it("changing a format is conditional in both directions", () => {
    expectRule(
      diffResponseSchema({ type: "integer", format: "int32" }, { type: "integer", format: "int64" }),
      "FORMAT_CHANGED",
      "CONDITIONAL"
    );
  });

  it("removing a format is safe for requests", () => {
    expectRule(
      diffRequestSchema({ type: "string", format: "uuid" }, { type: "string" }),
      "FORMAT_REMOVED",
      "NON_BREAKING"
    );
  });

  it("changing a default is conditional", () => {
    expectRule(
      diffRequestSchema({ type: "integer", default: 10 }, { type: "integer", default: 20 }),
      "DEFAULT_CHANGED",
      "CONDITIONAL"
    );
  });

  it("marking a property read-only breaks requests only", () => {
    expectRule(
      diffRequestSchema({ type: "string" }, { type: "string", readOnly: true }),
      "READ_ONLY_ADDED",
      "BREAKING"
    );
    expectRule(
      diffResponseSchema({ type: "string" }, { type: "string", readOnly: true }),
      "READ_ONLY_ADDED",
      "NON_BREAKING"
    );
  });

  it("marking a property write-only breaks responses only", () => {
    expectRule(
      diffResponseSchema({ type: "string" }, { type: "string", writeOnly: true }),
      "WRITE_ONLY_ADDED",
      "BREAKING"
    );
    expectRule(
      diffRequestSchema({ type: "string" }, { type: "string", writeOnly: true }),
      "WRITE_ONLY_ADDED",
      "NON_BREAKING"
    );
  });
});

describe("nested structures", () => {
  it("addresses a nested property change precisely", () => {
    const change = expectRule(
      diffResponseSchema(
        objectWith({ user: objectWith({ email: { type: "string" } }) }),
        objectWith({ user: objectWith({}) })
      ),
      "PROPERTY_REMOVED",
      "BREAKING"
    );
    assert.deepEqual(change.location.propertyPath, ["user", "email"]);
    assert.match(change.location.displayPath, /schema\.user\.email$/);
  });

  it("descends into array items", () => {
    const change = expectRule(
      diffResponseSchema(
        { type: "array", items: objectWith({ id: { type: "string" } }) },
        { type: "array", items: objectWith({}) }
      ),
      "PROPERTY_REMOVED",
      "BREAKING"
    );
    assert.deepEqual(change.location.propertyPath, ["[]", "id"]);
  });

  it("descends into additionalProperties schemas", () => {
    const change = expectRule(
      diffResponseSchema(
        { type: "object", additionalProperties: { type: "string" } },
        { type: "object", additionalProperties: { type: "integer" } }
      ),
      "TYPE_CHANGED",
      "BREAKING"
    );
    assert.deepEqual(change.location.propertyPath, ["additionalProperties"]);
  });

  it("merges allOf into a single object view", () => {
    const before = {
      allOf: [
        { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        { type: "object", properties: { email: { type: "string" } } }
      ]
    };
    const after = {
      allOf: [
        { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        { type: "object", properties: {} }
      ]
    };
    const change = expectRule(diffResponseSchema(before, after), "PROPERTY_REMOVED", "BREAKING");
    assert.equal(change.location.propertyName, "email");
  });

  it("reports oneOf member changes conservatively", () => {
    const before = { oneOf: [{ type: "string" }, { type: "integer" }] };
    const after = { oneOf: [{ type: "string" }] };
    const change = expectRule(diffRequestSchema(before, after), "COMPOSITION_MEMBER_REMOVED", "BREAKING");
    assert.equal(change.confidence, "LOW");
  });

  it("flags a switch between composition keywords as unknown", () => {
    const change = expectRule(
      diffRequestSchema({ oneOf: [{ type: "string" }] }, { anyOf: [{ type: "string" }] }),
      "COMPOSITION_KEYWORD_CHANGED",
      "UNKNOWN"
    );
    assert.equal(change.confidence, "UNKNOWN");
  });
});

describe("recursive schemas", () => {
  function recursive(extraProperties: any) {
    return makeSpec({
      paths: {
        "/nodes": { get: { operationId: "listNodes", responses: jsonResponse({ $ref: "#/components/schemas/Node" }) } }
      },
      components: {
        schemas: {
          Node: {
            type: "object",
            properties: {
              value: { type: "string" },
              children: { type: "array", items: { $ref: "#/components/schemas/Node" } },
              ...extraProperties
            }
          }
        }
      }
    });
  }

  it("terminates and finds the change on a self-recursive schema", () => {
    const changes = analyze(recursive({ label: { type: "string" } }), recursive({})).changes;
    const change = expectRule(changes, "PROPERTY_REMOVED", "BREAKING");
    assert.equal(change.location.propertyName, "label");
  });

  it("terminates on mutual recursion", () => {
    const build = (extra: any) =>
      makeSpec({
        paths: { "/a": { get: { operationId: "a", responses: jsonResponse({ $ref: "#/components/schemas/A" }) } } },
        components: {
          schemas: {
            A: { type: "object", properties: { b: { $ref: "#/components/schemas/B" }, ...extra } },
            B: { type: "object", properties: { a: { $ref: "#/components/schemas/A" } } }
          }
        }
      });
    const changes = analyze(build({ tag: { type: "string" } }), build({})).changes;
    expectRule(changes, "PROPERTY_REMOVED", "BREAKING");
  });

  it("produces no changes when a recursive schema is unchanged", () => {
    assert.deepEqual(analyze(recursive({}), recursive({})).changes, []);
  });
});

describe("rename hypotheses", () => {
  it("proposes a rename when both properties reference the same component", () => {
    const build = (name: string) =>
      makeSpec({
        paths: {
          "/a": {
            post: {
              operationId: "a",
              requestBody: jsonBody({ type: "object", properties: { [name]: { $ref: "#/components/schemas/Money" } } }),
              responses: { "200": { description: "OK" } }
            }
          }
        },
        components: { schemas: { Money: { type: "object", properties: { amount: { type: "integer" } } } } }
      });

    const analysis = analyze(build("source"), build("payment_method"));
    const rename = analysis.renameCandidates.find((r) => r.kind === "property");
    assert.ok(rename);
    assert.equal(rename.from, "source");
    assert.equal(rename.to, "payment_method");
    assert.equal(rename.confidence, "MEDIUM");
    assert.match(rename.evidence[0], /same component schema/);
  });

  it("proposes a rename for a single structurally identical swap", () => {
    const analysis = analyze(
      requestSpec(objectWith({ source: { type: "string" } })),
      requestSpec(objectWith({ payment_method: { type: "string" } }))
    );
    const rename = analysis.renameCandidates[0];
    assert.ok(rename);
    assert.equal(rename.confidence, "LOW");
    assert.equal(rename.evidence.length, 2);
  });

  it("never proposes a rename from name similarity alone", () => {
    // Similar names, different shapes: no hypothesis.
    const analysis = analyze(
      requestSpec(objectWith({ emailAddress: { type: "string" } })),
      requestSpec(objectWith({ emailVerified: { type: "boolean" } }))
    );
    assert.deepEqual(analysis.renameCandidates, []);
  });

  it("refuses to guess when several properties changed at once", () => {
    const analysis = analyze(
      requestSpec(objectWith({ a: { type: "string" }, b: { type: "string" } })),
      requestSpec(objectWith({ c: { type: "string" }, d: { type: "string" } }))
    );
    assert.deepEqual(analysis.renameCandidates, []);
  });

  it("always reports the authoritative removal and addition alongside a hypothesis", () => {
    const changes = analyze(
      requestSpec(objectWith({ source: { type: "string" } })),
      requestSpec(objectWith({ payment_method: { type: "string" } }))
    ).changes;
    assert.ok(findRule(changes, "PROPERTY_REMOVED"));
    assert.ok(findRule(changes, "PROPERTY_ADDED"));
  });
});

describe("unsupported constructs", () => {
  it("reports a change inside an unanalysed keyword as UNKNOWN", () => {
    const change = expectRule(
      diffRequestSchema({ type: "object", not: { type: "string" } }, { type: "object", not: { type: "integer" } }),
      "UNSUPPORTED_CONSTRUCT_CHANGED",
      "UNKNOWN"
    );
    assert.equal(change.confidence, "UNKNOWN");
    assert.deepEqual(change.metadata?.keywords, ["not"]);
  });

  it("still analyses the parts it does understand", () => {
    const changes = diffRequestSchema(
      { type: "object", not: { type: "string" }, properties: { a: { type: "string" } }, required: ["a"] },
      { type: "object", not: { type: "string" }, properties: { a: { type: "string" } } }
    );
    expectRule(changes, "PROPERTY_MADE_OPTIONAL", "NON_BREAKING");
  });

  it("reports a changed external reference as UNKNOWN and never resolves it", () => {
    const build = (ref: string) =>
      responseSpec({ type: "object", properties: { x: { $ref: ref } } });
    const change = expectRule(
      analyze(build("https://a.example/s.json"), build("https://b.example/s.json")).changes,
      "EXTERNAL_REFERENCE_CHANGED",
      "UNKNOWN"
    );
    assert.equal(change.oldValue, "https://a.example/s.json");
  });
});
