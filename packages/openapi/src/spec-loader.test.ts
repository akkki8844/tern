import { describe, it } from "node:test";
import assert from "node:assert";
import { loadFromString, sanitizeLocalPath } from "./spec-loader.js";

describe("SpecLoader", () => {
  it("parses YAML", () => {
    const yaml = [
      'openapi: "3.0.0"',
      "info:",
      '  title: T',
      '  version: "1.0.0"',
      "paths: {}"
    ].join("\n");
    const spec = loadFromString(yaml);
    assert.strictEqual(spec.info.title, "T");
  });

  it("parses JSON", () => {
    const json = JSON.stringify({ openapi: "3.0.3", info: { title: "J", version: "1.0.0" }, paths: {} });
    const spec = loadFromString(json);
    assert.strictEqual(spec.info.title, "J");
  });

  it("rejects non-object documents", () => {
    assert.throws(() => loadFromString("[]"), /must be an object/);
    assert.throws(() => loadFromString('"hello"'), /must be an object/);
  });

  it("rejects non-OpenAPI documents", () => {
    assert.throws(() => loadFromString('{"foo": "bar"}'), /OpenAPI version/);
  });

  it("rejects documents without paths", () => {
    assert.throws(() => loadFromString('{"openapi": "3.0.0", "info": {"title": "T", "version": "1"}}'), /paths/);
  });
});

describe("sanitizeLocalPath", () => {
  it("rejects null bytes", () => {
    assert.throws(() => sanitizeLocalPath("foo\u0000bar"), /null byte/);
  });

  it("rejects path traversal", () => {
    assert.throws(() => sanitizeLocalPath("foo/../../../etc/passwd"), /traversal/);
  });

  it("passes through clean paths", () => {
    assert.strictEqual(sanitizeLocalPath("demo/specs/v1.yaml"), "demo/specs/v1.yaml");
  });

  it("handles Windows paths", () => {
    const result = sanitizeLocalPath("C:\\Users\\smart\\Tern\\demo\\v1.yaml");
    assert.ok(result.includes("Users"));
  });
});
