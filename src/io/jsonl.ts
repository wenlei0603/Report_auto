import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export async function appendJsonl(filePath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const fs = await import("node:fs/promises");
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

export async function readJsonl<T>(filePath: string): Promise<T[]> {
  let text = "";
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
