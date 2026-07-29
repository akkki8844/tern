
import { DefaultSpecLoader, DefaultDiffEngine } from "@tern/openapi";
import { TreeSitterScanner } from "@tern/scanner";
import path from "path";
const repoPath = path.join(process.cwd(), "demo", "broken-app");
const loader = new DefaultSpecLoader();
const oldSpec = await loader.load("demo/acmepay-openapi-v1.yaml");
const newSpec = await loader.load("demo/acmepay-openapi-v2.yaml");
const changes = await new DefaultDiffEngine().diff(oldSpec, newSpec);
const usages = await new TreeSitterScanner().scan(repoPath, changes);
console.log(`Affected usages: ${usages.length}`);
usages.forEach(u => console.log(`  ${u.file}:${u.line} ${u.functionName} (${u.confidence})`));
