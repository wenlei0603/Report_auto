import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadTasks } from "../domain/tasks.js";
import type { RequestTask } from "../domain/types.js";

export interface BuildUnfinishedQueueInput {
  taskFile: string;
  byTaskRoot: string;
  outputFile: string;
  auditFile?: string;
  fromTask?: string;
}

export interface CompletedTaskFolder {
  taskId: string;
  folderName: string;
  entryCount: number;
}

export interface UnfinishedQueueSummary {
  taskFile: string;
  byTaskRoot: string;
  outputFile: string;
  auditFile: string | null;
  totalSourceTasks: number;
  completedNonEmptyFolders: number;
  emptyTaskFolders: number;
  selectedTasks: number;
  firstSelectedTask: string | null;
  lastSelectedTask: string | null;
  fromTask: string | null;
}

export async function buildUnfinishedQueue(input: BuildUnfinishedQueueInput): Promise<UnfinishedQueueSummary> {
  const tasks = await loadTasks(input.taskFile);
  const folders = await scanTaskFolders(input.byTaskRoot);
  const fromTask = input.fromTask ? normalizeTaskId(input.fromTask) : null;
  const firstRowNumber = fromTask ? findRequiredTask(tasks, fromTask).rowNumber : 1;
  const selectedTasks = tasks.filter((task) => task.rowNumber >= firstRowNumber && !folders.nonEmpty.has(task.taskId));

  await writeTextFile(input.outputFile, buildExplicitTaskTsv(selectedTasks));
  if (input.auditFile) {
    await writeTextFile(input.auditFile, buildAuditCsv(selectedTasks, input.byTaskRoot));
  }

  return {
    taskFile: input.taskFile,
    byTaskRoot: input.byTaskRoot,
    outputFile: input.outputFile,
    auditFile: input.auditFile ?? null,
    totalSourceTasks: tasks.length,
    completedNonEmptyFolders: folders.nonEmpty.size,
    emptyTaskFolders: folders.empty.length,
    selectedTasks: selectedTasks.length,
    firstSelectedTask: selectedTasks[0]?.taskId ?? null,
    lastSelectedTask: selectedTasks.at(-1)?.taskId ?? null,
    fromTask
  };
}

async function scanTaskFolders(byTaskRoot: string): Promise<{ nonEmpty: Map<string, CompletedTaskFolder>; empty: CompletedTaskFolder[] }> {
  const nonEmpty = new Map<string, CompletedTaskFolder>();
  const empty: CompletedTaskFolder[] = [];
  let entries;
  try {
    entries = await readdir(byTaskRoot, { withFileTypes: true });
  } catch {
    return { nonEmpty, empty };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const taskId = /^T\d{4,}(?=$|[^A-Za-z0-9])/i.exec(entry.name)?.[0]?.toUpperCase();
    if (!taskId) {
      continue;
    }
    const children = await readdir(path.join(byTaskRoot, entry.name)).catch(() => []);
    const folder = { taskId, folderName: entry.name, entryCount: children.length };
    if (children.length > 0) {
      nonEmpty.set(taskId, folder);
    } else {
      empty.push(folder);
    }
  }
  return { nonEmpty, empty };
}

function findRequiredTask(tasks: RequestTask[], taskId: string): RequestTask {
  const task = tasks.find((candidate) => candidate.taskId === taskId);
  if (!task) {
    throw new Error(`Could not find ${taskId} in source task file`);
  }
  return task;
}

function buildExplicitTaskTsv(tasks: RequestTask[]): string {
  const header = ["task_id", "row_number", "permno", "company", "ticker", "cc_date", "date_from", "date_to"];
  const rows = tasks.map((task) => [
    task.taskId,
    String(task.rowNumber),
    task.permno,
    task.company,
    task.ticker,
    task.ccDate,
    task.dateFrom,
    task.dateTo
  ]);
  return [header, ...rows].map((row) => row.map(tsvCell).join("\t")).join("\n") + "\n";
}

function buildAuditCsv(tasks: RequestTask[], byTaskRoot: string): string {
  const header = ["task_id", "row_number", "company", "ticker", "basis", "output_task_folder"];
  const rows = tasks.map((task) => [
    task.taskId,
    String(task.rowNumber),
    task.company,
    task.ticker,
    "no_non_empty_task_folder_under_output_downloads_by_task",
    normalizeSlashes(path.join(byTaskRoot, task.taskId))
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

async function writeTextFile(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

function normalizeTaskId(value: string): string {
  const taskId = value.trim().toUpperCase();
  if (!/^T\d{4,}$/.test(taskId)) {
    throw new Error(`Expected task id like T0001, got ${value}`);
  }
  return taskId;
}

function tsvCell(value: string): string {
  return String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();
}

function csvCell(value: string): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function normalizeSlashes(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
