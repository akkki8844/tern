
import { describe, it } from "node:test";
import assert from "node:assert";
import { DefaultPatchValidator } from "@tern/migration-engine";
import { MigrationPatch } from "@tern/shared";

describe("Security regression tests", () => {
  const validator = new DefaultPatchValidator();
  const cases: { name: string; file: string; modified: string; valid: boolean }[] = [
    { name: "eval injection", file: "x.ts", modified: "eval(payload)", valid: false },
    { name: "child_process", file: "x.ts", modified: "require('child_process').spawn('rm')", valid: false },
    { name: "path traversal", file: "../.env", modified: "ok", valid: false },
    { name: "lockfile", file: "yarn.lock", modified: "ok", valid: false },
    { name: "package json", file: "package.json", modified: "ok", valid: false },
    { name: "safe rename", file: "src/client.ts", modified: "payment_method", valid: true },
    { name: "secret in patch", file: "src/client.ts", modified: "const apiKey = 'sk_live_1234567890abcdef'", valid: false },
  ];

  for (const c of cases) {
    it(`${c.name} should be ${c.valid ? "valid" : "invalid"}`, () => {
      const patch: MigrationPatch = {
        id: "p1",
        filePath: c.file,
        original: "old",
        modified: c.modified,
        description: "Rename source to payment_method",
        breakingChangeId: "c1",
        validationStatus: "pending",
        validationErrors: [],
        diff: "",
        lineCountChanged: 0
      };
      const result = validator.validate(patch);
      assert.strictEqual(result.valid, c.valid, `Expected ${c.valid}, got ${result.valid}: ${result.errors.join(", ")} ${result.warnings.join(", ")}`);
    });
  }
});
