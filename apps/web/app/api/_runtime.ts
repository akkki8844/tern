import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureLogging, getConfig, initConfig, type CapibaraConfig } from "@capibara/shared";
import { AuditLogger, createPrismaSqlClient, getPrisma } from "@capibara/db";
import { PostgresJobStore } from "@capibara/jobs";
import { createGitHubProvider } from "@capibara/github";

let initialised = false;

/**
 * Lazily initialise the shared server runtime for API routes.
 *
 * Next.js has no single process entrypoint, so configuration is validated on the
 * first request that needs it. A misconfiguration therefore surfaces as a 500 with a
 * clear log line rather than as silent, half-working behaviour.
 */
export function serverConfig(): CapibaraConfig {
  if (!initialised) {
    const config = initConfig({
      defaultWorkspaceRoot: join(tmpdir(), "capibara-workspaces"),
      defaultDemoRepoPath: join(process.cwd(), "demo", "broken-app")
    });
    configureLogging(config.logging);
    initialised = true;
    return config;
  }
  return getConfig();
}

export function prisma() {
  serverConfig();
  return getPrisma();
}

export function jobStore(): PostgresJobStore {
  return new PostgresJobStore(createPrismaSqlClient(prisma()));
}

export function auditLogger(): AuditLogger {
  return new AuditLogger(prisma());
}

export function github() {
  return createGitHubProvider(serverConfig());
}
