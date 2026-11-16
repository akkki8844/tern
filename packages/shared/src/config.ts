/**
 * Tern configuration.
 *
 * This is the ONLY module in the codebase that is allowed to read `process.env`.
 * Everything else must call `getConfig()` (or receive config through its constructor).
 *
 * Rules enforced here:
 *  - every variable is documented in `docs/environment.md` and in ENV_VARS below
 *  - every variable is parsed and validated with zod
 *  - secrets are wrapped in `Secret` so they cannot be logged accidentally
 *  - configuration is validated once, at process start, and cached
 *  - missing required configuration produces an actionable ConfigurationError
 *
 * Runtime modes
 *  - `production`  : real providers, all production variables required
 *  - `development` : real providers if configured, relaxed requirements
 *  - `test`        : never contacts external services
 *  - demo (flag)   : orthogonal to NODE_ENV; forces demo providers everywhere
 */
import { z } from "zod";
import { ConfigurationError } from "./errors.js";
import { Secret, secret } from "./secret.js";

export type NodeEnv = "development" | "test" | "production";

export interface EnvVarDoc {
  name: string;
  required: "always" | "production" | "never";
  secret: boolean;
  description: string;
  example?: string;
}

/** Single source of truth for environment variable documentation. */
export const ENV_VARS: readonly EnvVarDoc[] = [
  { name: "NODE_ENV", required: "never", secret: false, description: "development | test | production. Defaults to development.", example: "production" },
  { name: "TERN_MODE", required: "never", secret: false, description: "'real' (default) or 'demo'. Demo mode swaps every external provider for an in-memory one.", example: "demo" },
  { name: "DEMO_MODE", required: "never", secret: false, description: "Legacy alias for TERN_MODE=demo. 'true' enables demo mode.", example: "true" },
  { name: "LOG_LEVEL", required: "never", secret: false, description: "pino level: trace|debug|info|warn|error|fatal|silent. Defaults to info.", example: "debug" },
  { name: "LOG_PRETTY", required: "never", secret: false, description: "'true' to enable pino-pretty. Never enabled automatically in production.", example: "true" },
  { name: "SERVICE_NAME", required: "never", secret: false, description: "Value attached to every log line. Defaults to 'tern'.", example: "tern-worker" },

  { name: "DATABASE_URL", required: "always", secret: true, description: "PostgreSQL connection string. Source of truth for all persistent state.", example: "postgresql://user:pass@localhost:5432/tern" },
  { name: "DATABASE_POOL_SIZE", required: "never", secret: false, description: "Prisma connection_limit hint. Defaults to 10.", example: "10" },

  { name: "GITHUB_APP_ID", required: "production", secret: false, description: "Numeric GitHub App ID. Required for real GitHub operations.", example: "123456" },
  { name: "GITHUB_PRIVATE_KEY", required: "production", secret: true, description: "GitHub App private key: PEM text (literal \\n allowed) or base64-encoded PEM.", example: "-----BEGIN RSA PRIVATE KEY-----..." },
  { name: "GITHUB_WEBHOOK_SECRET", required: "production", secret: true, description: "Shared secret used to verify X-Hub-Signature-256 on inbound webhooks. Minimum 16 characters.", example: "a-long-random-string" },
  { name: "GITHUB_API_BASE_URL", required: "never", secret: false, description: "GitHub REST base URL. Override for GitHub Enterprise.", example: "https://api.github.com" },

  { name: "GITHUB_CLIENT_ID", required: "never", secret: false, description: "GitHub OAuth App client id. Used ONLY for user sign-in, never for repository writes.", example: "Iv1.abc123" },
  { name: "GITHUB_CLIENT_SECRET", required: "never", secret: true, description: "GitHub OAuth App client secret. Required if GITHUB_CLIENT_ID is set.", example: "secret" },
  { name: "SESSION_SECRET", required: "never", secret: true, description: "HMAC key for signing user session cookies. Minimum 32 characters. Required if OAuth is enabled.", example: "32+ char random string" },
  { name: "PUBLIC_BASE_URL", required: "never", secret: false, description: "Externally reachable base URL of the web app; used to build OAuth redirect URIs.", example: "https://tern.example.com" },

  { name: "FIREWORKS_API_KEY", required: "never", secret: true, description: "Fireworks AI API key. When absent the AI fallback is disabled (deterministic migrations still run).", example: "fw_..." },
  { name: "FIREWORKS_BASE_URL", required: "never", secret: false, description: "Fireworks inference base URL.", example: "https://api.fireworks.ai/inference/v1" },
  { name: "FIREWORKS_MODEL", required: "never", secret: false, description: "Fireworks model identifier.", example: "accounts/fireworks/models/llama-v3p1-70b-instruct" },
  { name: "FIREWORKS_TIMEOUT_MS", required: "never", secret: false, description: "Per-request timeout for AI calls. Defaults to 60000.", example: "60000" },
  { name: "FIREWORKS_MAX_ATTEMPTS", required: "never", secret: false, description: "Max AI request attempts including the first. Defaults to 3.", example: "3" },
  { name: "FIREWORKS_MAX_PROMPT_CHARS", required: "never", secret: false, description: "Hard cap on characters sent to the AI provider per request. Defaults to 24000.", example: "24000" },

  { name: "WORKER_CONCURRENCY", required: "never", secret: false, description: "Maximum jobs processed simultaneously by one worker. Defaults to 2.", example: "4" },
  { name: "WORKER_POLL_INTERVAL_MS", required: "never", secret: false, description: "Idle poll interval for the job queue. Defaults to 2000.", example: "2000" },
  { name: "WORKER_LEASE_DURATION_MS", required: "never", secret: false, description: "How long a claimed job stays leased before it is considered stale. Defaults to 60000.", example: "60000" },
  { name: "WORKER_HEARTBEAT_INTERVAL_MS", required: "never", secret: false, description: "How often a running job renews its lease. Must be well below the lease duration. Defaults to 15000.", example: "15000" },
  { name: "WORKER_SHUTDOWN_TIMEOUT_MS", required: "never", secret: false, description: "Grace period for in-flight jobs on SIGTERM/SIGINT. Defaults to 30000.", example: "30000" },
  { name: "WORKER_ID", required: "never", secret: false, description: "Stable worker identity. Defaults to `${hostname}-${pid}`.", example: "worker-1" },

  { name: "WORKSPACE_ROOT", required: "never", secret: false, description: "Absolute directory that contains all per-job workspaces. Defaults to <os.tmpdir()>/tern-workspaces.", example: "/var/lib/tern/workspaces" },
  { name: "WORKSPACE_MAX_BYTES", required: "never", secret: false, description: "Maximum total bytes a single workspace may hold. Defaults to 536870912 (512MiB).", example: "536870912" },

  { name: "SANDBOX_TIMEOUT_MS", required: "never", secret: false, description: "Default sandbox command timeout. Defaults to 300000.", example: "300000" },
  { name: "SANDBOX_MEMORY_MB", required: "never", secret: false, description: "Advisory sandbox memory limit. Defaults to 2048.", example: "2048" },
  { name: "SANDBOX_CPU_LIMIT", required: "never", secret: false, description: "Advisory sandbox CPU limit. Defaults to 2.", example: "2" },

  { name: "TERN_DEMO_REPO_PATH", required: "never", secret: false, description: "Local repository used as the checkout source in demo mode. Defaults to <cwd>/demo/broken-app.", example: "/srv/tern/demo/broken-app" },

  { name: "ENCRYPTION_KEY", required: "never", secret: true, description: "Key material for at-rest encryption of stored provider tokens. Minimum 32 characters.", example: "32+ char random string" }
] as const;

const booleanish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? defaultValue : /^(1|true|yes|on)$/i.test(v)));

const intInRange = (min: number, max: number, defaultValue: number, name: string) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return defaultValue;
      const parsed = Number(v);
      if (!Number.isInteger(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${name} must be an integer, received "${v}"` });
        return z.NEVER;
      }
      if (parsed < min || parsed > max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${name} must be between ${min} and ${max}, received ${parsed}` });
        return z.NEVER;
      }
      return parsed;
    });

const nonEmpty = z.string().trim().min(1);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).optional().default("development"),
  TERN_MODE: z.enum(["real", "demo"]).optional(),
  DEMO_MODE: booleanish(false),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).optional().default("info"),
  LOG_PRETTY: booleanish(false),
  SERVICE_NAME: nonEmpty.optional().default("tern"),

  DATABASE_URL: z.string().optional(),
  DATABASE_POOL_SIZE: intInRange(1, 100, 10, "DATABASE_POOL_SIZE"),

  GITHUB_APP_ID: z.string().optional(),
  GITHUB_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_API_BASE_URL: z.string().url().optional().default("https://api.github.com"),

  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  PUBLIC_BASE_URL: z.string().url().optional(),

  FIREWORKS_API_KEY: z.string().optional(),
  FIREWORKS_BASE_URL: z.string().url().optional().default("https://api.fireworks.ai/inference/v1"),
  FIREWORKS_MODEL: nonEmpty.optional().default("accounts/fireworks/models/llama-v3p1-70b-instruct"),
  FIREWORKS_TIMEOUT_MS: intInRange(1_000, 600_000, 60_000, "FIREWORKS_TIMEOUT_MS"),
  FIREWORKS_MAX_ATTEMPTS: intInRange(1, 10, 3, "FIREWORKS_MAX_ATTEMPTS"),
  FIREWORKS_MAX_PROMPT_CHARS: intInRange(1_000, 200_000, 24_000, "FIREWORKS_MAX_PROMPT_CHARS"),

  WORKER_CONCURRENCY: intInRange(1, 64, 2, "WORKER_CONCURRENCY"),
  WORKER_POLL_INTERVAL_MS: intInRange(100, 300_000, 2_000, "WORKER_POLL_INTERVAL_MS"),
  WORKER_LEASE_DURATION_MS: intInRange(5_000, 3_600_000, 60_000, "WORKER_LEASE_DURATION_MS"),
  WORKER_HEARTBEAT_INTERVAL_MS: intInRange(1_000, 600_000, 15_000, "WORKER_HEARTBEAT_INTERVAL_MS"),
  WORKER_SHUTDOWN_TIMEOUT_MS: intInRange(1_000, 600_000, 30_000, "WORKER_SHUTDOWN_TIMEOUT_MS"),
  WORKER_ID: z.string().optional(),

  WORKSPACE_ROOT: z.string().optional(),
  WORKSPACE_MAX_BYTES: intInRange(1_048_576, 68_719_476_736, 536_870_912, "WORKSPACE_MAX_BYTES"),

  SANDBOX_TIMEOUT_MS: intInRange(1_000, 1_800_000, 300_000, "SANDBOX_TIMEOUT_MS"),
  SANDBOX_MEMORY_MB: intInRange(64, 65_536, 2_048, "SANDBOX_MEMORY_MB"),
  SANDBOX_CPU_LIMIT: intInRange(1, 64, 2, "SANDBOX_CPU_LIMIT"),

  TERN_DEMO_REPO_PATH: z.string().optional(),
  ENCRYPTION_KEY: z.string().optional()
});

export interface DatabaseConfig {
  url: Secret;
  poolSize: number;
}

export interface GitHubAppConfig {
  /** True when App ID + private key + webhook secret are all present and well formed. */
  enabled: boolean;
  appId: string;
  privateKey: Secret;
  webhookSecret: Secret;
  apiBaseUrl: string;
}

export interface GitHubOAuthConfig {
  /** True when client id + secret + session secret are present. */
  enabled: boolean;
  clientId: string;
  clientSecret: Secret;
  sessionSecret: Secret;
  publicBaseUrl?: string;
}

export interface AIConfig {
  /** True when an API key is present. When false the pipeline must stay deterministic. */
  enabled: boolean;
  apiKey: Secret;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxAttempts: number;
  maxPromptChars: number;
}

export interface WorkerConfig {
  id: string;
  concurrency: number;
  pollIntervalMs: number;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  shutdownTimeoutMs: number;
}

export interface WorkspaceConfig {
  root: string;
  maxBytes: number;
}

export interface SandboxConfig {
  timeoutMs: number;
  memoryMb: number;
  cpuLimit: number;
}

export interface LoggingConfig {
  level: string;
  pretty: boolean;
  serviceName: string;
}

export interface TernConfig {
  nodeEnv: NodeEnv;
  isProduction: boolean;
  isTest: boolean;
  /** Demo mode forces in-memory providers; no external side effects are possible. */
  demoMode: boolean;
  /** Local repository used as the checkout source in demo mode. */
  demoRepoPath: string;
  logging: LoggingConfig;
  database: DatabaseConfig;
  githubApp: GitHubAppConfig;
  githubOAuth: GitHubOAuthConfig;
  ai: AIConfig;
  worker: WorkerConfig;
  workspace: WorkspaceConfig;
  sandbox: SandboxConfig;
  encryptionKey?: Secret;
}

const PEM_RE = /-----BEGIN (?:RSA |EC |PKCS8 )?PRIVATE KEY-----[\s\S]+-----END (?:RSA |EC |PKCS8 )?PRIVATE KEY-----/;

/**
 * Accepts a PEM with real newlines, a PEM with literal `\n` sequences (common in
 * environment variables), or a base64 encoding of either. Returns normalised PEM text.
 * Throws if the value does not look like a private key — without echoing the value.
 */
export function normalizePrivateKey(raw: string): string {
  const withNewlines = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
  if (PEM_RE.test(withNewlines)) return withNewlines.trim() + "\n";

  const compact = withNewlines.replace(/\s+/g, "");
  if (/^[A-Za-z0-9+/=]+$/.test(compact) && compact.length > 100) {
    let decoded: string;
    try {
      decoded = Buffer.from(compact, "base64").toString("utf8");
    } catch {
      throw new ConfigurationError("GITHUB_PRIVATE_KEY is not valid base64", {
        code: "CONFIG_GITHUB_PRIVATE_KEY_INVALID"
      });
    }
    if (PEM_RE.test(decoded)) return decoded.trim() + "\n";
  }

  throw new ConfigurationError(
    "GITHUB_PRIVATE_KEY must be a PEM private key (raw, with literal \\n, or base64-encoded)",
    { code: "CONFIG_GITHUB_PRIVATE_KEY_INVALID" }
  );
}

export interface LoadConfigOptions {
  /** Environment source. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Values applied on top of the environment (used by the demo entrypoint). */
  overrides?: Record<string, string>;
  /** Hostname used to build the default worker id. */
  hostname?: string;
  /** Process id used to build the default worker id. */
  pid?: number;
  /** Default workspace root when WORKSPACE_ROOT is unset. */
  defaultWorkspaceRoot?: string;
  /** Default demo repository path when TERN_DEMO_REPO_PATH is unset. */
  defaultDemoRepoPath?: string;
}

/**
 * Parse and validate configuration. Throws {@link ConfigurationError} with an
 * actionable, secret-free message when anything is wrong.
 */
export function loadConfig(options: LoadConfigOptions = {}): TernConfig {
  const env = { ...(options.env ?? (process.env as Record<string, string | undefined>)), ...(options.overrides ?? {}) };
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigurationError(`Invalid environment configuration:\n${issues.join("\n")}`, {
      code: "CONFIG_INVALID",
      publicMessage: "The service is not configured correctly."
    });
  }

  const e = parsed.data;
  const nodeEnv = e.NODE_ENV;
  const isProduction = nodeEnv === "production";
  const isTest = nodeEnv === "test";
  const demoMode = e.TERN_MODE ? e.TERN_MODE === "demo" : e.DEMO_MODE;

  const problems: string[] = [];

  // ---- database -----------------------------------------------------------
  const databaseUrl = e.DATABASE_URL?.trim() ?? "";
  if (!databaseUrl) {
    problems.push("DATABASE_URL is required. Example: postgresql://user:pass@localhost:5432/tern");
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push("DATABASE_URL must be a postgresql:// connection string (Tern only supports PostgreSQL)");
  }

  // ---- github app ---------------------------------------------------------
  const appId = e.GITHUB_APP_ID?.trim() ?? "";
  const rawPrivateKey = e.GITHUB_PRIVATE_KEY?.trim() ?? "";
  const webhookSecret = e.GITHUB_WEBHOOK_SECRET?.trim() ?? "";
  const githubAppConfigured = Boolean(appId || rawPrivateKey || webhookSecret);
  let privateKey = "";

  if (githubAppConfigured) {
    if (!appId) problems.push("GITHUB_APP_ID is required when any GitHub App variable is set");
    else if (!/^\d+$/.test(appId)) problems.push("GITHUB_APP_ID must be numeric");

    if (!rawPrivateKey) {
      problems.push("GITHUB_PRIVATE_KEY is required when any GitHub App variable is set");
    } else {
      try {
        privateKey = normalizePrivateKey(rawPrivateKey);
      } catch (err) {
        problems.push(err instanceof Error ? err.message : "GITHUB_PRIVATE_KEY is invalid");
      }
    }

    if (!webhookSecret) problems.push("GITHUB_WEBHOOK_SECRET is required when any GitHub App variable is set");
    else if (webhookSecret.length < 16) problems.push("GITHUB_WEBHOOK_SECRET must be at least 16 characters");
  }

  const githubAppEnabled = githubAppConfigured && Boolean(appId && privateKey && webhookSecret.length >= 16);

  if (isProduction && !demoMode && !githubAppEnabled) {
    problems.push(
      "GITHUB_APP_ID, GITHUB_PRIVATE_KEY and GITHUB_WEBHOOK_SECRET are required in production (or set TERN_MODE=demo)"
    );
  }

  // ---- github oauth (user identity only) ----------------------------------
  const clientId = e.GITHUB_CLIENT_ID?.trim() ?? "";
  const clientSecret = e.GITHUB_CLIENT_SECRET?.trim() ?? "";
  const sessionSecret = e.SESSION_SECRET?.trim() ?? "";
  const oauthConfigured = Boolean(clientId || clientSecret);

  if (oauthConfigured) {
    if (!clientId) problems.push("GITHUB_CLIENT_ID is required when GITHUB_CLIENT_SECRET is set");
    if (!clientSecret) problems.push("GITHUB_CLIENT_SECRET is required when GITHUB_CLIENT_ID is set");
    if (!sessionSecret) problems.push("SESSION_SECRET is required when GitHub OAuth is enabled");
    else if (sessionSecret.length < 32) problems.push("SESSION_SECRET must be at least 32 characters");
  }
  if (sessionSecret && sessionSecret.length < 32) {
    if (!oauthConfigured) problems.push("SESSION_SECRET must be at least 32 characters");
  }

  const oauthEnabled = Boolean(clientId && clientSecret && sessionSecret.length >= 32);

  // ---- encryption ---------------------------------------------------------
  const encryptionKey = e.ENCRYPTION_KEY?.trim() ?? "";
  if (encryptionKey && encryptionKey.length < 32) {
    problems.push("ENCRYPTION_KEY must be at least 32 characters");
  }

  // ---- worker -------------------------------------------------------------
  if (e.WORKER_HEARTBEAT_INTERVAL_MS >= e.WORKER_LEASE_DURATION_MS) {
    problems.push(
      `WORKER_HEARTBEAT_INTERVAL_MS (${e.WORKER_HEARTBEAT_INTERVAL_MS}) must be smaller than WORKER_LEASE_DURATION_MS (${e.WORKER_LEASE_DURATION_MS}); a running job must renew its lease before it expires`
    );
  }

  // ---- ai -----------------------------------------------------------------
  const fireworksKey = e.FIREWORKS_API_KEY?.trim() ?? "";

  if (problems.length > 0) {
    throw new ConfigurationError(
      `Tern configuration is invalid (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        "\nSee docs/environment.md for the full reference.",
      { code: "CONFIG_INVALID", details: { problemCount: problems.length } }
    );
  }

  const hostname = options.hostname ?? "local";
  const pid = options.pid ?? process.pid;

  return {
    nodeEnv,
    isProduction,
    isTest,
    demoMode,
    demoRepoPath: e.TERN_DEMO_REPO_PATH?.trim() || options.defaultDemoRepoPath || "",
    logging: {
      level: e.LOG_LEVEL,
      pretty: e.LOG_PRETTY && !isProduction,
      serviceName: e.SERVICE_NAME
    },
    database: {
      url: secret(databaseUrl, "DATABASE_URL"),
      poolSize: e.DATABASE_POOL_SIZE
    },
    githubApp: {
      enabled: githubAppEnabled,
      appId,
      privateKey: secret(privateKey, "GITHUB_PRIVATE_KEY"),
      webhookSecret: secret(webhookSecret, "GITHUB_WEBHOOK_SECRET"),
      apiBaseUrl: e.GITHUB_API_BASE_URL
    },
    githubOAuth: {
      enabled: oauthEnabled,
      clientId,
      clientSecret: secret(clientSecret, "GITHUB_CLIENT_SECRET"),
      sessionSecret: secret(sessionSecret, "SESSION_SECRET"),
      publicBaseUrl: e.PUBLIC_BASE_URL
    },
    ai: {
      enabled: Boolean(fireworksKey),
      apiKey: secret(fireworksKey, "FIREWORKS_API_KEY"),
      baseUrl: e.FIREWORKS_BASE_URL,
      model: e.FIREWORKS_MODEL,
      timeoutMs: e.FIREWORKS_TIMEOUT_MS,
      maxAttempts: e.FIREWORKS_MAX_ATTEMPTS,
      maxPromptChars: e.FIREWORKS_MAX_PROMPT_CHARS
    },
    worker: {
      id: e.WORKER_ID?.trim() || `${hostname}-${pid}`,
      concurrency: e.WORKER_CONCURRENCY,
      pollIntervalMs: e.WORKER_POLL_INTERVAL_MS,
      leaseDurationMs: e.WORKER_LEASE_DURATION_MS,
      heartbeatIntervalMs: e.WORKER_HEARTBEAT_INTERVAL_MS,
      shutdownTimeoutMs: e.WORKER_SHUTDOWN_TIMEOUT_MS
    },
    workspace: {
      root: e.WORKSPACE_ROOT?.trim() || options.defaultWorkspaceRoot || "",
      maxBytes: e.WORKSPACE_MAX_BYTES
    },
    sandbox: {
      timeoutMs: e.SANDBOX_TIMEOUT_MS,
      memoryMb: e.SANDBOX_MEMORY_MB,
      cpuLimit: e.SANDBOX_CPU_LIMIT
    },
    encryptionKey: encryptionKey ? secret(encryptionKey, "ENCRYPTION_KEY") : undefined
  };
}

let cached: TernConfig | undefined;

/**
 * Load configuration once and cache it. Call `initConfig()` explicitly at process
 * start so a misconfiguration fails immediately instead of at first use.
 */
export function initConfig(options: LoadConfigOptions = {}): TernConfig {
  cached = loadConfig({
    hostname: options.hostname ?? safeHostname(),
    defaultWorkspaceRoot: options.defaultWorkspaceRoot ?? defaultWorkspaceRoot(),
    ...options
  });
  return cached;
}

export function getConfig(): TernConfig {
  if (!cached) return initConfig();
  return cached;
}

/** Test-only. Clears the cached configuration. */
export function resetConfigCache(): void {
  cached = undefined;
}

/** Test-only. Installs a configuration without touching process.env. */
export function setConfigForTesting(config: TernConfig): void {
  cached = config;
}

/**
 * Redacted summary suitable for startup logs. Secrets are reported as presence + length only.
 */
export function describeConfig(config: TernConfig): Record<string, unknown> {
  return {
    nodeEnv: config.nodeEnv,
    demoMode: config.demoMode,
    demoRepoPath: config.demoMode ? config.demoRepoPath : null,
    logLevel: config.logging.level,
    serviceName: config.logging.serviceName,
    database: { configured: !config.database.url.isEmpty, poolSize: config.database.poolSize },
    githubApp: { enabled: config.githubApp.enabled, appId: config.githubApp.appId || null, apiBaseUrl: config.githubApp.apiBaseUrl },
    githubOAuth: { enabled: config.githubOAuth.enabled, clientId: config.githubOAuth.clientId || null },
    ai: { enabled: config.ai.enabled, model: config.ai.model, baseUrl: config.ai.baseUrl, timeoutMs: config.ai.timeoutMs },
    worker: config.worker,
    workspace: { root: config.workspace.root, maxBytes: config.workspace.maxBytes },
    sandbox: config.sandbox,
    encryptionConfigured: Boolean(config.encryptionKey)
  };
}

function safeHostname(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return process.env.HOSTNAME?.trim() || "local";
  } catch {
    return "local";
  }
}

function defaultWorkspaceRoot(): string {
  const tmp = process.env.TMPDIR?.replace(/\/$/, "") || "/tmp";
  return `${tmp}/tern-workspaces`;
}
