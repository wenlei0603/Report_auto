import { readFile } from "node:fs/promises";
import { orderIsoDates, parseDateToIso } from "./dates.js";
import type { RequestTask } from "./types.js";

const DATE_PATTERN =
  /(20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]20\d{2}|\d{1,2}-[A-Za-z]{3}-20\d{2}(?:\s+\d{2}:\d{2})?)/g;

export async function loadTasks(inputFile: string): Promise<RequestTask[]> {
  const text = await readFile(inputFile, "utf8");
  return parseTasks(text.split(/\r?\n/));
}

export function parseTasks(lines: Iterable<string>): RequestTask[] {
  const tasks: RequestTask[] = [];
  let rowNumber = 0;
  let explicitHeader: Map<string, number> | null = null;
  for (const line of lines) {
    rowNumber += 1;
    const rawLine = line.trim();
    if (!rawLine || rawLine.startsWith("#")) {
      continue;
    }

    const parts = splitTsv(rawLine);
    const header = parseExplicitTaskHeader(parts);
    if (header) {
      explicitHeader = header;
      continue;
    }

    if (explicitHeader) {
      const explicitTask = parseExplicitTask(rawLine, rowNumber, explicitHeader);
      if (explicitTask) {
        tasks.push(explicitTask);
      }
      continue;
    }

    const tsvTask = parseTsvTask(rawLine, rowNumber);
    if (tsvTask) {
      tasks.push(tsvTask);
      continue;
    }

    const fallback = parseFallbackTask(rawLine, rowNumber);
    if (fallback) {
      tasks.push(fallback);
    }
  }
  return tasks;
}

function splitTsv(rawLine: string): string[] {
  return rawLine.split("\t").map((part) => part.trim());
}

function parseExplicitTaskHeader(parts: string[]): Map<string, number> | null {
  const normalized = parts.map(normalizeHeader);
  if (!normalized.includes("task_id")) {
    return null;
  }
  const header = new Map<string, number>();
  for (const [index, name] of normalized.entries()) {
    if (name) {
      header.set(name, index);
    }
  }
  return header;
}

function parseExplicitTask(rawLine: string, physicalRowNumber: number, header: Map<string, number>): RequestTask | null {
  const parts = splitTsv(rawLine);
  const taskId = normalizeTaskId(readField(parts, header, "task_id"));
  if (!taskId) {
    return null;
  }

  try {
    const rowNumber = parseRowNumber(readField(parts, header, "row_number"), taskId) ?? physicalRowNumber;
    const dateFrom = parseDateToIso(readAnyField(parts, header, ["date_from", "from_date", "from"]));
    const dateTo = parseDateToIso(readAnyField(parts, header, ["date_to", "to_date", "to"]));
    const ccDateRaw = readAnyField(parts, header, ["cc_date", "call_date"]);
    const ccDate = ccDateRaw ? parseDateToIso(ccDateRaw) : dateFrom;
    return {
      taskId,
      rowNumber,
      permno: readField(parts, header, "permno"),
      company: readAnyField(parts, header, ["company", "company_name"]) || `UNKNOWN_${rowNumber}`,
      ticker: readField(parts, header, "ticker"),
      ccDate,
      dateFrom,
      dateTo,
      rawLine
    };
  } catch {
    return null;
  }
}

function readAnyField(parts: string[], header: Map<string, number>, names: string[]): string {
  for (const name of names) {
    const value = readField(parts, header, name);
    if (value) {
      return value;
    }
  }
  return "";
}

function readField(parts: string[], header: Map<string, number>, name: string): string {
  const index = header.get(name);
  return index === undefined ? "" : (parts[index] ?? "").trim();
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizeTaskId(value: string): string {
  const normalized = value.trim().toUpperCase();
  return /^T\d{4,}$/.test(normalized) ? normalized : "";
}

function parseRowNumber(value: string, taskId: string): number | null {
  const parsed = Number.parseInt(value, 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  const taskNumber = Number.parseInt(taskId.slice(1), 10);
  return Number.isInteger(taskNumber) && taskNumber > 0 ? taskNumber : null;
}

function parseTsvTask(rawLine: string, rowNumber: number): RequestTask | null {
  const parts = splitTsv(rawLine);
  if (parts.length < 6) {
    return null;
  }

  try {
    const ccDate = parseDateToIso(parts[3] ?? "");
    const [dateFrom, dateTo] = orderIsoDates(parseDateToIso(parts[4] ?? ""), parseDateToIso(parts[5] ?? ""));
    return {
      taskId: `T${String(rowNumber).padStart(4, "0")}`,
      rowNumber,
      permno: parts[0] ?? "",
      company: parts[1] || `UNKNOWN_${rowNumber}`,
      ticker: parts[2] ?? "",
      ccDate,
      dateFrom,
      dateTo,
      rawLine
    };
  } catch {
    return null;
  }
}

function parseFallbackTask(rawLine: string, rowNumber: number): RequestTask | null {
  const matches = [...rawLine.matchAll(DATE_PATTERN)];
  if (matches.length < 2) {
    return null;
  }
  const first = matches[0]!;
  const second = matches[1]!;
  const [dateFrom, dateTo] = orderIsoDates(parseDateToIso(first[1]!), parseDateToIso(second[1]!));
  const company = rawLine.slice(0, first.index).trim().replace(/[,\t|;:-]+$/g, "") || `UNKNOWN_${rowNumber}`;
  return {
    taskId: `T${String(rowNumber).padStart(4, "0")}`,
    rowNumber,
    permno: "",
    company,
    ticker: "",
    ccDate: dateFrom,
    dateFrom,
    dateTo,
    rawLine
  };
}
