import pino from "pino";

export interface Logger {
  debug: (msg: string | object, meta?: object | string) => void;
  info: (msg: string | object, meta?: object | string) => void;
  warn: (msg: string | object, meta?: object | string) => void;
  error: (msg: string | object, meta?: object | string) => void;
}

const pinoLogger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: process.env.NODE_ENV !== "production" ? {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname"
    }
  } : undefined
});

export function getLogger(name: string): Logger {
  const child = pinoLogger.child({ name });
  return {
    debug: (msg, meta) => {
      const sanitized = sanitizeForLog(msg);
      if (typeof sanitized === "string") {
        child.debug(sanitizeForLog(meta) as object, sanitized);
      } else {
        child.debug(sanitized as object);
      }
    },
    info: (msg, meta) => {
      const sanitized = sanitizeForLog(msg);
      if (typeof sanitized === "string") {
        child.info(sanitizeForLog(meta) as object, sanitized);
      } else {
        child.info(sanitized as object);
      }
    },
    warn: (msg, meta) => {
      const sanitized = sanitizeForLog(msg);
      if (typeof sanitized === "string") {
        child.warn(sanitizeForLog(meta) as object, sanitized);
      } else {
        child.warn(sanitized as object);
      }
    },
    error: (msg, meta) => {
      const sanitized = sanitizeForLog(msg);
      if (typeof sanitized === "string") {
        child.error(sanitizeForLog(meta) as object, sanitized);
      } else {
        child.error(sanitized as object);
      }
    }
  };
}

function sanitizeForLog(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return value;
  if (typeof value !== "object") return value;
  const str = JSON.stringify(value);
  return JSON.parse(str, (key, val) => {
    if (typeof val === "string" && /token|secret|key|password|credential|private/i.test(key)) {
      return val ? "[REDACTED]" : val;
    }
    return val;
  });
}

export function sanitizeForLogging(value: unknown): unknown {
  return sanitizeForLog(value);
}
