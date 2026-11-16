/**
 * Capibara error model.
 *
 * Every error thrown by Capibara infrastructure extends {@link CapibaraError}. Errors carry:
 *  - a stable machine readable `code`
 *  - a `category` used for routing/observability
 *  - a `retryable` hint used by the job system and provider clients
 *  - a `publicMessage` that is safe to expose to end users (never contains secrets,
 *    stack traces or internal identifiers)
 *  - optional structured `details` for internal diagnostics only
 *
 * Internal diagnostics are preserved on the instance (`details`, `cause`, `stack`) but
 * `toPublicJSON()` deliberately omits them.
 */

export type ErrorCategory =
  | "CONFIGURATION"
  | "AUTHENTICATION"
  | "AUTHORIZATION"
  | "GITHUB"
  | "DATABASE"
  | "OPENAPI"
  | "SCANNER"
  | "MIGRATION"
  | "VALIDATION"
  | "SANDBOX"
  | "AI_PROVIDER"
  | "JOB"
  | "WORKSPACE"
  | "PIPELINE"
  | "SECURITY"
  | "INTERNAL";

export interface CapibaraErrorOptions {
  /** Stable machine readable code, e.g. `GITHUB_INSTALLATION_TOKEN_FAILED`. */
  code?: string;
  /** Message that is safe to return over the wire. Defaults to a generic category message. */
  publicMessage?: string;
  /** Whether the operation may succeed if retried. */
  retryable?: boolean;
  /** Structured internal diagnostics. Never serialised into public payloads. */
  details?: Record<string, unknown>;
  /** Underlying error. */
  cause?: unknown;
}

const GENERIC_PUBLIC_MESSAGE: Record<ErrorCategory, string> = {
  CONFIGURATION: "The service is not configured correctly.",
  AUTHENTICATION: "Authentication failed.",
  AUTHORIZATION: "You are not allowed to perform this action.",
  GITHUB: "A GitHub operation failed.",
  DATABASE: "A storage operation failed.",
  OPENAPI: "The OpenAPI specification could not be processed.",
  SCANNER: "The repository scan failed.",
  MIGRATION: "The migration could not be generated.",
  VALIDATION: "The request was invalid.",
  SANDBOX: "The sandboxed verification run failed.",
  AI_PROVIDER: "The AI provider request failed.",
  JOB: "A background job failed.",
  WORKSPACE: "The analysis workspace could not be prepared.",
  PIPELINE: "The migration pipeline failed.",
  SECURITY: "The request was rejected by a security policy.",
  INTERNAL: "An internal error occurred."
};

export class CapibaraError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly retryable: boolean;
  readonly publicMessage: string;
  readonly details: Record<string, unknown>;
  readonly timestamp: Date;

  constructor(category: ErrorCategory, message: string, options: CapibaraErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.category = category;
    this.code = options.code ?? `${category}_ERROR`;
    this.retryable = options.retryable ?? false;
    this.publicMessage = options.publicMessage ?? GENERIC_PUBLIC_MESSAGE[category];
    this.details = options.details ?? {};
    this.timestamp = new Date();
    Error.captureStackTrace?.(this, new.target);
  }

  /** Safe representation for HTTP responses / user surfaces. Never includes stacks or details. */
  toPublicJSON(): { error: { code: string; category: ErrorCategory; message: string } } {
    return { error: { code: this.code, category: this.category, message: this.publicMessage } };
  }

  /** Full representation for internal structured logging. */
  toLogJSON(): Record<string, unknown> {
    return {
      name: this.name,
      category: this.category,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
      cause: this.cause instanceof Error ? { name: this.cause.name, message: this.cause.message } : undefined
    };
  }
}

function subclass(category: ErrorCategory) {
  return class extends CapibaraError {
    constructor(message: string, options: CapibaraErrorOptions = {}) {
      super(category, message, options);
    }
  };
}

export class ConfigurationError extends subclass("CONFIGURATION") {}
export class AuthenticationError extends subclass("AUTHENTICATION") {}
export class AuthorizationError extends subclass("AUTHORIZATION") {}
export class GitHubError extends subclass("GITHUB") {}
export class DatabaseError extends subclass("DATABASE") {}
export class OpenAPIError extends subclass("OPENAPI") {}
export class ScannerError extends subclass("SCANNER") {}
export class MigrationError extends subclass("MIGRATION") {}
export class ValidationError extends subclass("VALIDATION") {}
export class SandboxError extends subclass("SANDBOX") {}
export class AIProviderError extends subclass("AI_PROVIDER") {}
export class JobError extends subclass("JOB") {}
export class WorkspaceError extends subclass("WORKSPACE") {}
export class PipelineError extends subclass("PIPELINE") {}
export class SecurityError extends subclass("SECURITY") {}
export class InternalError extends subclass("INTERNAL") {}

export function isCapibaraError(value: unknown): value is CapibaraError {
  return value instanceof CapibaraError;
}

export function isRetryableError(value: unknown): boolean {
  return isCapibaraError(value) ? value.retryable : false;
}

/** Normalise an unknown thrown value into a CapibaraError without losing information. */
export function toCapibaraError(value: unknown, fallbackCategory: ErrorCategory = "INTERNAL"): CapibaraError {
  if (isCapibaraError(value)) return value;
  if (value instanceof Error) {
    return new CapibaraError(fallbackCategory, value.message, { cause: value });
  }
  return new CapibaraError(fallbackCategory, typeof value === "string" ? value : "Unknown error", {
    details: { raw: typeof value }
  });
}

/** Message safe to show to a user for any thrown value. */
export function publicMessageOf(value: unknown): string {
  return isCapibaraError(value) ? value.publicMessage : GENERIC_PUBLIC_MESSAGE.INTERNAL;
}

/** Message safe to write to internal logs (never a stack trace). */
export function internalMessageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  return typeof value === "string" ? value : "Unknown error";
}
