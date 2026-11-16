
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepositoryScanner } from "./scanner.js";
import { analyzeSpecChange, type SpecChangeAnalysis } from "@capibara/openapi";
import type { OpenApiDocument } from "@capibara/openapi";

// ---------------------------------------------------------------------------
// Hermetic fixtures: each suite writes a tiny repository into a temp dir,
// scans it with the real engine and asserts on the result. Nothing here hits
// the network, spawns processes or mutates the repository under test.
// ---------------------------------------------------------------------------

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "capibara-scanner-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function specDoc(paths: OpenApiDocument["paths"], schemas?: Record<string, unknown>): OpenApiDocument {
  return {
    openapi: "3.0.3",
    info: { title: "t", version: "1.0.0" },
    paths,
    ...(schemas ? { components: { schemas } } : {})
  } as OpenApiDocument;
}

function diff(oldDoc: OpenApiDocument, newDoc: OpenApiDocument): SpecChangeAnalysis {
  return analyzeSpecChange(oldDoc, newDoc);
}

function writeRepo(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

const USERS_OP = (operationId: string) => ({
  get: { operationId, parameters: [{ name: "id", in: "path" as const, required: true, schema: { type: "string" } }], responses: { "200": { description: "ok" } } }
});

async function scan(dir: string, analysis: SpecChangeAnalysis) {
  return new RepositoryScanner().scan(dir, analysis);
}

describe("AST scanner regression suite", () => {
  it("discovery: ignores node_modules, dist and .gitignore'd paths; never follows symlinks out of the root", async () => {
    const dir = writeRepo("discovery", {
      "src/index.ts": "export const a = 1;\n",
      "src/skip-me.ts": "export const b = 2;\n",
      "node_modules/pkg/index.ts": "export const c = 3;\n",
      "dist/bundle.js": "var d = 4;\n",
      ".gitignore": "src/skip-me.ts\n"
    });
    symlinkSync(join(tmpdir()), join(dir, "outside"), "dir");
    const analysis = diff(specDoc({}), specDoc({})); // no changes — discovery still must run
    const result = await scan(dir, analysis);
    const ids = result.files.map((f) => f.id).sort();
    assert.deepStrictEqual(ids, ["src/index.ts"], `unexpected file set: ${ids.join(", ")}`);
    assert.strictEqual(result.metrics.discovery.filesIncluded, 1);
    rmSync(join(dir, "outside"));
  });

  it("parsing: a syntax-error file is isolated and reported, other files still analysed", async () => {
    const dir = writeRepo("parsing", {
      "src/broken.ts": "const x = {,;;\n",
      "src/good.ts": "import axios from \"axios\";\nexport const api = axios.create({});\nexport const go = () => api.get(\"/ok\");\n"
    });
    const analysis = diff(
      specDoc({ "/ok": { get: { operationId: "getOk" } } }),
      specDoc({ "/ok": { get: { operationId: "renamedOk" } } })
    );
    const result = await scan(dir, analysis);
    assert.strictEqual(result.parseFailures.length, 1);
    assert.strictEqual(result.parseFailures[0].file, "src/broken.ts");
    assert.ok(result.usages.some((u) => u.file === "src/good.ts"), "healthy file lost its usage");
  });

  it("module graph: unresolved relative imports are counted, never guessed", async () => {
    const dir = writeRepo("modules", {
      "src/a.ts": "import { client } from \"./does-not-exist\";\nexport const call = () => client.get(\"/x\");\n"
    });
    const analysis = diff(specDoc({ "/x": { get: { operationId: "getX" } } }), specDoc({ "/x": { get: { operationId: "getX" } } }));
    const result = await scan(dir, analysis);
    assert.strictEqual(result.metrics.modules.importsUnresolved, 1);
  });

  it("symbol resolution: an inner parameter shadows an imported client — no false usage", async () => {
    const dir = writeRepo("shadowing", {
      "src/outer.ts": "import { api } from \"./api.js\";\nexport function handler(get) {\n  // `get` here is the parameter — resolving it to the axios import would be wrong.\n  return get.toString();\n}\n",
      "src/api.js": "import axios from \"axios\";\nexport const api = axios.create({});\n"
    });
    const analysis = diff(specDoc({ "/shadowed": { get: { operationId: "get" } } }), specDoc({ "/shadowed": { get: { operationId: "get" } } }));
    const result = await scan(dir, analysis);
    assert.strictEqual(result.usages.length, 0, `parameter shadowing produced usages: ${JSON.stringify(result.usages)}`);
  });

  it("path matching: /users, /users/{id} and /users/${id} are distinct; queries are stripped", async () => {
    const dir = writeRepo("paths", {
      "src/calls.ts": [
        "import axios from \"axios\";",
        "export const api = axios.create({});",
        "export const list = () => api.get(\"/users?limit=10\");",
        "export const one = (id) => api.get(`/users/${id}`);",
        "export const weird = () => api.get(\"/users/list\");"
      ].join("\n")
    });
    const analysis = diff(
      specDoc({
        "/users": { get: { operationId: "listUsers" } },
        "/users/{id}": USERS_OP("getUser"),
        "/users/list": { get: { operationId: "listSpecial" } }
      }),
      specDoc({
        "/users": { get: { operationId: "renamedListUsers" } },
        "/users/{id}": USERS_OP("renamedGetUser"),
        "/users/list": { get: { operationId: "renamedListSpecial" } }
      })
    );
    const result = await scan(dir, analysis);
    const line3 = result.usages.filter((u) => u.line === 3);
    assert.strictEqual(line3.length, 1, "the literal /users?limit=10 call matches exactly one operation (query stripped)");
    assert.strictEqual(line3[0].operation!.path, "/users");
    assert.strictEqual(line3[0].confidence, "HIGH");
    // Line 4 (`/users/${id}`) genuinely fits BOTH /users/{id} and /users/list
    // (id could be "list" at runtime) — the scanner refuses to guess and
    // reports every candidate at LOW instead of picking one.
    const line4 = result.usages.filter((u) => u.line === 4);
    assert.strictEqual(line4.length, 2, "template call with colliding siblings reports all candidates");
    assert.ok(line4.every((u) => u.confidence === "LOW" && u.operationCandidates!.length === 2));
    // Line 5 (literal /users/list) also legitimately hits both routes.
    const line5 = result.usages.filter((u) => u.line === 5);
    assert.strictEqual(line5.length, 2);
    assert.ok(line5.every((u) => u.confidence === "LOW"));
    assert.strictEqual(result.metrics.matching.ambiguousMatches, 4);
  });

  it("request body refinement: property removal applies only to call sites that send it", async () => {
    const files = (send: boolean): Record<string, string> => ({
      "src/calls.ts": [
        "import axios from \"axios\";",
        "export const api = axios.create({});",
        send
          ? "export const pay = () => api.post(\"/pay\", { amount: 10, currency: \"EUR\" });"
          : "export const pay = () => api.post(\"/pay\", { amount: 10 });"
      ].join("\n")
    });
    const oldDoc = specDoc({ "/pay": { post: { operationId: "pay", requestBody: { content: { "application/json": { schema: { type: "object", required: ["amount", "currency"], properties: { amount: { type: "number" }, currency: { type: "string" } } } } } } } } }, {});
    const newDoc = specDoc({ "/pay": { post: { operationId: "pay", requestBody: { content: { "application/json": { schema: { type: "object", required: ["amount"], properties: { amount: { type: "number" } } } } } } } } }, {});
    const analysis = diff(oldDoc, newDoc);

    const sender = await scan(writeRepo("body-sender", files(true)), analysis);
    assert.ok(sender.usages.some((u) => u.changeIds.length > 0), "sender must be flagged");
    // The currency removal is BREAKING for the sender: the property evidence applies.
    assert.ok(sender.usages.every((u) => u.severity !== undefined));

    const nonSender = await scan(writeRepo("body-non-sender", files(false)), analysis);
    const refined = nonSender.metrics.matching.refinedOut;
    assert.ok(refined >= 1, `property removal should refine out a call that never sends it (refinedOut=${refined})`);
    assert.strictEqual(nonSender.usages.filter((u) => u.changeIds.length > 0).length, 0, "non-sender must not be flagged");
  });

  it("request body spread: dynamic object spread stays visible with honest UNKNOWN/LOW confidence", async () => {
    const dir = writeRepo("body-spread", {
      "src/calls.ts": [
        "import axios from \"axios\";",
        "export const api = axios.create({});",
        "export const pay = (extra) => api.post(\"/pay\", { amount: 10, ...extra });"
      ].join("\n")
    });
    const oldDoc = specDoc({ "/pay": { post: { operationId: "pay", requestBody: { content: { "application/json": { schema: { type: "object", properties: { note: { type: "string" } } } } } } } } }, {});
    const newDoc = specDoc({ "/pay": { post: { operationId: "pay", requestBody: { content: { "application/json": { schema: { type: "object", properties: {} } } } } } } }, {});
    const analysis = diff(oldDoc, newDoc);
    const result = await scan(dir, analysis);
    assert.ok(result.usages.length > 0, "spread call site must still be reported");
    assert.ok(
      result.usages.some((u) => u.evidence.some((e) => e.kind === "dynamic-object-spread" || /spread/i.test(e.detail))),
      "the spread must be named in the evidence"
    );
    assert.ok(
      result.usages.every((u) => u.confidence === "UNKNOWN" || u.confidence === "LOW" || u.confidence === "MEDIUM"),
      "a spread body must never yield HIGH certainty about property-level changes"
    );
    assert.ok(result.metrics.flow.dynamicObjectSpreads >= 1);
  });

  it("response flow: a consumed response property is flagged; an unconsumed one is refined out", async () => {
    const files = (consume: boolean): Record<string, string> => ({
      "src/api.js": "import axios from \"axios\";\nexport const api = axios.create({});\n",
      "src/orders.ts": [
        "import { api } from \"./api.js\";",
        `export const total = async (id) => { const res = await api.get(\`/orders/\${id}\`); return ${consume ? "res.data.total" : "res.status"}; };`
      ].join("\n")
    });
    const order = (props: Record<string, unknown>) => ({ type: "object", required: Object.keys(props), properties: props });
    const oldDoc = specDoc(
      { "/orders/{id}": { get: { operationId: "getOrder", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } } } } } },
      { Order: order({ total: { type: "number" }, id: { type: "string" } }) }
    );
    const newDoc = specDoc(
      { "/orders/{id}": { get: { operationId: "getOrder", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } } } } } },
      { Order: order({ id: { type: "string" } }) }
    );
    const analysis = diff(oldDoc, newDoc);

    const consumer = await scan(writeRepo("resp-consumer", files(true)), analysis);
    const consumerUsage = consumer.usages.find((u) => u.file === "src/orders.ts");
    assert.ok(consumerUsage, "consumer must be flagged");
    assert.ok(consumerUsage.changeIds.length > 0);

    const nonConsumer = await scan(writeRepo("resp-non-consumer", files(false)), analysis);
    assert.strictEqual(
      nonConsumer.usages.filter((u) => u.file === "src/orders.ts" && u.changeIds.length > 0).length,
      0,
      "a call that never reads .total must not be flagged for the property removal"
    );
  });

  it("operation-id rename: code calling the previous operationId is matched with explicit rename evidence", async () => {
    const dir = writeRepo("rename", {
      "src/sdk.js": "export async function getUser(id) { return fetch(`/users/${id}`); }\n",
      "src/app.js": "import { getUser } from \"./sdk.js\";\nexport const run = (id) => getUser(id);\n"
    });
    const analysis = diff(
      specDoc({ "/users/{id}": USERS_OP("getUser") }),
      specDoc({ "/users/{id}": USERS_OP("fetchUserById") })
    );
    const result = await scan(dir, analysis);
    const appUsage = result.usages.find((u) => u.file === "src/app.js");
    assert.ok(appUsage, "the caller of the renamed function must be flagged");
    assert.ok(
      appUsage.evidence.some((e) => /previous operationId/.test(e.detail)),
      "the rename must be stated explicitly in the evidence"
    );
  });

  it("confidence levels: HIGH, MEDIUM and LOW are all reachable with deterministic meaning", async () => {
    const dir = writeRepo("confidence", {
      "src/api.js": "import axios from \"axios\";\nexport const api = axios.create({});\n",
      "src/direct.js": "import { api } from \"./api.js\";\nexport const pay = () => api.post(\"/pay\", { amount: 1 });\n",
      "src/hooks.js": "export const runHook = (id) => fetch(`/hooks/${id}`, { method: \"POST\" });\n",
      "src/viaEnv.js": "const base = process.env.API;\nexport const pay2 = (id) => fetch(`${base}/pay/${id}`, { method: \"POST\" });\n"
    });
    const oldDoc = specDoc({
      "/pay": { post: { operationId: "pay", requestBody: { content: { "application/json": { schema: { type: "object", properties: { amount: { type: "number" } } } } } } } },
      "/pay/{id}": { post: { operationId: "payById", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } },
      "/hooks/{id}": { post: { operationId: "runHook", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } }
    });
    const newDoc = specDoc({
      "/pay": { post: { operationId: "payRenamed", requestBody: { content: { "application/json": { schema: { type: "object", properties: { amount: { type: "number" } } } } } } } },
      "/pay/{id}": { post: { operationId: "payByIdRenamed", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } },
      "/hooks/{id}": { post: { operationId: "runHookRenamed", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } }
    });
    const result = await scan(dir, diff(oldDoc, newDoc));
    const byFile = new Map(result.usages.map((u) => [u.file, u.confidence]));
    assert.strictEqual(byFile.get("src/direct.js"), "HIGH", "literal method+path+body must be HIGH");
    assert.strictEqual(byFile.get("src/hooks.js"), "MEDIUM", "template hole over the {id} parameter is structural but not literal — MEDIUM");
    // `${base}/pay/${id}` structurally fits BOTH /pay and /pay/{id} — the
    // scanner refuses to guess between them and reports LOW for each candidate.
    const envUsages = result.usages.filter((u) => u.file === "src/viaEnv.js");
    assert.strictEqual(envUsages.length, 2, "an ambiguous site reports every candidate, not one guess");
    assert.ok(envUsages.every((u) => u.confidence === "LOW" && u.operationCandidates !== undefined && u.operationCandidates.length === 2));
  });

  it("every usage carries evidence, an explanation and at least one change id; ids are stable across reruns", async () => {
    const dir = writeRepo("invariants", {
      "src/api.js": "import axios from \"axios\";\nexport const api = axios.create({});\n",
      "src/calls.ts": "import { api } from \"./api.js\";\nexport const pay = () => api.post(\"/pay\", { amount: 1 });\n"
    });
    const oldDoc = specDoc({ "/pay": { post: { operationId: "pay" } } }, {});
    const newDoc = specDoc({ "/pay": { post: { operationId: "payRenamed" } } }, {});
    const analysis = diff(oldDoc, newDoc);
    const first = await scan(dir, analysis);
    const second = await scan(dir, analysis);
    assert.ok(first.usages.length > 0, "fixture must produce usages");
    for (const usage of first.usages) {
      assert.ok(usage.evidence.length > 0, `usage ${usage.id} has no evidence`);
      assert.ok(usage.explanation.length > 0, `usage ${usage.id} has no explanation`);
      assert.ok(usage.changeIds.length > 0, `usage ${usage.id} references no change`);
      assert.ok(["HIGH", "MEDIUM", "LOW", "UNKNOWN"].includes(usage.confidence));
      assert.match(usage.id, /^usage_[0-9a-f]{16}$/);
    }
    const strip = (s: typeof first) => JSON.stringify({ ...s, timing: undefined });
    assert.strictEqual(strip(second), strip(first), "rerun not byte-identical");
  });
});
