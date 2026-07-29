
import { DefaultSandboxRunner } from "@tern/sandbox";
import path from "path";
const repoPath = path.join(process.cwd(), "demo", "broken-app");
const runner = new DefaultSandboxRunner();
const result = await runner.run(repoPath, "npm test", { timeoutMs: 120000 });
console.log(`Sandbox result: ${result.status}`);
console.log(result.stdout);
console.log(result.stderr);
