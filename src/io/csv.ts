import { mkdir, readFile, stat, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

export async function ensureCsvHeader(filePath: string, headers: string[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    const info = await stat(filePath);
    if (info.size > 0) {
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await writeFile(filePath, `${headers.map(escapeCsvCell).join(",")}\n`, "utf8");
}

export async function appendCsvRow(filePath: string, row: Array<string | number | boolean | null | undefined>): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${row.map((value) => escapeCsvCell(value ?? "")).join(",")}\n`, "utf8");
}

export async function readCsvLines(filePath: string): Promise<string[]> {
  try {
    const text = await readFile(filePath, "utf8");
    return text.split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function escapeCsvCell(value: string | number | boolean): string {
  const text = String(value);
  if (!/[",\r\n]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}
