
export interface Logger {
  debug: (msg: string | object, meta?: object) => void;
  info: (msg: string | object, meta?: object) => void;
  warn: (msg: string | object, meta?: object) => void;
  error: (msg: string | object, meta?: object) => void;
}

const noop = () => {};

export function getLogger(name: string): Logger {
  const level = (process.env.LOG_LEVEL || "info").toLowerCase();
  const levels: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const current = levels[level] ?? 1;
  const prefix = `[${name}]`;
  const log = (levelLabel: string, msg: string | object, meta?: object) => {
    const safeMeta = meta ? sanitizeForLog(meta) : undefined;
    if (typeof msg === "string") {
      safeMeta ? console.log(prefix, levelLabel, msg, safeMeta) : console.log(prefix, levelLabel, msg);
    } else {
      console.log(prefix, levelLabel, sanitizeForLog(msg), safeMeta);
    }
  };
  return {
    debug: current <= 0 ? (msg, meta) => log("DEBUG", msg, meta) : noop,
    info: current <= 1 ? (msg, meta) => log("INFO", msg, meta) : noop,
    warn: current <= 2 ? (msg, meta) => log("WARN", msg, meta) : noop,
    error: current <= 3 ? (msg, meta) => log("ERROR", msg, meta) : noop
  };
}

function sanitizeForLog(value: object): object {
  const str = JSON.stringify(value);
  return JSON.parse(str, (key, val) => {
    if (typeof val === "string" && /token|secret|key|password|credential|private/i.test(key)) {
      return val ? "[REDACTED]" : val;
    }
    return val;
  });
}

export function sanitizeForLogging(value: unknown): unknown {
  return sanitizeForLog(value as object);
}
