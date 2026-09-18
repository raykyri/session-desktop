// Structured logging. One JSON object per line on stdout, which is what Fly's
// log shipper reads (`13-deployment-fly.md` §7).
//
// A dependency-free logger rather than pino: the server emits a handful of
// event shapes, all of them serializable, and a 60-line writer keeps the
// field names under this package's control.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  level: LogLevel;
  child(bindings: Record<string, unknown>): Logger;
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  bindings?: Record<string, unknown>;
  /** Overridden by tests, which collect lines instead of writing them. */
  write?: (line: string) => void;
}

/** Errors do not survive `JSON.stringify`; everything else is passed through. */
function serializable(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const bindings = options.bindings ?? {};
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emit = (logLevel: LogLevel, fields: Record<string, unknown>, message: string): void => {
    if (LEVEL_RANK[logLevel] < LEVEL_RANK[level]) {
      return;
    }
    const record: Record<string, unknown> = {
      level: logLevel,
      time: new Date().toISOString(),
      message,
      ...bindings,
    };
    for (const [key, value] of Object.entries(fields)) {
      record[key] = serializable(value);
    }
    write(JSON.stringify(record));
  };
  return {
    level,
    child: (extra) =>
      createLogger({
        level,
        bindings: { ...bindings, ...extra },
        ...(options.write ? { write: options.write } : {}),
      }),
    debug: (fields, message) => emit("debug", fields, message),
    info: (fields, message) => emit("info", fields, message),
    warn: (fields, message) => emit("warn", fields, message),
    error: (fields, message) => emit("error", fields, message),
  };
}

/** Silent by default in tests so a suite's output stays readable. */
export function defaultLogger(env: string): Logger {
  if (env === "test") {
    return createLogger({ level: "error", write: () => undefined });
  }
  return createLogger({ level: env === "production" ? "info" : "debug" });
}
