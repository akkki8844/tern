/**
 * Structured logging.
 *
 * Every log line carries: service, component, level, time, message plus whatever
 * structured context the caller attaches. Loggers are hierarchical, so a job
 * handler can bind `{ jobId, analysisRunId, stage }` once and every downstream
 * line inherits it.
 *
 * Everything passed as context is run through `redactValue` before it reaches the
 * transport. There is no code path that writes an unredacted object to the log.
 */
import pino, { type Logger as PinoLogger, type LoggerOptions } from "pino";
import { redactValue } from "./redaction.js";
import { internalMessageOf, isCapibaraError } from "./errors.js";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type LogContext = Record<string, unknown>;

export interface Logger {
  trace(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  fatal(message: string, context?: LogContext): void;
  /** Log an error object with its internal diagnostics (never a stack trace payload). */
  failure(message: string, error: unknown, context?: LogContext): void;
  /** Derive a logger with additional permanent context. */
  child(context: LogContext): Logger;
  /** Measure and log the duration of an async operation. */
  time<T>(message: string, fn: () => Promise<T>, context?: LogContext): Promise<T>;
}

export interface LoggerConfig {
  level: string;
  pretty: boolean;
  serviceName: string;
}

let rootPino: PinoLogger | undefined;
/**
 * Bootstrap defaults, used only until `configureLogging` runs with validated
 * configuration. `LOG_LEVEL` is read here (the one documented exception to the
 * "configuration owns process.env" rule) so that failures during configuration
 * loading itself are logged at the operator's chosen level.
 */
let currentConfig: LoggerConfig = {
  level: process.env.LOG_LEVEL ?? "info",
  pretty: false,
  serviceName: "capibara"
};

function buildPino(config: LoggerConfig): PinoLogger {
  const options: LoggerOptions = {
    level: config.level,
    base: { service: config.serviceName },
    // pino's own redaction as a second line of defence for well known paths.
    redact: {
      paths: [
        "token",
        "*.token",
        "password",
        "*.password",
        "secret",
        "*.secret",
        "authorization",
        "*.authorization",
        "headers.authorization",
        "privateKey",
        "*.privateKey"
      ],
      censor: "[REDACTED]"
    },
    formatters: {
      level(label) {
        return { level: label };
      }
    }
  };

  if (config.pretty) {
    return pino({
      ...options,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" }
      }
    });
  }

  return pino(options);
}

/**
 * Configure the logging subsystem. Call once at process start, before any logger is
 * used, so that level and destination reflect the validated configuration.
 */
export function configureLogging(config: LoggerConfig): void {
  currentConfig = config;
  rootPino = buildPino(config);
}

function root(): PinoLogger {
  if (!rootPino) rootPino = buildPino(currentConfig);
  return rootPino;
}

function wrap(instance: PinoLogger): Logger {
  const emit = (level: LogLevel) => (message: string, context?: LogContext) => {
    if (context === undefined) {
      instance[level](message);
      return;
    }
    instance[level](redactValue(context) as object, message);
  };

  const logger: Logger = {
    trace: emit("trace"),
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    fatal: emit("fatal"),
    failure(message, error, context) {
      const errorContext = isCapibaraError(error)
        ? error.toLogJSON()
        : { name: error instanceof Error ? error.name : "Unknown", message: internalMessageOf(error) };
      instance.error(redactValue({ ...context, err: errorContext }) as object, message);
    },
    child(context) {
      return wrap(instance.child(redactValue(context) as object));
    },
    async time(message, fn, context) {
      const start = Date.now();
      try {
        const result = await fn();
        instance.info(redactValue({ ...context, durationMs: Date.now() - start, outcome: "success" }) as object, message);
        return result;
      } catch (error) {
        instance.error(
          redactValue({
            ...context,
            durationMs: Date.now() - start,
            outcome: "failure",
            err: isCapibaraError(error) ? error.toLogJSON() : { message: internalMessageOf(error) }
          }) as object,
          message
        );
        throw error;
      }
    }
  };

  return logger;
}

/** Get a logger bound to a component name. */
export function getLogger(component: string, context: LogContext = {}): Logger {
  return wrap(root().child({ component, ...(redactValue(context) as object) }));
}

/** Test helper: route all output to a collector instead of stdout. */
export function createTestLogger(): { logger: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const instance = pino(
    { level: "trace", base: undefined },
    {
      write(chunk: string) {
        try {
          lines.push(JSON.parse(chunk));
        } catch {
          lines.push({ raw: chunk });
        }
      }
    }
  );
  return { logger: wrap(instance), lines };
}
