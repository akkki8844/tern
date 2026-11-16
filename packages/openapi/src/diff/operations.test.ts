import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyze,
  expectNoRule,
  expectRule,
  findRule,
  jsonBody,
  jsonResponse,
  makeSpec,
  rulesOf
} from "../testing/fixtures.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const OK = { "200": { description: "OK" } };

function withPaths(paths: Record<string, any>) {
  return makeSpec({ paths });
}

describe("paths and operations", () => {
  it("reports a removed path as breaking", () => {
    const before = withPaths({ "/a": { get: { responses: OK } }, "/b": { get: { responses: OK } } });
    const after = withPaths({ "/a": { get: { responses: OK } } });
    const change = expectRule(analyze(before, after).changes, "PATH_REMOVED", "BREAKING");
    assert.equal(change.location.path, "/b");
    assert.equal(change.confidence, "HIGH");
  });

  it("reports an added path as non-breaking", () => {
    const before = withPaths({ "/a": { get: { responses: OK } } });
    const after = withPaths({ "/a": { get: { responses: OK } }, "/b": { get: { responses: OK } } });
    expectRule(analyze(before, after).changes, "PATH_ADDED", "NON_BREAKING");
  });

  it("does not report an operation removal when the whole path went away", () => {
    const before = withPaths({ "/a": { get: { responses: OK } } });
    const after = withPaths({});
    const changes = analyze(before, after).changes;
    expectRule(changes, "PATH_REMOVED", "BREAKING");
    expectNoRule(changes, "OPERATION_REMOVED");
  });

  it("reports a removed method on a surviving path", () => {
    const before = withPaths({ "/a": { get: { responses: OK }, post: { responses: OK } } });
    const after = withPaths({ "/a": { get: { responses: OK } } });
    const change = expectRule(analyze(before, after).changes, "OPERATION_REMOVED", "BREAKING");
    assert.equal(change.location.method, "post");
  });

  it("reports an added method as non-breaking", () => {
    const before = withPaths({ "/a": { get: { responses: OK } } });
    const after = withPaths({ "/a": { get: { responses: OK }, post: { responses: OK } } });
    expectRule(analyze(before, after).changes, "OPERATION_ADDED", "NON_BREAKING");
  });

  it("treats an operationId change as conditional, not breaking", () => {
    const before = withPaths({ "/a": { get: { operationId: "listA", responses: OK } } });
    const after = withPaths({ "/a": { get: { operationId: "getAll", responses: OK } } });
    const analysis = analyze(before, after);
    const change = expectRule(analysis.changes, "OPERATION_ID_CHANGED", "CONDITIONAL");
    assert.equal(change.breaking, false);
    assert.equal(change.oldValue, "listA");
    assert.equal(change.newValue, "getAll");

    const rename = analysis.renameCandidates.find((r) => r.kind === "operationId");
    assert.ok(rename);
    assert.equal(rename.from, "listA");
    assert.equal(rename.to, "getAll");
    assert.equal(rename.confidence, "HIGH");
  });

  it("distinguishes operationId removal from a change", () => {
    const before = withPaths({ "/a": { get: { operationId: "listA", responses: OK } } });
    const after = withPaths({ "/a": { get: { responses: OK } } });
    expectRule(analyze(before, after).changes, "OPERATION_ID_REMOVED", "CONDITIONAL");
  });

  it("reports deprecation without calling it breaking", () => {
    const before = withPaths({ "/a": { get: { responses: OK } } });
    const after = withPaths({ "/a": { get: { deprecated: true, responses: OK } } });
    expectRule(analyze(before, after).changes, "OPERATION_DEPRECATED", "NON_BREAKING");
  });
});

describe("parameters", () => {
  const base = (parameters: any[]) => withPaths({ "/a": { get: { operationId: "a", parameters, responses: OK } } });

  it("adding a required parameter is breaking", () => {
    const before = base([]);
    const after = base([{ name: "since", in: "query", required: true, schema: { type: "string" } }]);
    const change = expectRule(analyze(before, after).changes, "REQUIRED_PARAMETER_ADDED", "BREAKING");
    assert.equal(change.direction, "request");
    assert.equal(change.location.parameterName, "since");
    assert.equal(change.location.parameterIn, "query");
  });

  it("adding an optional parameter is not breaking", () => {
    const before = base([]);
    const after = base([{ name: "since", in: "query", schema: { type: "string" } }]);
    const changes = analyze(before, after).changes;
    expectRule(changes, "OPTIONAL_PARAMETER_ADDED", "NON_BREAKING");
    expectNoRule(changes, "REQUIRED_PARAMETER_ADDED");
  });

  it("optional -> required is breaking", () => {
    const before = base([{ name: "q", in: "query", schema: { type: "string" } }]);
    const after = base([{ name: "q", in: "query", required: true, schema: { type: "string" } }]);
    expectRule(analyze(before, after).changes, "PARAMETER_MADE_REQUIRED", "BREAKING");
  });

  it("required -> optional is not breaking (the reverse is not symmetric)", () => {
    const before = base([{ name: "q", in: "query", required: true, schema: { type: "string" } }]);
    const after = base([{ name: "q", in: "query", schema: { type: "string" } }]);
    const changes = analyze(before, after).changes;
    expectRule(changes, "PARAMETER_MADE_OPTIONAL", "NON_BREAKING");
    expectNoRule(changes, "PARAMETER_MADE_REQUIRED");
  });

  it("removing a parameter is conditional, because servers usually ignore extras", () => {
    const before = base([{ name: "q", in: "query", schema: { type: "string" } }]);
    const after = base([]);
    const change = expectRule(analyze(before, after).changes, "PARAMETER_REMOVED", "CONDITIONAL");
    assert.equal(change.breaking, false);
  });

  it("moving a parameter between locations is breaking and reported once", () => {
    const before = base([{ name: "token", in: "query", required: true, schema: { type: "string" } }]);
    const after = base([{ name: "token", in: "header", required: true, schema: { type: "string" } }]);
    const changes = analyze(before, after).changes;
    const change = expectRule(changes, "PARAMETER_LOCATION_CHANGED", "BREAKING");
    assert.equal(change.oldValue, "query");
    assert.equal(change.newValue, "header");
    expectNoRule(changes, "PARAMETER_REMOVED");
    expectNoRule(changes, "REQUIRED_PARAMETER_ADDED");
  });

  it("diffs the parameter schema, not just its flags", () => {
    const before = base([{ name: "limit", in: "query", schema: { type: "integer" } }]);
    const after = base([{ name: "limit", in: "query", schema: { type: "string" } }]);
    const change = expectRule(analyze(before, after).changes, "TYPE_CHANGED", "BREAKING");
    assert.equal(change.direction, "request");
    assert.match(change.location.displayPath, /parameters\.query\.limit\.schema$/);
  });

  it("detects an enum removal inside a parameter schema", () => {
    const before = base([{ name: "sort", in: "query", schema: { type: "string", enum: ["asc", "desc"] } }]);
    const after = base([{ name: "sort", in: "query", schema: { type: "string", enum: ["asc"] } }]);
    const change = expectRule(analyze(before, after).changes, "ENUM_VALUE_REMOVED", "BREAKING");
    assert.equal(change.oldValue, "desc");
  });
});

describe("request bodies", () => {
  const withBody = (body: any) =>
    withPaths({ "/a": { post: { operationId: "a", ...(body ? { requestBody: body } : {}), responses: OK } } });

  it("adding a required body is breaking", () => {
    const change = expectRule(
      analyze(withBody(null), withBody(jsonBody({ type: "object" }, true))).changes,
      "REQUIRED_REQUEST_BODY_ADDED",
      "BREAKING"
    );
    assert.equal(change.direction, "request");
  });

  it("adding an optional body is not breaking", () => {
    expectRule(
      analyze(withBody(null), withBody(jsonBody({ type: "object" }, false))).changes,
      "OPTIONAL_REQUEST_BODY_ADDED",
      "NON_BREAKING"
    );
  });

  it("optional -> required body is breaking", () => {
    expectRule(
      analyze(withBody(jsonBody({ type: "object" }, false)), withBody(jsonBody({ type: "object" }, true))).changes,
      "REQUEST_BODY_MADE_REQUIRED",
      "BREAKING"
    );
  });

  it("required -> optional body is not breaking", () => {
    expectRule(
      analyze(withBody(jsonBody({ type: "object" }, true)), withBody(jsonBody({ type: "object" }, false))).changes,
      "REQUEST_BODY_MADE_OPTIONAL",
      "NON_BREAKING"
    );
  });

  it("removing a supported media type is breaking", () => {
    const before = withBody({
      required: true,
      content: { "application/json": { schema: { type: "object" } }, "application/xml": { schema: { type: "object" } } }
    });
    const after = withBody(jsonBody({ type: "object" }));
    const change = expectRule(analyze(before, after).changes, "REQUEST_MEDIA_TYPE_REMOVED", "BREAKING");
    assert.equal(change.oldValue, "application/xml");
  });

  it("adding a media type is not breaking", () => {
    const before = withBody(jsonBody({ type: "object" }));
    const after = withBody({
      required: true,
      content: { "application/json": { schema: { type: "object" } }, "application/xml": { schema: { type: "object" } } }
    });
    expectRule(analyze(before, after).changes, "REQUEST_MEDIA_TYPE_ADDED", "NON_BREAKING");
  });

  it("diffs each media type independently", () => {
    const before = withBody({
      required: true,
      content: {
        "application/json": { schema: { type: "object", properties: { a: { type: "string" } } } },
        "application/xml": { schema: { type: "object", properties: { a: { type: "string" } } } }
      }
    });
    const after = withBody({
      required: true,
      content: {
        "application/json": { schema: { type: "object", properties: { a: { type: "integer" } } } },
        "application/xml": { schema: { type: "object", properties: { a: { type: "string" } } } }
      }
    });
    const changes = analyze(before, after).changes.filter((c) => c.rule === "TYPE_CHANGED");
    assert.equal(changes.length, 1);
    assert.match(changes[0].location.displayPath, /content\.application\/json\.schema\.a$/);
  });
});

describe("responses", () => {
  const withResponses = (responses: any) => withPaths({ "/a": { get: { operationId: "a", responses } } });

  it("removing a success response is breaking", () => {
    const before = withResponses({ ...OK, "404": { description: "Missing" } });
    const after = withResponses({ "404": { description: "Missing" } });
    const change = expectRule(analyze(before, after).changes, "SUCCESS_RESPONSE_REMOVED", "BREAKING");
    assert.equal(change.location.statusCode, "200");
    assert.equal(change.direction, "response");
  });

  it("removing a non-success response is conditional, not breaking", () => {
    const before = withResponses({ ...OK, "404": { description: "Missing" } });
    const after = withResponses(OK);
    const change = expectRule(analyze(before, after).changes, "RESPONSE_REMOVED", "CONDITIONAL");
    assert.equal(change.breaking, false);
  });

  it("adding a response status is conditional", () => {
    const before = withResponses(OK);
    const after = withResponses({ ...OK, "429": { description: "Slow down" } });
    expectRule(analyze(before, after).changes, "RESPONSE_ADDED", "CONDITIONAL");
  });

  it("removing a response media type is breaking", () => {
    const before = withResponses({
      "200": {
        description: "OK",
        content: { "application/json": { schema: { type: "object" } }, "text/csv": { schema: { type: "string" } } }
      }
    });
    const after = withResponses(jsonResponse({ type: "object" }));
    expectRule(analyze(before, after).changes, "RESPONSE_MEDIA_TYPE_REMOVED", "BREAKING");
  });

  it("adding a response media type is not breaking", () => {
    const before = withResponses(jsonResponse({ type: "object" }));
    const after = withResponses({
      "200": {
        description: "OK",
        content: { "application/json": { schema: { type: "object" } }, "text/csv": { schema: { type: "string" } } }
      }
    });
    expectRule(analyze(before, after).changes, "RESPONSE_MEDIA_TYPE_ADDED", "NON_BREAKING");
  });
});

describe("components", () => {
  it("reports schema removal and addition", () => {
    const before = makeSpec({ components: { schemas: { Gone: { type: "object" } } } });
    const after = makeSpec({ components: { schemas: { Fresh: { type: "object" } } } });
    const changes = analyze(before, after).changes;
    expectRule(changes, "COMPONENT_SCHEMA_REMOVED", "CONDITIONAL");
    expectRule(changes, "COMPONENT_SCHEMA_ADDED", "NON_BREAKING");
  });

  it("reports a change to an unreferenced schema at the component location", () => {
    const before = makeSpec({
      components: { schemas: { Orphan: { type: "object", properties: { a: { type: "string" } } } } }
    });
    const after = makeSpec({ components: { schemas: { Orphan: { type: "object", properties: {} } } } });
    const change = expectRule(analyze(before, after).changes, "PROPERTY_REMOVED", "BREAKING");
    assert.equal(change.location.displayPath, "components.schemas.Orphan.a");
    assert.equal(change.location.componentSchema, "Orphan");
  });
});

describe("shared schemas across request and response", () => {
  /** One User schema used as a response by GET and as a request by POST. */
  function specWith(userProperties: any, required: string[] = []) {
    const document = withPaths({
      "/users": {
        get: { operationId: "listUsers", responses: jsonResponse({ $ref: "#/components/schemas/User" }) },
        post: {
          operationId: "createUser",
          requestBody: jsonBody({ $ref: "#/components/schemas/User" }),
          responses: OK
        }
      }
    }) as any;
    document.components = { schemas: { User: { type: "object", required, properties: userProperties } } };
    return document;
  }

  it("classifies the same schema change differently in each direction", () => {
    const before = specWith({ id: { type: "string" }, email: { type: "string" } });
    const after = specWith({ id: { type: "string" } });
    const changes = analyze(before, after).changes.filter((c) => c.rule === "PROPERTY_REMOVED");

    assert.equal(changes.length, 2, `expected one per usage, got ${changes.length}`);
    const request = changes.find((c) => c.direction === "request")!;
    const response = changes.find((c) => c.direction === "response")!;

    assert.equal(response.severity, "BREAKING");
    assert.equal(request.severity, "CONDITIONAL");
    assert.match(response.location.displayPath, /^paths\.\/users\.get\.responses\.200/);
    assert.match(request.location.displayPath, /^paths\.\/users\.post\.requestBody/);
  });

  it("reports which operations a changed component touches", () => {
    const before = specWith({ id: { type: "string" }, email: { type: "string" } });
    const after = specWith({ id: { type: "string" } });
    const usage = analyze(before, after).componentUsage.find((u) => u.component === "User")!;

    assert.equal(usage.changed, true);
    const directions = usage.usedBy.map((u) => `${u.direction}:${u.operationKey}`).sort();
    assert.deepEqual(directions, ["request:POST /users", "response:GET /users"]);
  });

  it("does not duplicate a shared-schema change at the component location", () => {
    const before = specWith({ id: { type: "string" }, email: { type: "string" } });
    const after = specWith({ id: { type: "string" } });
    const atComponent = analyze(before, after).changes.filter((c) =>
      c.location.displayPath.startsWith("components.schemas.")
    );
    assert.deepEqual(rulesOf(atComponent), []);
  });
});

describe("servers and security", () => {
  it("treats a single server replacement as one conditional change", () => {
    const before = makeSpec({ servers: [{ url: "https://api.example.com/v1" }] });
    const after = makeSpec({ servers: [{ url: "https://api.example.com/v2" }] });
    const change = expectRule(analyze(before, after).changes, "SERVER_URL_CHANGED", "CONDITIONAL");
    assert.equal(change.oldValue, "https://api.example.com/v1");
    assert.equal(change.newValue, "https://api.example.com/v2");
  });

  it("reports added and removed servers separately when the count changes", () => {
    const before = makeSpec({ servers: [{ url: "https://a.example.com" }] });
    const after = makeSpec({
      servers: [{ url: "https://a.example.com" }, { url: "https://b.example.com" }]
    });
    expectRule(analyze(before, after).changes, "SERVER_ADDED", "NON_BREAKING");
  });

  it("adding a security requirement to an operation is breaking", () => {
    const before = withPaths({ "/a": { get: { operationId: "a", responses: OK } } });
    const after = withPaths({ "/a": { get: { operationId: "a", security: [{ bearer: [] }], responses: OK } } });
    const change = expectRule(analyze(before, after).changes, "SECURITY_REQUIREMENT_ADDED", "BREAKING");
    assert.equal(change.direction, "request");
  });

  it("removing a security requirement is not breaking", () => {
    const before = withPaths({ "/a": { get: { operationId: "a", security: [{ bearer: [] }], responses: OK } } });
    const after = withPaths({ "/a": { get: { operationId: "a", security: [], responses: OK } } });
    expectRule(analyze(before, after).changes, "SECURITY_REQUIREMENT_REMOVED", "NON_BREAKING");
  });

  it("applies a document-level security requirement to every operation", () => {
    const before = makeSpec({ paths: { "/a": { get: { operationId: "a", responses: OK } } } });
    const after = makeSpec({
      security: [{ bearer: [] }],
      paths: { "/a": { get: { operationId: "a", responses: OK } } }
    });
    const change = findRule(analyze(before, after).changes, "SECURITY_REQUIREMENT_ADDED");
    assert.ok(change);
    assert.equal(change.location.path, "/a");
  });
});

describe("path rename hypotheses", () => {
  it("proposes a path rename when one path is replaced by another with the same methods", () => {
    const before = withPaths({ "/charges": { post: { operationId: "createCharge", responses: OK } } });
    const after = withPaths({ "/payments": { post: { operationId: "createPayment", responses: OK } } });
    const analysis = analyze(before, after);

    const rename = analysis.renameCandidates.find((r) => r.kind === "path");
    assert.ok(rename);
    assert.equal(rename.from, "/charges");
    assert.equal(rename.to, "/payments");
    assert.equal(rename.confidence, "LOW");

    // The authoritative classification is still a removal plus an addition.
    expectRule(analysis.changes, "PATH_REMOVED", "BREAKING");
    expectRule(analysis.changes, "PATH_ADDED", "NON_BREAKING");
  });

  it("refuses to guess when the method sets differ", () => {
    const before = withPaths({ "/charges": { post: { responses: OK } } });
    const after = withPaths({ "/payments": { get: { responses: OK } } });
    assert.deepEqual(analyze(before, after).renameCandidates, []);
  });

  it("refuses to guess when more than one path changed", () => {
    const before = withPaths({ "/a": { get: { responses: OK } }, "/b": { get: { responses: OK } } });
    const after = withPaths({ "/c": { get: { responses: OK } }, "/d": { get: { responses: OK } } });
    assert.deepEqual(analyze(before, after).renameCandidates, []);
  });
});

describe("vanished operationIds", () => {
  it("reports an operationId that disappeared with its endpoint", () => {
    const before = withPaths({ "/charges": { post: { operationId: "createCharge", responses: OK } } });
    const after = withPaths({ "/payments": { post: { operationId: "createPayment", responses: OK } } });
    const changes = analyze(before, after).changes;
    const change = expectRule(changes, "OPERATION_ID_REMOVED", "CONDITIONAL");
    assert.equal(change.oldValue, "createCharge");
  });

  it("proposes the corresponding SDK method rename with structural evidence", () => {
    const before = withPaths({ "/charges": { post: { operationId: "createCharge", responses: OK } } });
    const after = withPaths({ "/payments": { post: { operationId: "createPayment", responses: OK } } });
    const rename = analyze(before, after).renameCandidates.find((r) => r.kind === "operationId");
    assert.ok(rename);
    assert.equal(rename.from, "createCharge");
    assert.equal(rename.to, "createPayment");
    assert.equal(rename.confidence, "LOW");
  });

  it("does not double-report when the operation survived and only its id changed", () => {
    const before = withPaths({ "/a": { get: { operationId: "one", responses: OK } } });
    const after = withPaths({ "/a": { get: { operationId: "two", responses: OK } } });
    const changes = analyze(before, after).changes;
    expectRule(changes, "OPERATION_ID_CHANGED", "CONDITIONAL");
    expectNoRule(changes, "OPERATION_ID_REMOVED");
  });

  it("refuses to guess when several operationIds changed at once", () => {
    const before = withPaths({
      "/a": { get: { operationId: "a1", responses: OK } },
      "/b": { get: { operationId: "b1", responses: OK } }
    });
    const after = withPaths({
      "/c": { get: { operationId: "c1", responses: OK } },
      "/d": { get: { operationId: "d1", responses: OK } }
    });
    assert.deepEqual(analyze(before, after).renameCandidates, []);
  });
});
