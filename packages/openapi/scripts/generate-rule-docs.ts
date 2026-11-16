import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderRuleCatalogMarkdown } from "../dist/docs.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const target = join(repoRoot, "docs", "openapi-rules.md");
await writeFile(target, renderRuleCatalogMarkdown(), "utf8");
console.log(`wrote ${target}`);
