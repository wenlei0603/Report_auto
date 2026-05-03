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
  for (const line of lines) {
    rowNumber += 1;
    const rawLine = line.trim();
    if (!rawLine || rawLine.startsWith("#")) {
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

function parseTsvTask(rawLine: string, rowNumber: number): RequestTask | null {
  const parts = rawLine.split("\t").map((part) => part.trim());
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
