/**
 * Structured JSON logger.
 * Every log line is a single JSON object written to stdout.
 * Downstream log aggregators can parse these by timestamp, level, and event.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

export function log(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...data,
    }),
  );
}

export const logger = {
  debug: (event: string, data?: Record<string, unknown>) => log("debug", event, data ?? {}),
  info: (event: string, data?: Record<string, unknown>) => log("info", event, data ?? {}),
  warn: (event: string, data?: Record<string, unknown>) => log("warn", event, data ?? {}),
  error: (event: string, data?: Record<string, unknown>) => log("error", event, data ?? {}),
};
