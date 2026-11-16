import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIError, SecurityError } from "@tern/shared";
import { DefaultSpecLoader, loadFromString, resolveSpecPath } from "./spec-loader.js";
import { buildApiModel } from "./model/build.js";
import { analyzeSpecChange } from "./diff/engine.js";
import { DEFAULT_LIMITS } from "./limits.js";
import { makeSpec, jsonResponse } from "./testing/fixtures.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

describe("parsing", () => {
  it("accepts JSON and YAML", () => {
    assert.equal(loadFromString('{"openapi":"3.0.3","info":{"title":"T","version":"1"},"paths":{}}').info.title, "T");
    assert.equal(
      loadFromString('openapi: "3.0.3"\ninfo:\n  title: Y\n  version: "1"\npaths: {}').info.title,
      "Y"
    );
  });

  it("rejects malformed documents explicitly", () => {
    assert.throws(() => loadFromString("{not json"), /could not be parsed|not valid YAML or JSON/);
    assert.throws(() => loadFromString("[]"), /must be an object/);
    assert.throws(() => loadFromString('"hello"'), /must be an object/);
  });

  it("rejects documents with no version or an unsupported one", () => {
    assert.throws(() => loadFromString('{"info":{"title":"T","version":"1"},"paths":{}}'), /missing the .openapi./);
    assert.throws(
      () => loadFromString('{"openapi":"2.0","info":{"title":"T","version":"1"},"paths":{}}'),
      /Unsupported OpenAPI version/
    );
    assert.throws(
      () => loadFromString('{"openapi":"4.0.0","info":{"title":"T","version":"1"},"paths":{}}'),
      /Unsupported OpenAPI version/
    );
  });

  it("accepts 3.0.x and 3.1.x", () => {
    for (const version of ["3.0.0", "3.0.3", "3.1.0", "3.1.1"]) {
      assert.equal(
        loadFromString(`{"openapi":"${version}","info":{"title":"T","version":"1"},"paths":{}}`).openapi,
        version
      );
    }
  });

  it("rejects a document with neither paths nor webhooks", () => {
    assert.throws(() => loadFromString('{"openapi":"3.0.3","info":{"title":"T","version":"1"}}'), /no paths/);
  });

  it("accepts a 3.1 document that declares only webhooks", () => {
    const document = loadFromString(
      '{"openapi":"3.1.0","info":{"title":"T","version":"1"},"webhooks":{"ping":{}}}'
    );
    assert.deepEqual(document.paths, {});
  });

  it("rejects a document larger than the size limit", () => {
    const big = `{"openapi":"3.0.3","info":{"title":"${"x".repeat(2000)}","version":"1"},"paths":{}}`;
    assert.throws(
      () => loadFromString(big, { ...DEFAULT_LIMITS, maxDocumentBytes: 500 }),
      (error: unknown) => {
        assert.equal((error as OpenAPIError).code, "OPENAPI_DOCUMENT_TOO_LARGE");
        return true;
      }
    );
  });
});

describe("prototype pollution", () => {
  it("strips __proto__ from a JSON document", () => {
    const document = loadFromString(
      '{"openapi":"3.0.3","info":{"title":"T","version":"1"},"paths":{},"__proto__":{"polluted":true}}'
    );
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(document, "__proto__"), false);
  });

  it("strips a nested __proto__ inside a schema", () => {
    const document = loadFromString(
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "T", version: "1" },
        paths: {},
        components: { schemas: { S: { type: "object", properties: { __proto__: { type: "string" } } } } }
      })
    );
    const model = buildApiModel(document as any);
    const node = model.registry.get("#/components/schemas/S")!;
    assert.equal(node.properties.has("__proto__"), false);
    assert.equal(({} as Record<string, unknown>).type, undefined);
  });

  it("strips constructor and prototype keys", () => {
    const document = loadFromString(
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "T", version: "1" },
        paths: {},
        components: { schemas: { S: { constructor: { evil: true }, prototype: { evil: true }, type: "object" } } }
      })
    );
    const schema = (document as any).components.schemas.S;
    assert.equal(Object.prototype.hasOwnProperty.call(schema, "constructor"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(schema, "prototype"), false);
    assert.equal(schema.type, "object");
  });

  it("does not let a document key reach Object.prototype during pointer resolution", () => {
    // `#/constructor/prototype` must not resolve to anything.
    assert.throws(
      () =>
        buildApiModel(
          makeSpec({
            paths: { "/a": { get: { responses: jsonResponse({ $ref: "#/constructor/prototype" }) } } }
          })
        ),
      /does not resolve/
    );
  });
});

describe("YAML safety", () => {
  it("does not evaluate custom tags", () => {
    // CORE_SCHEMA has no custom type constructors, so a tag is a parse error rather
    // than an instantiation.
    assert.throws(
      () => loadFromString('openapi: "3.0.3"\ninfo: !!js/function "function(){return 1}"\npaths: {}'),
      /could not be parsed|not valid YAML/
    );
  });

  it("rejects an anchor-expansion bomb through the node budget", () => {
    const lines = ['openapi: "3.0.3"', "info:", "  title: T", '  version: "1"', "paths: {}", "x-bomb:"];
    lines.push("  a: &a [1,1,1,1,1,1,1,1,1,1]");
    for (const level of ["b", "c", "d", "e", "f", "g"]) {
      const previous = String.fromCharCode(level.charCodeAt(0) - 1);
      lines.push(`  ${level}: &${level} [*${previous},*${previous},*${previous},*${previous},*${previous},*${previous},*${previous},*${previous},*${previous},*${previous}]`);
    }
    assert.throws(
      () => loadFromString(lines.join("\n"), { ...DEFAULT_LIMITS, maxModelNodes: 5_000 }),
      (error: unknown) => {
        assert.equal((error as OpenAPIError).code, "OPENAPI_DOCUMENT_TOO_COMPLEX");
        return true;
      }
    );
  });
});

describe("local path handling", () => {
  it("requires a root for relative paths", () => {
    assert.throws(() => resolveSpecPath("spec.yaml"), (error: unknown) => {
      assert.equal((error as SecurityError).code, "OPENAPI_PATH_ROOT_REQUIRED");
      return true;
    });
  });

  it("confines a relative path to the configured root", () => {
    assert.equal(resolveSpecPath("api/openapi.yaml", "/srv/specs"), "/srv/specs/api/openapi.yaml");
  });

  it("rejects traversal out of the root", () => {
    for (const attempt of ["../../etc/passwd", "a/../../../etc/passwd", "/etc/passwd"]) {
      assert.throws(() => resolveSpecPath(attempt, "/srv/specs"), (error: unknown) => {
        assert.equal((error as SecurityError).code, "OPENAPI_PATH_ESCAPE");
        return true;
      });
    }
  });

  it("rejects null bytes", () => {
    assert.throws(() => resolveSpecPath("a\u0000b", "/srv/specs"), /null byte/);
  });

  it("loads a spec from inside the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "tern-spec-"));
    try {
      await mkdir(join(root, "api"), { recursive: true });
      await writeFile(
        join(root, "api", "openapi.json"),
        JSON.stringify({ openapi: "3.0.3", info: { title: "Loaded", version: "1" }, paths: {} })
      );
      const loader = new DefaultSpecLoader({ rootDir: root });
      assert.equal((await loader.load("api/openapi.json")).info.title, "Loaded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to read outside the root even when the file exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "tern-spec-"));
    try {
      await mkdir(join(root, "inside"), { recursive: true });
      await writeFile(join(root, "secret.json"), "{}");
      const loader = new DefaultSpecLoader({ rootDir: join(root, "inside") });
      await assert.rejects(() => loader.load("../secret.json"), SecurityError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("remote loading and SSRF", () => {
  it("is disabled by default", async () => {
    const loader = new DefaultSpecLoader();
    await assert.rejects(
      () => loader.load("https://example.com/openapi.json"),
      (error: unknown) => {
        assert.ok(error instanceof SecurityError);
        assert.equal(error.code, "OPENAPI_REMOTE_DISABLED");
        return true;
      }
    );
  });

  it("refuses the cloud metadata endpoint even when it is explicitly allowlisted", async () => {
    const loader = new DefaultSpecLoader({ remote: { allowedHosts: ["169.254.169.254"] } });
    await assert.rejects(
      () => loader.load("http://169.254.169.254/latest/meta-data/"),
      (error: unknown) => {
        assert.equal((error as SecurityError).code, "OPENAPI_REMOTE_INSECURE");
        return true;
      }
    );
    await assert.rejects(
      () => loader.load("https://169.254.169.254/latest/meta-data/"),
      (error: unknown) => {
        assert.equal((error as SecurityError).code, "OPENAPI_REMOTE_PRIVATE_HOST");
        return true;
      }
    );
  });

  it("refuses hosts that are not allowlisted", async () => {
    const loader = new DefaultSpecLoader({ remote: { allowedHosts: ["specs.example.com"] } });
    await assert.rejects(
      () => loader.load("https://evil.example.com/openapi.json"),
      (error: unknown) => {
        assert.equal((error as SecurityError).code, "OPENAPI_REMOTE_HOST_DENIED");
        return true;
      }
    );
  });

  it("refuses private and loopback addresses", async () => {
    for (const host of ["localhost", "127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.5.4", "[::1]"]) {
      const loader = new DefaultSpecLoader({ remote: { allowedHosts: [host.replace(/^\[|\]$/g, "")] } });
      await assert.rejects(
        () => loader.load(`https://${host}/openapi.json`),
        (error: unknown) => {
          assert.equal((error as SecurityError).code, "OPENAPI_REMOTE_PRIVATE_HOST", `host ${host}`);
          return true;
        }
      );
    }
  });

  it("never follows an external $ref, even to a public URL", () => {
    // The model marks it external; no fetch is attempted at any point.
    const model = buildApiModel(
      makeSpec({
        paths: { "/a": { get: { responses: jsonResponse({ $ref: "https://example.com/schema.json" }) } } }
      })
    );
    const id = model.operations[0].responses[0].content[0].schema!;
    assert.equal(model.registry.get(id)!.origin.kind, "external");
  });
});

describe("pathological inputs terminate", () => {
  it("handles a wide document (1000 paths) within the default limits", () => {
    const paths: Record<string, any> = {};
    for (let i = 0; i < 1000; i += 1) {
      paths[`/resource${i}`] = {
        get: {
          operationId: `get${i}`,
          responses: jsonResponse({ type: "object", properties: { id: { type: "string" } } })
        }
      };
    }
    const before = makeSpec({ paths });
    const mutatedPaths = JSON.parse(JSON.stringify(paths));
    delete mutatedPaths["/resource500"];
    const after = makeSpec({ paths: mutatedPaths });

    const started = Date.now();
    const analysis = analyzeSpecChange(before, after);
    const elapsed = Date.now() - started;

    assert.equal(analysis.changes.filter((c) => c.rule === "PATH_REMOVED").length, 1);
    assert.ok(elapsed < 20_000, `1000-path diff took ${elapsed}ms`);
  });

  it("handles many operations sharing one schema without quadratic blow-up", () => {
    const build = (properties: Record<string, any>) => {
      const paths: Record<string, any> = {};
      for (let i = 0; i < 200; i += 1) {
        paths[`/r${i}`] = {
          get: { operationId: `g${i}`, responses: jsonResponse({ $ref: "#/components/schemas/Shared" }) }
        };
      }
      return makeSpec({ paths, components: { schemas: { Shared: { type: "object", properties } } } });
    };

    const started = Date.now();
    const analysis = analyzeSpecChange(
      build({ a: { type: "string" }, b: { type: "string" } }),
      build({ a: { type: "string" } })
    );
    const elapsed = Date.now() - started;

    // One finding per usage, computed once and reused across the 200 call sites.
    assert.equal(analysis.changes.filter((c) => c.rule === "PROPERTY_REMOVED").length, 200);
    assert.ok(elapsed < 20_000, `shared-schema diff took ${elapsed}ms`);
  });

  it("terminates on a deeply recursive schema graph", () => {
    const build = (extra: Record<string, any>) =>
      makeSpec({
        paths: { "/a": { get: { operationId: "a", responses: jsonResponse({ $ref: "#/components/schemas/A" }) } } },
        components: {
          schemas: {
            A: { type: "object", properties: { b: { $ref: "#/components/schemas/B" }, ...extra } },
            B: { type: "object", properties: { c: { $ref: "#/components/schemas/C" } } },
            C: { type: "object", properties: { a: { $ref: "#/components/schemas/A" } } }
          }
        }
      });
    const analysis = analyzeSpecChange(build({ x: { type: "string" } }), build({}));
    assert.equal(analysis.changes.filter((c) => c.rule === "PROPERTY_REMOVED").length, 1);
  });

  it("fails loudly rather than hanging when the comparison budget is exhausted", () => {
    const properties: Record<string, any> = {};
    for (let i = 0; i < 200; i += 1) properties[`p${i}`] = { type: "object", properties: { q: { type: "string" } } };
    const before = makeSpec({ components: { schemas: { S: { type: "object", properties } } } });
    const after = makeSpec({ components: { schemas: { S: { type: "object", properties: {} } } } });

    assert.throws(
      () => analyzeSpecChange(before, after, { limits: { ...DEFAULT_LIMITS, maxChanges: 10 } }),
      (error: unknown) => {
        assert.equal((error as OpenAPIError).code, "OPENAPI_TOO_MANY_CHANGES");
        return true;
      }
    );
  });
});
