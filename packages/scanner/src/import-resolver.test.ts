import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import { extractImportBindings } from "./import-resolver.js";

/**
 * Real tree-sitter tests. The previous versions of this file were empty stubs marked
 * "skipped: requires tree-sitter" and asserted nothing; the grammar is wired up now,
 * so the parser path is genuinely exercised.
 */
function parse(source: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage((TypeScript as unknown as { typescript: unknown }).typescript);
  return parser.parse(source);
}

describe("extractImportBindings", () => {
  it("extracts named imports", () => {
    const bindings = extractImportBindings(parse(`import { createCharge, listCharges } from "acmepay";`));
    assert.equal(bindings.get("createCharge")?.source, "acmepay");
    assert.equal(bindings.get("createCharge")?.isDefault, false);
    assert.equal(bindings.get("listCharges")?.source, "acmepay");
  });

  it("records renamed imports and keeps both names", () => {
    const bindings = extractImportBindings(parse(`import { createCharge as charge } from "acmepay";`));
    const binding = bindings.get("charge");
    assert.ok(binding, "the local alias must be resolvable");
    assert.equal(binding.source, "acmepay");
    assert.equal(binding.isRenamed, true);
    assert.equal(binding.name, "createCharge");
  });

  it("extracts default imports", () => {
    const bindings = extractImportBindings(parse(`import AcmePay from "acmepay";`));
    assert.equal(bindings.get("AcmePay")?.isDefault, true);
  });

  it("extracts namespace imports", () => {
    const bindings = extractImportBindings(parse(`import * as acme from "acmepay";`));
    assert.equal(bindings.get("acme")?.isNamespace, true);
  });

  it("handles several import statements in one file", () => {
    const bindings = extractImportBindings(
      parse(['import { a } from "one";', 'import b from "two";', 'import * as c from "three";'].join("\n"))
    );
    assert.deepEqual([...bindings.keys()].sort(), ["a", "b", "c"]);
  });

  it("returns an empty map for a file with no imports", () => {
    assert.equal(extractImportBindings(parse("export const x = 1;")).size, 0);
  });

  it("does not crash on syntactically broken input", () => {
    assert.doesNotThrow(() => extractImportBindings(parse('import { from "acmepay"')));
  });
});
