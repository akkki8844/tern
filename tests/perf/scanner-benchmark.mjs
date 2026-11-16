
// Performance benchmark for the AST repository scanner.
//
// Generates hermetic fixtures in a temp directory (never inside a repository),
// runs the real engine and prints measured wall-clock numbers. Run with:
//   node tests/perf/scanner-benchmark.mjs [iterations]
// Numbers vary with hardware; they are reported, not promised. The assertions
// at the end guard only against gross nonlinear blowups, not exact timings.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { RepositoryScanner } from "@tern/scanner";
import { analyzeSpecChange } from "@tern/openapi";

const iterations = Number(process.argv[2] ?? 3);

const spec = (paths) => ({ openapi: "3.0.3", info: { title: "perf", version: "1" }, paths });
const oldDoc = spec({
  "/orders": { get: { operationId: "listOrders" } },
  "/orders/{id}": { get: { operationId: "getOrder", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } }
});
const newDoc = spec({
  "/orders": { get: { operationId: "listOrdersRenamed" } },
  "/orders/{id}": { get: { operationId: "getOrderV2", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } }
});
const analysis = analyzeSpecChange(oldDoc, newDoc);

function serviceFile(i) {
  // Each file: an axios instance import chain + direct call + a wrapper hop.
  return [
    `import axios from "axios";`,
    `import { helper${i} } from "./lib${i}.js";`,
    ``,
    `export const api${i} = axios.create({ baseURL: "https://api.example.com" });`,
    ``,
    `export async function list${i}() {`,
    `  const res = await api${i}.get("/orders");`,
    `  return res.data;`,
    `}`,
    ``,
    `export async function one${i}(id) {`,
    `  return helper${i}(id);`,
    `}`,
    ``,
    `export async function unused${i}(id) {`,
    `  const r = await fetch("https://api.example.com/orders/" + id);`,
    `  return r.json();`,
    `}`
  ].join("\n");
}

function libFile(i) {
  return [
    `import { api${i} } from "./service${i}.js";`,
    ``,
    `export async function helper${i}(id) {`,
    `  return api${i}.get(\`/orders/\${id}\`);`,
    `}`
  ].join("\n");
}

function generateFlat(dir, files) {
  for (let i = 0; i < files / 2; i++) {
    writeFileSync(join(dir, `service${i}.js`), serviceFile(i));
    writeFileSync(join(dir, `lib${i}.js`), libFile(i));
  }
}

function generateChain(dir, depth) {
  // Deep import graph: chain0 -> chain1 -> ... -> chainN, each hop a wrapper.
  writeFileSync(
    join(dir, `chain${depth - 1}.js`),
    `import axios from "axios";\nexport const api = axios.create({});\nexport const leaf = (id) => api.get(\`/orders/\${id}\`);\n`
  );
  for (let i = depth - 2; i >= 0; i--) {
    writeFileSync(
      join(dir, `chain${i}.js`),
      `import { leaf${""}${i + 1} } from "./chain${i + 1}.js";\nexport const hop${i} = (id) => hop${i + 1}(id);\n`
    );
  }
}

function generateWide(dir, count) {
  // All import one shared module — shared-symbol stress.
  writeFileSync(
    join(dir, "shared.js"),
    `import axios from "axios";\nexport const api = axios.create({});\n`
  );
  for (let i = 0; i < count; i++) {
    writeFileSync(join(dir, `use${i}.js`), `import { api } from "./shared.js";\nexport const call${i} = () => api.get("/orders");\n`);
  }
}

function generateLarge(dir) {
  // A single large generated-looking file (barrel of delegates).
  const parts = [`import axios from "axios";`, `export const api = axios.create({});`];
  for (let i = 0; i < 2500; i++) {
    parts.push(`export async function op${i}(id) { return api.get(\`/orders/\${id}\`); }`);
  }
  writeFileSync(join(dir, "generated-sdk.js"), parts.join("\n"));
}

async function bench(name, prepare, scanDir) {
  const dir = mkdtempSync(join(tmpdir(), `tern-perf-${name}-`));
  try {
    prepare(dir);
    const scanner = new RepositoryScanner();
    // Warm-up parse of tree-sitter grammars.
    await scanner.scan(dir, analysis);
    const runs = [];
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      const result = await scanner.scan(dir, analysis);
      runs.push({ ms: performance.now() - t0, usages: result.usages.length, files: result.files.length });
    }
    const times = runs.map((r) => r.ms).sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    console.log(
      `${name.padEnd(28)} median ${median.toFixed(0)}ms  (min ${times[0].toFixed(0)}, max ${times[times.length - 1].toFixed(0)})` +
        ` — files: ${runs[0].files}, usages: ${runs[0].usages}`
    );
    return median;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`scanner benchmark — ${iterations} iteration(s) per fixture, median reported\n`);
const results = {};
results.files100 = await bench("100 files (flat)", (d) => generateFlat(d, 100), (d) => d);
results.files1000 = await bench("1000 files (flat)", (d) => generateFlat(d, 1000), (d) => d);
results.deep50 = await bench("deep import chain (50)", (d) => generateChain(d, 50), (d) => d);
results.wide500 = await bench("500 importers of 1 shared", (d) => generateWide(d, 500), (d) => d);
results.large = await bench("large generated file (2.5k fns)", (d) => generateLarge(d), (d) => d);

// Gross blowup guard: 1000 files should cost well under 30x the 100-file cost
// (linear would be 10x; the margin absorbs discovery/symbol-cache effects).
const ratio = results.files1000 / results.files100;
console.log(`\nscaling 100→1000 files: ${ratio.toFixed(1)}x (sub-linear expectation: < 30x)`);
if (ratio >= 30) {
  console.error("FAIL: super-linear scaling detected");
  process.exit(1);
}
console.log("OK: no gross nonlinear blowup");
