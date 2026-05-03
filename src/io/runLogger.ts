import { appendJsonl } from "./jsonl.js";
import { timestampIso } from "../domain/dates.js";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export class RunLogger {
  constructor(private readonly filePath: string) {}

  async event(level: LogLevel, message: string, extra: Record<string, unknown> = {}): Promise<void> {
    const payload = {
      ts: timestampIso(),
      level,
      message,
      ...extra
    };
    await appendJsonl(this.filePath, payload);
    process.stdout.write(`[${payload.ts}] ${level.padEnd(5)} ${message}\n`);
  }
}
