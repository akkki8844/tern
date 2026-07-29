
import { DefaultSpecLoader, DefaultDiffEngine } from "@tern/openapi";
import { TreeSitterScanner } from "@tern/scanner";
import { DefaultMigrationEngine } from "@tern/migration-engine";
import path from "path";
const repoPath = path.join(process.cwd(), "demo", "broken-app");
const loader = new DefaultSpecLoader();
const oldSpec = await loader.load("demo/acmepay-openapi-v1.yaml");
const newSpec = await loader.load("demo/acmepay-openapi-v2.yaml");
const changes = await new DefaultDiffEngine().diff(oldSpec, newSpec);
const usages = await new TreeSitterScanner().scan(repoPath, changes);
const patches = await new DefaultMigrationEngine().generatePatches(repoPath, changes, usages);
console.log(`Generated ${patches.length} patches`);
patches.forEach(p => console.log(`  ${p.filePath}: ${p.validationStatus} (${p.validationErrors.join(", ")})`));
