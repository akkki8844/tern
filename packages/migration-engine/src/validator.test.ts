
import { describe, it } from "node:test";
import assert from "node:assert";
import { DefaultPatchValidator } from "./validator";
import { MigrationPatch } from "@tern/shared";

describe("DefaultPatchValidator", () => {
  it("rejects forbidden eval and secrets", () => {
    const validator = new DefaultPatchValidator();
    const patch: MigrationPatch = { id: "p1", filePath: "x.ts", original: "a", modified: "eval(b)", description: "", breakingChangeId: "c1", validationStatus: "pending", validationErrors: [], diff: "", lineCountChanged: 0 };
    const result = validator.validate(patch);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("Forbidden")));
  });

  it("rejects lockfiles", () => {
    const validator = new DefaultPatchValidator();
    const patch: MigrationPatch = { id: "p1", filePath: "yarn.lock", original: "a", modified: "b", description: "", breakingChangeId: "c1", validationStatus: "pending", validationErrors: [], diff: "", lineCountChanged: 0 };
    const result = validator.validate(patch);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("Disallowed")));
  });

  it("warns on unrelated edits", () => {
    const validator = new DefaultPatchValidator();
    const patch: MigrationPatch = { id: "p1", filePath: "x.ts", original: "function x() {}", modified: "function x() { unrelated(); }", description: "Rename source to payment_method", breakingChangeId: "c1", validationStatus: "pending", validationErrors: [], diff: "", lineCountChanged: 0 };
    const result = validator.validate(patch);
    assert.ok(result.warnings.length > 0);
  });
});
