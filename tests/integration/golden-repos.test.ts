
import { describe, it } from "node:test";
import assert from "node:assert";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { analyzeSpecChange, loadFromString } from "@capibara/openapi";
import { RepositoryScanner } from "@capibara/scanner";

// Golden repositories: tiny repos with a hand-reviewed expected.json each.
// The harness runs the real pipeline — Turn 2 semantic diff followed by the
// AST repository scan — and pins the exact (file, line, kind, operation,
// confidence) multiset. Any behaviour change that moves a usage, relabels a
// kind or shifts a confidence fails here and must be justified by hand.
const goldenRoot = join(path.dirname(fileURLToPath(import.meta.url)), "..", "golden");
const repos = readdirSync(goldenRoot).filter((name) => existsSync(join(goldenRoot, name, "expected.json")));

interface ExpectedUsage {
  file: string;
  line: number;
  kind: string;
  symbol: string;
  operation: string | null;
  confidence: string;
  changeCount: number;
}

function signature(u: {
  file: string;
  line: number;
  kind: string;
  operation?: { method: string; path: string };
  confidence: string;
}): string {
  return `${u.file}:${u.line}:${u.kind}:${u.operation ? `${u.operation.method} ${u.operation.path}` : "-"}:${u.confidence}`;
}

import path from "node:path";
import { fileURLToPath } from "node:url";

describe("Golden repositories", () => {
  for (const repo of repos) {
    it(`${repo}: scanner output matches the hand-reviewed expectation`, async () => {
      const dir = join(goldenRoot, repo);
      const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as {
        scanRoot: string;
        expectedUsages: ExpectedUsage[];
      };
      const oldSpec = loadFromString(readFileSync(join(dir, "openapi-old.json"), "utf8"));
      const newSpec = loadFromString(readFileSync(join(dir, "openapi-new.json"), "utf8"));
      const analysis = analyzeSpecChange(oldSpec, newSpec);
      const scan = await new RepositoryScanner().scan(join(dir, expected.scanRoot), analysis);

      const actual = scan.usages.map(signature).sort();
      const wanted = expected.expectedUsages
        .map((u) => `${u.file}:${u.line}:${u.kind}:${u.operation ?? "-"}:${u.confidence}`)
        .sort();
      assert.deepStrictEqual(actual, wanted, `${repo}: usage multiset drifted from expected.json`);
    });

    it(`${repo}: scanning twice is byte-identical (determinism)`, async () => {
      const dir = join(goldenRoot, repo);
      const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as { scanRoot: string };
      const oldSpec = loadFromString(readFileSync(join(dir, "openapi-old.json"), "utf8"));
      const newSpec = loadFromString(readFileSync(join(dir, "openapi-new.json"), "utf8"));
      const analysis = analyzeSpecChange(oldSpec, newSpec);
      const scanner = new RepositoryScanner();
      const first = await scanner.scan(join(dir, expected.scanRoot), analysis);
      const second = await scanner.scan(join(dir, expected.scanRoot), analysis);
      // `timing` is a wall-clock measurement, not analysis output; every field
      // that describes WHAT was found must be byte-identical between runs.
      const stripTiming = (scan: typeof first) => {
        const { timing: _timing, ...rest } = scan;
        return JSON.stringify(rest);
      };
      assert.strictEqual(stripTiming(second), stripTiming(first), `${repo}: rerun was not byte-identical`);
    });
  }
});
