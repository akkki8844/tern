// Assemble the Next.js standalone server for deployment.
//
// `output: "standalone"` emits a minimal server at
//   .next/standalone/apps/web/server.js
// but deliberately leaves out static assets (documented Next.js behaviour).
// This script copies them in, so `npm run start -w @tern/web` (used by
// Dockerfile.web) serves a complete, self-contained artifact.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = dirname(fileURLToPath(import.meta.url)); // apps/web/scripts
const appRoot = dirname(webRoot); // apps/web
const standaloneApp = join(appRoot, ".next", "standalone", "apps", "web");

if (!existsSync(join(standaloneApp, "server.js"))) {
  console.error("standalone server not found — run `next build` first");
  process.exit(1);
}

// Static browser assets: .next/static -> <standalone>/apps/web/.next/static
mkdirSync(join(standaloneApp, ".next"), { recursive: true });
cpSync(join(appRoot, ".next", "static"), join(standaloneApp, ".next", "static"), { recursive: true });

// Public assets, when the app has any.
const publicDir = join(appRoot, "public");
if (existsSync(publicDir)) {
  cpSync(publicDir, join(standaloneApp, "public"), { recursive: true });
}

console.log("standalone server assembled at .next/standalone/apps/web");
