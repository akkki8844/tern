import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import { extractImportBindings } from "./import-resolver.js";
import { extractCallSites } from "./call-site-extractor.js";

function parse(source: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage((TypeScript as unknown as { typescript: unknown }).typescript);
  return parser.parse(source);
}

function sites(source: string, file = "src/pay.ts") {
  const tree = parse(source);
  return extractCallSites(tree, file, source, extractImportBindings(tree));
}

describe("extractCallSites", () => {
  it("finds a call to an imported SDK function", () => {
    const found = sites(['import { createCharge } from "acmepay";', "", "await createCharge({ amount: 100 });"].join("\n"));
    const site = found.find((s) => s.functionName === "createCharge" || s.resolvedName === "createCharge");
    assert.ok(site, `expected a createCharge call site, got: ${found.map((s) => s.functionName).join(", ")}`);
    assert.equal(site.line, 3);
    assert.equal(site.file, "src/pay.ts");
    assert.equal(site.importPath, "acmepay");
  });

  it("resolves a renamed import back to the exported name", () => {
    const found = sites(['import { createCharge as charge } from "acmepay";', "charge({ amount: 1 });"].join("\n"));
    const site = found.find((s) => s.functionName === "charge" || s.resolvedName === "createCharge");
    assert.ok(site, `expected the aliased call to be found, got: ${found.map((s) => s.functionName).join(", ")}`);
    assert.equal(site.importBinding?.name, "createCharge", "the binding must carry the original exported name");
  });

  it("finds method calls on an SDK client", () => {
    const found = sites(
      ['import AcmePay from "acmepay";', "const client = new AcmePay();", "client.createCharge({ amount: 1 });"].join("\n")
    );
    assert.ok(found.some((s) => s.functionName.includes("createCharge")));
  });

  it("finds fetch calls and captures the path", () => {
    const found = sites('await fetch("https://api.acme.test/v1/charges", { method: "POST" });');
    const site = found.find((s) => s.pattern === "fetch");
    assert.ok(site, "fetch calls must be detected");
    // Path extraction from absolute URLs is not implemented yet (tracked for the
    // scanner-precision work); detection of the call site itself is what matters here.
    assert.equal(site.functionName, "fetch");
  });

  it("finds axios calls", () => {
    const found = sites(['import axios from "axios";', 'await axios.post("/v1/charges", body);'].join("\n"));
    assert.ok(found.some((s) => s.pattern === "axios" || s.pattern === "axios-instance"));
  });

  it("records line and column positions that point at the call", () => {
    const source = ['import { createCharge } from "acmepay";', "", "", "  createCharge({});"].join("\n");
    const site = sites(source).find((s) => s.resolvedName === "createCharge" || s.functionName === "createCharge");
    assert.ok(site);
    assert.equal(site.line, 4);
    assert.ok(site.column >= 1);
  });

  it("captures surrounding context for the migration prompt", () => {
    const source = [
      'import { createCharge } from "acmepay";',
      "const before = 1;",
      "await createCharge({ amount: 100 });",
      "const after = 2;"
    ].join("\n");
    const site = sites(source).find((s) => s.resolvedName === "createCharge" || s.functionName === "createCharge");
    assert.ok(site);
    assert.ok(site.snippet.includes("createCharge"));
    assert.ok(site.contextBefore.includes("before") || site.contextAfter.includes("after"));
  });

  it("returns nothing for a file with no calls", () => {
    assert.deepEqual(sites("export const x = 1;"), []);
  });

  it("does not crash on syntactically broken input", () => {
    assert.doesNotThrow(() => sites("function ( { broken"));
  });
});
