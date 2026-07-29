
import { DefaultSpecLoader, DefaultDiffEngine } from "@tern/openapi";
const loader = new DefaultSpecLoader();
const oldSpec = await loader.load("demo/acmepay-openapi-v1.yaml");
const newSpec = await loader.load("demo/acmepay-openapi-v2.yaml");
const changes = await new DefaultDiffEngine().diff(oldSpec, newSpec);
console.log(`Detected ${changes.length} breaking changes:`);
changes.forEach(c => console.log(`  - ${c.type}: ${c.description}`));
