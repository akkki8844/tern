import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureLogging,
  describeConfig,
  getLogger,
  initConfig,
  type AIProvider,
  type GitHubProvider,
  type RepositoryProvider,
  type CapibaraConfig,
  type WorkspaceProvider
} from "@capibara/shared";
import { createGitHubProvider, GitHubAppProvider } from "@capibara/github";
import { createAIProvider } from "@capibara/llm";
import { FilesystemWorkspaceProvider } from "@capibara/workspace";
import { ProcessSandboxRunner, type SandboxRunner } from "@capibara/sandbox";
import { GitRepositoryProvider, LocalRepositoryProvider } from "@capibara/pipeline";
import { PostgresJobStore } from "@capibara/jobs";
import { AuditLogger, checkDatabaseConnection, createPrismaSqlClient, getPrisma } from "@capibara/db";

export interface Runtime {
  config: CapibaraConfig;
  prisma: ReturnType<typeof getPrisma>;
  jobs: PostgresJobStore;
  audit: AuditLogger;
  providers: {
    github: GitHubProvider;
    ai: AIProvider;
    repository: RepositoryProvider;
    workspaces: WorkspaceProvider;
    sandbox: SandboxRunner;
  };
}

/**
 * Build every dependency the worker needs, once, from validated configuration.
 *
 * This is the only place that decides between real and demo implementations. Nothing
 * downstream inspects `config.demoMode` to change behaviour: it receives providers.
 */
export async function createRuntime(): Promise<Runtime> {
  const config = initConfig({
    hostname: hostname(),
    defaultWorkspaceRoot: join(tmpdir(), "capibara-workspaces"),
    defaultDemoRepoPath: join(process.cwd(), "demo", "broken-app")
  });
  configureLogging(config.logging);

  const logger = getLogger("runtime");
  logger.info("configuration loaded", describeConfig(config));

  const prisma = getPrisma();
  await checkDatabaseConnection(prisma);
  logger.info("database connection verified");

  const github = createGitHubProvider(config);
  const ai = createAIProvider(config);
  const workspaces = new FilesystemWorkspaceProvider(config.workspace.root);
  const sandbox = new ProcessSandboxRunner(config.sandbox);

  const repository: RepositoryProvider =
    github instanceof GitHubAppProvider
      ? new GitRepositoryProvider(github)
      : new LocalRepositoryProvider(config.demoRepoPath);

  const removed = await workspaces.reapOrphans(60 * 60 * 1000);
  if (removed > 0) logger.warn("removed orphaned workspaces at startup", { removed });

  return {
    config,
    prisma,
    jobs: new PostgresJobStore(createPrismaSqlClient(prisma)),
    audit: new AuditLogger(prisma),
    providers: { github, ai, repository, workspaces, sandbox }
  };
}
