import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RULE_CATALOG, RULE_IDS, getRule, severityFor } from "./diff/rules.js";
import { CHANGE_KINDS, CONFIDENCES, SEVERITIES } from "./diff/changes.js";
import { DIRECTIONS } from "./model/canonical.js";
import { renderRuleCatalogMarkdown } from "./docs.js";
import { analyze, makeSpec, jsonResponse, jsonBody } from "./testing/fixtures.js";
import { formatChangeReport } from "./report.js";
import { DefaultDiffEngine } from "./diff-engine.js";
import { DefaultSpecValidator } from "./validator.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("rule catalog", () => {
  it("declares a complete, well-formed definition for every rule", () => {
    assert.ok(RULE_IDS.length >= 50, `expected a substantial catalog, got ${RULE_IDS.length}`);
    for (const id of RULE_IDS) {
      const definition = getRule(id);
      assert.ok(CHANGE_KINDS.includes(definition.kind), `${id} has an unknown kind`);
      assert.ok(definition.title.length > 3, `${id} needs a title`);
      assert.ok(definition.rationale.length > 20, `${id} needs a rationale explaining the client impact`);
      assert.ok(CONFIDENCES.includes(definition.confidence), `${id} has an invalid confidence`);
      assert.ok(SEVERITIES.includes(definition.severity.default), `${id} has an invalid default severity`);
      for (const direction of DIRECTIONS) {
        assert.ok(SEVERITIES.includes(severityFor(id, direction)), `${id} has an invalid ${direction} severity`);
      }
    }
  });

  it("uses SCREAMING_SNAKE_CASE ids", () => {
    for (const id of RULE_IDS) assert.match(id, /^[A-Z][A-Z0-9_]*$/);
  });

  it("documents a limitation wherever confidence is not HIGH", () => {
    for (const id of RULE_IDS) {
      const definition = getRule(id);
      if (definition.confidence === "HIGH") continue;
      assert.ok(
        definition.limitations || definition.rationale.length > 60,
        `${id} is ${definition.confidence} confidence and must explain why`
      );
    }
  });

  it("never marks an UNKNOWN-severity rule as anything but UNKNOWN confidence", () => {
    for (const id of RULE_IDS) {
      const definition = getRule(id);
      if (definition.severity.default === "UNKNOWN") {
        assert.equal(definition.confidence, "UNKNOWN", `${id} claims confidence in an unknown verdict`);
      }
    }
  });

  it("keeps request and response severities distinct where direction matters", () => {
    // A representative set where getting the direction wrong would be a real defect.
    const directional: Array<[keyof typeof RULE_CATALOG, string, string]> = [
      ["PROPERTY_MADE_OPTIONAL", "NON_BREAKING", "BREAKING"],
      ["PROPERTY_MADE_REQUIRED", "BREAKING", "NON_BREAKING"],
      ["NULLABLE_ADDED", "NON_BREAKING", "BREAKING"],
      ["NULLABLE_REMOVED", "BREAKING", "NON_BREAKING"],
      ["TYPE_NARROWED", "BREAKING", "NON_BREAKING"],
      ["TYPE_WIDENED", "NON_BREAKING", "BREAKING"],
      ["ADDITIONAL_PROPERTIES_RESTRICTED", "BREAKING", "NON_BREAKING"],
      ["NUMERIC_RANGE_NARROWED", "BREAKING", "NON_BREAKING"]
    ];
    for (const [id, request, response] of directional) {
      assert.equal(severityFor(id, "request"), request, `${id} request severity`);
      assert.equal(severityFor(id, "response"), response, `${id} response severity`);
    }
  });

  it("matches the generated documentation in docs/openapi-rules.md", async () => {
    const published = await readFile(join(repoRoot, "docs", "openapi-rules.md"), "utf8");
    assert.equal(
      published,
      renderRuleCatalogMarkdown(),
      "docs/openapi-rules.md is stale. Run `npm run docs:rules -w @capibara/openapi`."
    );
  });

  it("documents every rule the engine can emit", async () => {
    const published = await readFile(join(repoRoot, "docs", "openapi-rules.md"), "utf8");
    for (const id of RULE_IDS) {
      assert.ok(published.includes(`\`${id}\``), `${id} is missing from the published catalog`);
    }
  });
});

describe("report rendering", () => {
  const before = makeSpec({
    paths: {
      "/users/{id}": {
        get: {
          operationId: "getUser",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: jsonResponse({ type: "object", properties: { email: { type: "string" } } })
        }
      }
    }
  });
  const after = makeSpec({
    paths: {
      "/users/{id}": {
        get: {
          operationId: "getUser",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: jsonResponse({ type: "object", properties: {} })
        }
      }
    }
  });

  it("explains what, where, why and how confident", () => {
    const report = formatChangeReport(analyze(before, after));
    assert.match(report, /BREAKING/);
    assert.match(report, /field email removed/);
    assert.match(report, /paths\.\/users\/\{id\}\.get/);
    assert.match(report, /rule\s+PROPERTY_REMOVED/);
    assert.match(report, /confidence HIGH/);
    assert.match(report, /direction response/);
  });

  it("says so plainly when nothing changed", () => {
    assert.match(formatChangeReport(analyze(before, before)), /No semantic changes detected/);
  });

  it("groups by severity and reports the summary counts", () => {
    const report = formatChangeReport(analyze(before, after));
    assert.match(report, /1 breaking, 0 conditional/);
  });
});

describe("legacy projection", () => {
  it("keeps the DefaultDiffEngine surface working", async () => {
    const engine = new DefaultDiffEngine();
    const before = makeSpec({
      servers: [{ url: "https://api.example.com/v1" }],
      paths: {
        "/charges": {
          post: {
            operationId: "createCharge",
            requestBody: jsonBody({
              type: "object",
              required: ["amount"],
              properties: { amount: { type: "integer" }, source: { type: "string" } }
            }),
            responses: jsonResponse({ type: "object", properties: { id: { type: "string" }, status: { type: "string" } } })
          }
        }
      }
    });
    const after = makeSpec({
      servers: [{ url: "https://api.example.com/v2" }],
      paths: {
        "/charges": {
          post: {
            operationId: "createPayment",
            requestBody: jsonBody({
              type: "object",
              required: ["amount", "payment_method"],
              properties: { amount: { type: "integer" }, payment_method: { type: "string" } }
            }),
            responses: jsonResponse({ type: "object", properties: { id: { type: "string" }, state: { type: "string" } } })
          }
        }
      }
    });

    const changes = await engine.diff(before, after);
    const instructions = engine.getMigrationInstructions();

    assert.equal(changes.length, instructions.length);
    assert.ok(changes.some((c) => c.type === "operation-id-removed"));
    assert.ok(changes.some((c) => c.type === "response-field-renamed" || c.type === "response-field-removed"));
    assert.ok(instructions.every((i) => i.confidence >= 0 && i.confidence <= 1));
    assert.ok(instructions.some((i) => i.mappings.some((m) => m.kind === "server")));
    assert.ok(instructions.some((i) => i.mappings.some((m) => m.kind === "operationId")));

    // Every legacy change must carry a deterministic id.
    assert.equal(new Set(changes.map((c) => c.id)).size, changes.length);
    assert.ok(engine.getAnalysis());
  });

  it("drops non-breaking changes so the scanner is not sent on pointless hunts", async () => {
    const engine = new DefaultDiffEngine();
    const before = makeSpec({ paths: { "/a": { get: { operationId: "a", responses: jsonResponse({ type: "object" }) } } } });
    const after = makeSpec({
      paths: {
        "/a": { get: { operationId: "a", responses: jsonResponse({ type: "object" }) } },
        "/b": { get: { operationId: "b", responses: jsonResponse({ type: "object" }) } }
      }
    });
    assert.deepEqual(await engine.diff(before, after), []);
  });

  it("projects a rename hypothesis into an actionable mapping", async () => {
    const engine = new DefaultDiffEngine();
    const build = (name: string) =>
      makeSpec({
        paths: {
          "/a": {
            post: {
              operationId: "a",
              requestBody: jsonBody({ type: "object", properties: { [name]: { type: "string" } } }),
              responses: { "200": { description: "OK" } }
            }
          }
        }
      });
    await engine.diff(build("source"), build("payment_method"));
    const rename = engine.getMigrationInstructions().find((i) => i.changeType === "request-field-renamed");
    assert.ok(rename);
    assert.deepEqual(rename.mappings, [{ old: "source", new: "payment_method", kind: "field" }]);
  });
});

describe("validator", () => {
  const validator = new DefaultSpecValidator();

  it("flags an unresolvable reference as an error", async () => {
    const issues = await validator.validate(
      makeSpec({
        paths: { "/a": { get: { operationId: "a", responses: jsonResponse({ type: "object" }) } } },
        components: { schemas: { A: { $ref: "#/components/schemas/Nope" } } }
      })
    );
    assert.ok(issues.some((i) => i.type === "error" && /does not resolve/.test(i.message)));
  });

  it("warns about an external reference rather than following it", async () => {
    const issues = await validator.validate(
      makeSpec({ paths: { "/a": { get: { responses: jsonResponse({ $ref: "https://x.example/s.json" }) } } } })
    );
    assert.ok(issues.some((i) => i.type === "warning" && /External reference/.test(i.message)));
  });

  it("flags a path template with no matching parameter", async () => {
    const issues = await validator.validate(
      makeSpec({ paths: { "/a/{id}": { get: { operationId: "a", responses: { "200": { description: "OK" } } } } } })
    );
    assert.ok(issues.some((i) => /has no matching path parameter/.test(i.message)));
  });

  it("flags a path parameter that is not in the template", async () => {
    const issues = await validator.validate(
      makeSpec({
        paths: {
          "/a": {
            get: {
              operationId: "a",
              parameters: [{ name: "ghost", in: "path", required: true, schema: { type: "string" } }],
              responses: { "200": { description: "OK" } }
            }
          }
        }
      })
    );
    assert.ok(issues.some((i) => /does not appear in the path template/.test(i.message)));
  });

  it("flags duplicate operationIds", async () => {
    const issues = await validator.validate(
      makeSpec({
        paths: {
          "/a": { get: { operationId: "dup", responses: { "200": { description: "OK" } } } },
          "/b": { get: { operationId: "dup", responses: { "200": { description: "OK" } } } }
        }
      })
    );
    assert.ok(issues.some((i) => i.type === "error" && /Duplicate operationId/.test(i.message)));
  });

  it("flags an operation with no responses", async () => {
    const issues = await validator.validate(makeSpec({ paths: { "/a": { get: { operationId: "a" } } } }));
    assert.ok(issues.some((i) => /declares no responses/.test(i.message)));
  });

  it("accepts a well-formed document", async () => {
    const issues = await validator.validate(
      makeSpec({
        paths: {
          "/a/{id}": {
            get: {
              operationId: "getA",
              parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
              responses: jsonResponse({ type: "object" })
            }
          }
        }
      })
    );
    assert.deepEqual(issues.filter((i) => i.type === "error"), []);
  });
});
