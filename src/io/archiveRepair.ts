import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { timestampIso } from "../domain/dates.js";
import { expectedNativePdfCount, selectNativePdfCandidatesForRows, selectedRowPages } from "../browser/download.js";
import type { DownloadRowSelection } from "../browser/download.js";
import type { FinalTaskStatus } from "../domain/types.js";
import { sanitizeFilename } from "../utils/filename.js";
import { resolveProjectPath } from "../utils/paths.js";
import { appendCsvRow, ensureCsvHeader } from "./csv.js";
import { readJsonl } from "./jsonl.js";

const ARCHIVE_REPAIR_HEADERS = [
  "task_id",
  "status",
  "expected",
  "matched_count",
  "selected_pages",
  "existing_pdf_count",
  "missing_matched_count",
  "extra_existing_count",
  "matched_files",
  "missing_matched_files",
  "extra_existing_files"
];

const SUBMITTED_STATUSES = new Set<FinalTaskStatus>(["download_started", "downloaded"]);

export type ArchiveRepairTaskStatus =
  | "already_clean"
  | "needs_copy"
  | "existing_polluted"
  | "partial_raw_match"
  | "no_raw_match";

export interface ArchiveRepairOptions {
  runLogPaths: string[];
  statusLogPaths: string[];
  rawDownloadsDir: string;
  existingArchiveRoot: string;
  includeUnsubmitted?: boolean;
}

export interface ArchiveRepairPlan {
  generatedAt: string;
  runLogPaths: string[];
  statusLogPaths: string[];
  rawDownloadsDir: string;
  existingArchiveRoot: string;
  rawPdfCount: number;
  submittedTaskCount: number;
  rowSelectionTaskCount: number;
  tasks: ArchiveRepairTaskPlan[];
}

export interface ArchiveRepairTaskPlan {
  taskId: string;
  status: ArchiveRepairTaskStatus;
  expected: number;
  selectedPages: number;
  matchedCount: number;
  existingPdfCount: number;
  missingMatchedCount: number;
  extraExistingCount: number;
  matchedPaths: string[];
  existingPdfPaths: string[];
  missingMatchedPaths: string[];
  extraExistingPaths: string[];
  rowSelection: DownloadRowSelection;
}

export interface ArchiveRepairApplyResult {
  targetRoot: string;
  copied: number;
  skippedExisting: number;
  copiedPaths: string[];
  skippedExistingPaths: string[];
}

export interface ArchiveRepairReportFiles {
  csvPath: string;
  jsonPath: string;
}

interface PdfCandidate {
  path: string;
  mtimeMs: number;
}

interface RunLogRecord extends Partial<DownloadRowSelection> {
  message?: string;
  taskId?: string;
}

interface StatusLogRecord {
  taskId?: string;
  status?: FinalTaskStatus;
}

export async function buildArchiveRepairPlan(options: ArchiveRepairOptions): Promise<ArchiveRepairPlan> {
  const runLogPaths = options.runLogPaths.map((file) => path.resolve(file));
  const statusLogPaths = options.statusLogPaths.map((file) => path.resolve(file));
  const rawDownloadsDir = path.resolve(options.rawDownloadsDir);
  const existingArchiveRoot = path.resolve(options.existingArchiveRoot);
  const rawCandidates = await listPdfCandidates(rawDownloadsDir);
  const rowSelections = await readRowSelections(runLogPaths);
  const submittedStatus = await readSubmittedTaskIds(statusLogPaths);
  const shouldFilterBySubmission = !options.includeUnsubmitted && submittedStatus.recordsSeen > 0;
  const tasks: ArchiveRepairTaskPlan[] = [];

  for (const [taskId, rowSelection] of [...rowSelections.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (shouldFilterBySubmission && !submittedStatus.taskIds.has(taskId)) {
      continue;
    }
    if ((rowSelection.selectedRows ?? []).length === 0) {
      continue;
    }

    const expected = expectedNativePdfCount(rowSelection);
    const matched = selectNativePdfCandidatesForRows(rawCandidates, rowSelection, expected);
    const existingPdfPaths = (await listPdfCandidates(path.resolve(existingArchiveRoot, taskId))).map((file) => file.path);
    const matchedKeys = new Set(matched.map((file) => archiveFileKey(file.path)));
    const existingKeys = new Set(existingPdfPaths.map(archiveFileKey));
    const missingMatchedPaths = matched.filter((file) => !existingKeys.has(archiveFileKey(file.path))).map((file) => file.path);
    const extraExistingPaths = existingPdfPaths.filter((file) => !matchedKeys.has(archiveFileKey(file)));

    tasks.push({
      taskId,
      status: classifyTaskRepairStatus({
        expected,
        matchedCount: matched.length,
        missingMatchedCount: missingMatchedPaths.length,
        extraExistingCount: extraExistingPaths.length
      }),
      expected,
      selectedPages: selectedRowPages(rowSelection),
      matchedCount: matched.length,
      existingPdfCount: existingPdfPaths.length,
      missingMatchedCount: missingMatchedPaths.length,
      extraExistingCount: extraExistingPaths.length,
      matchedPaths: matched.map((file) => file.path),
      existingPdfPaths,
      missingMatchedPaths,
      extraExistingPaths,
      rowSelection
    });
  }

  return {
    generatedAt: timestampIso(),
    runLogPaths,
    statusLogPaths,
    rawDownloadsDir,
    existingArchiveRoot,
    rawPdfCount: rawCandidates.length,
    submittedTaskCount: submittedStatus.taskIds.size,
    rowSelectionTaskCount: rowSelections.size,
    tasks
  };
}

export async function applyArchiveRepairPlan(plan: ArchiveRepairPlan, targetRoot: string): Promise<ArchiveRepairApplyResult> {
  const resolvedTargetRoot = path.resolve(targetRoot);
  const result: ArchiveRepairApplyResult = {
    targetRoot: resolvedTargetRoot,
    copied: 0,
    skippedExisting: 0,
    copiedPaths: [],
    skippedExistingPaths: []
  };

  for (const task of plan.tasks) {
    for (const sourcePath of task.matchedPaths) {
      const taskDir = path.resolve(resolvedTargetRoot, task.taskId);
      await mkdir(taskDir, { recursive: true });
      const targetName = normalizedPdfName(path.basename(sourcePath));
      const targetPath = path.resolve(taskDir, targetName);
      if (await sameSizedFileExists(sourcePath, targetPath)) {
        result.skippedExisting += 1;
        result.skippedExistingPaths.push(targetPath);
        continue;
      }
      const finalPath = await uniquePath(targetPath);
      await copyFile(sourcePath, finalPath);
      result.copied += 1;
      result.copiedPaths.push(finalPath);
    }
  }

  return result;
}

export async function writeArchiveRepairReports(plan: ArchiveRepairPlan, reportDir: string): Promise<ArchiveRepairReportFiles> {
  const resolvedReportDir = path.resolve(reportDir);
  await mkdir(resolvedReportDir, { recursive: true });
  const stem = `archive_repair_${fileTimestamp(plan.generatedAt)}`;
  const csvPath = path.resolve(resolvedReportDir, `${stem}.csv`);
  const jsonPath = path.resolve(resolvedReportDir, `${stem}.json`);

  await ensureCsvHeader(csvPath, ARCHIVE_REPAIR_HEADERS);
  for (const task of plan.tasks) {
    await appendCsvRow(csvPath, [
      task.taskId,
      task.status,
      task.expected,
      task.matchedCount,
      task.selectedPages,
      task.existingPdfCount,
      task.missingMatchedCount,
      task.extraExistingCount,
      task.matchedPaths.join("; "),
      task.missingMatchedPaths.join("; "),
      task.extraExistingPaths.join("; ")
    ]);
  }
  await writeFile(jsonPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return { csvPath, jsonPath };
}

export async function expandPathPatterns(patterns: string[], cwd = process.cwd()): Promise<string[]> {
  const expanded: string[] = [];
  for (const pattern of patterns) {
    const resolvedPattern = resolveProjectPath(pattern, cwd);
    if (!/[*?]/.test(resolvedPattern)) {
      expanded.push(resolvedPattern);
      continue;
    }

    const directory = path.dirname(resolvedPattern);
    const basenamePattern = path.basename(resolvedPattern);
    const matcher = wildcardToRegExp(basenamePattern);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && matcher.test(entry.name)) {
        expanded.push(path.resolve(directory, entry.name));
      }
    }
  }
  return [...new Set(expanded)].sort((a, b) => a.localeCompare(b));
}

export function splitPathList(value: string | undefined): string[] {
  return String(value ?? "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function summarizeArchiveRepairPlan(plan: ArchiveRepairPlan): Record<ArchiveRepairTaskStatus, number> {
  const summary: Record<ArchiveRepairTaskStatus, number> = {
    already_clean: 0,
    needs_copy: 0,
    existing_polluted: 0,
    partial_raw_match: 0,
    no_raw_match: 0
  };
  for (const task of plan.tasks) {
    summary[task.status] += 1;
  }
  return summary;
}

async function readRowSelections(runLogPaths: string[]): Promise<Map<string, DownloadRowSelection>> {
  const rows = new Map<string, DownloadRowSelection>();
  for (const filePath of runLogPaths) {
    const records = await readJsonl<RunLogRecord>(filePath);
    for (const record of records) {
      if (record.message !== "Download row selection" || !record.taskId || !Array.isArray(record.selectedRows)) {
        continue;
      }
      rows.set(record.taskId, {
        inspectableRows: Number(record.inspectableRows ?? 0),
        requested: Number(record.requested ?? 0),
        selected: Number(record.selected ?? 0),
        tickerMatched: Number(record.tickerMatched ?? 0),
        tickerMismatch: Number(record.tickerMismatch ?? 0),
        selectedRows: record.selectedRows,
        rejectedRows: Array.isArray(record.rejectedRows) ? record.rejectedRows : []
      });
    }
  }
  return rows;
}

async function readSubmittedTaskIds(statusLogPaths: string[]): Promise<{ taskIds: Set<string>; recordsSeen: number }> {
  const submitted = new Set<string>();
  let recordsSeen = 0;
  for (const filePath of statusLogPaths) {
    const records = await readJsonl<StatusLogRecord>(filePath);
    recordsSeen += records.length;
    for (const record of records) {
      if (record.taskId && record.status && SUBMITTED_STATUSES.has(record.status)) {
        submitted.add(record.taskId);
      }
    }
  }
  return { taskIds: submitted, recordsSeen };
}

async function listPdfCandidates(directory: string): Promise<PdfCandidate[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: PdfCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".pdf")) {
      continue;
    }
    const filePath = path.resolve(directory, entry.name);
    const info = await stat(filePath).catch(() => null);
    if (info?.isFile()) {
      files.push({ path: filePath, mtimeMs: info.mtimeMs });
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
}

function classifyTaskRepairStatus(input: {
  expected: number;
  matchedCount: number;
  missingMatchedCount: number;
  extraExistingCount: number;
}): ArchiveRepairTaskStatus {
  if (input.matchedCount === 0) {
    return "no_raw_match";
  }
  if (input.matchedCount < input.expected) {
    return "partial_raw_match";
  }
  if (input.extraExistingCount > 0) {
    return "existing_polluted";
  }
  if (input.missingMatchedCount > 0) {
    return "needs_copy";
  }
  return "already_clean";
}

function archiveFileKey(filePath: string): string {
  return normalizedPdfName(path.basename(filePath)).toLowerCase();
}

function normalizedPdfName(fileName: string): string {
  const clean = sanitizeFilename(fileName, 180);
  return clean.toLowerCase().endsWith(".pdf") ? clean : `${clean}.pdf`;
}

async function sameSizedFileExists(sourcePath: string, targetPath: string): Promise<boolean> {
  const [sourceInfo, targetInfo] = await Promise.all([stat(sourcePath).catch(() => null), stat(targetPath).catch(() => null)]);
  return Boolean(sourceInfo?.isFile() && targetInfo?.isFile() && sourceInfo.size === targetInfo.size);
}

async function uniquePath(filePath: string): Promise<string> {
  try {
    await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return filePath;
    }
    throw error;
  }

  const parsed = path.parse(filePath);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.resolve(parsed.dir, `${parsed.name} (${i})${parsed.ext}`);
    try {
      await stat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return candidate;
      }
      throw error;
    }
  }
  throw new Error(`Could not allocate unique path for ${filePath}`);
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("")
    .map((char) => {
      if (char === "*") {
        return ".*";
      }
      if (char === "?") {
        return ".";
      }
      return char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${escaped}$`, "i");
}

function fileTimestamp(value: string): string {
  return value.replace(/[-:.]/g, "").replace("T", "_").replace(/Z$/, "Z");
}
