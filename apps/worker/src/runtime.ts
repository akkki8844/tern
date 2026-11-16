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
  type TernConfig,
  type WorkspaceProvider
} from "@tern/shared";
import { createGitHubProvider, GitHubAppProvider } from "@tern/github";
import { createAIProvider } from "@tern/llm";
import { FilesystemWorkspaceProvider } from "@tern/workspace";
import { ProcessSandboxRunner, type SandboxRunner } from "@tern/sandbox";
import { GitRepositoryProvider, LocalRepositoryProvider } from "@tern/pipeline";
import { PostgresJobStore } from "@tern/jobs";
import { AuditLogger, checkDatabaseConnection, createPrismaSqlClient, getPrisma } from "@tern/db";

export interface Runtime {
  config: TernConfig;
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
    defaultWorkspaceRoot: join(tmpdir(), "tern-workspaces"),
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
