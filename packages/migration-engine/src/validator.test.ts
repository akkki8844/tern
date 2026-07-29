
import { describe, it } from "node:test";
import assert from "node:assert";
import { DefaultPatchValidator } from "./validator";
import { MigrationPatch } from "@tern/shared";

describe("DefaultPatchValidator", () => {
  it("rejects forbidden eval", () => {
    const validator = new DefaultPatchValidator();
    const patch: MigrationPatch = { id: "p1", filePath: "x.ts", original: "a", modified: "eval(b)", description: "", breakingChangeId: "c1", validationStatus: "pending", validationErrors: [], diff: "", lineCountChanged: 0 };
    const result = validator.validate(patch);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("Forbidden")));
  });
});
