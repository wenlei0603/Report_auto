#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import YAML from "yaml";

const DEFAULT_WORKSPACE_URL = "https://workspace.refinitiv.com/web/Apps/research-next/?st=OAPermID#/?st=OAPermID";

function main() {
  const [command, ...rawArgs] = process.argv.slice(2);
  const args = parseArgs(rawArgs);

  if (command === "make-run-config") {
    printJson(makeRunConfig(args));
    return;
  }
  if (command === "status") {
    printJson(readStatus(args));
    return;
  }
  if (command === "runner-pids") {
    printJson({ pids: findRunnerPids(required(args, "config-path")) });
    return;
  }

  throw new Error(`Unknown command: ${command ?? "(missing)"}`);
}

function makeRunConfig(args) {
  const controlConfigPath = args.config ?? "config/rpa-control-panel.json";
  const controlConfig = readJson(controlConfigPath);
  const portId = required(args, "port-id");
  const worker = (controlConfig.ports ?? []).find((entry) => String(entry.id) === String(portId));
  if (!worker) {
    throw new Error(`No port entry found for ${portId} in ${controlConfigPath}`);
  }

  const taskFile = normalizeSlashes(args["task-file"] ?? worker.taskFile ?? controlConfig.defaultTaskFile);
  const startTask = String(args["start-task"] ?? worker.defaultStartTask ?? "T0002").toUpperCase();
  const pageLimit = parsePositiveInt(args["page-limit"] ?? worker.dailyPageLimit ?? controlConfig.dailyPageLimit ?? 700, "page-limit");
  const stopOnPageLimit = parseBoolean(
    args["stop-on-page-limit"] ?? worker.stopOnPageLimit ?? controlConfig.stopOnPageLimit ?? true,
    "stop-on-page-limit"
  );
  const downloadDir = normalizeSlashes(worker.downloadDir ?? controlConfig.downloadDir ?? "output/downloads");
  const byTaskRoot = path.join(downloadDir, "by_task");
  const baseConfigPath = normalizeSlashes(args["base-config"] ?? controlConfig.baseConfigFile ?? "config/lseg.yaml");

  const sourceLines = readSourceLines(taskFile);
  const tasks = parseTaskRows(sourceLines);
  const fromTask = tasks.find((task) => task.taskId === startTask);
  if (!fromTask) {
    throw new Error(`Could not find ${startTask} in ${taskFile}`);
  }

  const completedFolders = scanCompletedTaskFolders(byTaskRoot);
  const selectedTasks = tasks.filter((task) => task.rowNumber >= fromTask.rowNumber && !completedFolders.nonEmpty.has(task.taskId));
  const selectedIds = new Set(selectedTasks.map((task) => task.taskId));
  const sparseLines = sourceLines.map((line, index) => (selectedIds.has(rowNumberToTaskId(index + 1)) ? line : ""));

  const runId = `gui_${todayLocal()}_p${worker.port}_from_${startTask}`;
  const queuePath = normalizeSlashes(path.join("output", "task_slices", `${runId}.txt`));
  const auditPath = normalizeSlashes(path.join("output", `${runId}.csv`));
  const runConfigPath = normalizeSlashes(path.join("output", "run_configs", `${runId}.yaml`));
  const latestConfigPath = normalizeSlashes(path.join("output", "run_configs", `gui_${worker.port}_latest.yaml`));

  ensureParent(queuePath);
  ensureParent(auditPath);
  ensureParent(runConfigPath);
  fs.writeFileSync(queuePath, `${sparseLines.join("\n")}\n`, "utf8");
  fs.writeFileSync(auditPath, buildAuditCsv(selectedTasks, byTaskRoot), "utf8");

  const baseConfig = YAML.parse(fs.readFileSync(baseConfigPath, "utf8"));
  const maxDownloadsOverride = worker.maxDownloads ?? controlConfig.maxDownloads;
  const runConfig = {
    ...baseConfig,
    input_file: queuePath,
    download_dir: downloadDir,
    mapping_csv: normalizeSlashes(path.join("output", `${runId}.task_file_mapping.csv`)),
    status_log_jsonl: normalizeSlashes(path.join("logs", `${runId}.task_status.jsonl`)),
    progress_csv: normalizeSlashes(path.join("output", `${runId}.task_progress.csv`)),
    run_log_jsonl: normalizeSlashes(path.join("logs", `${runId}.run_log.jsonl`)),
    daily_page_limit: pageLimit,
    cdp_endpoint: `http://127.0.0.1:${worker.port}`,
    browser: {
      ...baseConfig.browser,
      headless: false,
      user_data_dir: worker.profile
    },
    behavior: {
      ...baseConfig.behavior,
      debug_max_tasks: 0,
      stop_on_page_limit: stopOnPageLimit
    }
  };
  if (maxDownloadsOverride !== undefined) {
    runConfig.max_downloads = Number(maxDownloadsOverride);
  }
  fs.writeFileSync(runConfigPath, YAML.stringify(runConfig), "utf8");
  fs.writeFileSync(latestConfigPath, YAML.stringify(runConfig), "utf8");

  return {
    runId,
    portId: String(worker.id),
    port: worker.port,
    profile: worker.profile,
    startTask,
    taskFile,
    pageLimit,
    stopOnPageLimit,
    completedNonEmptyFolders: completedFolders.nonEmpty.size,
    emptyTaskFolders: completedFolders.empty.length,
    selectedTasks: selectedTasks.length,
    firstSelectedTask: selectedTasks[0]?.taskId ?? null,
    lastSelectedTask: selectedTasks.at(-1)?.taskId ?? null,
    queuePath,
    auditPath,
    configPath: runConfigPath,
    latestConfigPath,
    statusLog: runConfig.status_log_jsonl,
    runLog: runConfig.run_log_jsonl,
    progressCsv: runConfig.progress_csv,
    mappingCsv: runConfig.mapping_csv,
    stdoutLog: normalizeSlashes(path.join("logs", `${runId}.stdout.log`)),
    stderrLog: normalizeSlashes(path.join("logs", `${runId}.stderr.log`)),
    sampleTasks: selectedTasks.slice(0, 10).map((task) => ({ taskId: task.taskId, company: task.company, ticker: task.ticker }))
  };
}

function readStatus(args) {
  const configPath = args["config-path"] ?? "";
  let runConfig = {};
  if (configPath && fs.existsSync(configPath)) {
    runConfig = YAML.parse(fs.readFileSync(configPath, "utf8"));
  }

  const statusLog = args["status-log"] ?? runConfig.status_log_jsonl;
  const runLog = args["run-log"] ?? runConfig.run_log_jsonl;
  const downloadDir = args["download-dir"] ?? runConfig.download_dir ?? "output/downloads";
  const dailyLimit = Number(runConfig.daily_page_limit ?? args["page-limit"] ?? 700);
  const statusRecords = readJsonl(statusLog);
  const runRecords = readJsonl(runLog);
  const latestByTask = latestRecordByTask(statusRecords);
  const statusCounts = {};
  for (const record of latestByTask.values()) {
    statusCounts[record.status] = (statusCounts[record.status] ?? 0) + 1;
  }
  const accountedPages = dailyPageUsage(statusRecords);
  const lastStart = [...runRecords].reverse().find((record) => record.message === "Starting task");
  const lastRun = runRecords.at(-1) ?? null;
  const warningsOrErrors = runRecords
    .filter((record) => record.level === "WARN" || record.level === "ERROR")
    .slice(-12)
    .map((record) => pick(record, ["ts", "level", "message", "taskId", "status", "reason", "error"]));

  return {
    configPath: configPath || null,
    activeRunnerPids: configPath ? findRunnerPids(configPath) : [],
    statusLog: statusLog ?? null,
    runLog: runLog ?? null,
    latestTaskCount: latestByTask.size,
    latestStatusCounts: statusCounts,
    accountedPages,
    remainingPages: Math.max(0, dailyLimit - accountedPages),
    currentOrLastStarted: lastStart
      ? pick(lastStart, ["ts", "taskId", "company", "ticker", "remainingPages"])
      : null,
    lastRun: lastRun ? pick(lastRun, ["ts", "level", "message", "taskId", "status", "reason", "error"]) : null,
    lastRunAgeSeconds: lastRun?.ts ? Math.round((Date.now() - Date.parse(lastRun.ts)) / 1000) : null,
    recentStatus: statusRecords
      .slice(-18)
      .map((record) => pick(record, ["ts", "taskId", "company", "status", "pages", "dailyTotalPages", "note"])),
    warningsOrErrors,
    latestTaskFolders: latestTaskFolders(path.join(downloadDir, "by_task"), 12)
  };
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    const next = rawArgs[index + 1];
    if (next === undefined || next.startsWith("--")) {
      parsed[key] = "true";
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function required(args, key) {
  const value = args[key];
  if (value === undefined || value === "") {
    throw new Error(`Missing required --${key}`);
  }
  return value;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readSourceLines(taskFile) {
  const text = fs.readFileSync(taskFile, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
}

function parseTaskRows(lines) {
  const tasks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const rowNumber = index + 1;
    const parts = line.split("\t").map((part) => part.trim());
    if (rowNumber === 1 || parts.length < 6) {
      continue;
    }
    tasks.push({
      taskId: rowNumberToTaskId(rowNumber),
      rowNumber,
      company: parts[1] ?? "",
      ticker: parts[2] ?? "",
      rawLine: line
    });
  }
  return tasks;
}

function scanCompletedTaskFolders(byTaskRoot) {
  const nonEmpty = new Map();
  const empty = [];
  if (!fs.existsSync(byTaskRoot)) {
    return { nonEmpty, empty };
  }
  for (const entry of fs.readdirSync(byTaskRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const taskId = /^T\d{4}(?=$|[^A-Za-z0-9])/i.exec(entry.name)?.[0]?.toUpperCase();
    if (!taskId) {
      continue;
    }
    const entryCount = fs.readdirSync(path.join(byTaskRoot, entry.name)).length;
    if (entryCount > 0) {
      nonEmpty.set(taskId, { folderName: entry.name, entryCount });
    } else {
      empty.push({ taskId, folderName: entry.name });
    }
  }
  return { nonEmpty, empty };
}

function buildAuditCsv(tasks, byTaskRoot) {
  const header = ["task_id", "row_number", "company", "ticker", "basis", "output_task_folder"];
  const rows = tasks.map((task) => [
    task.taskId,
    task.rowNumber,
    task.company,
    task.ticker,
    "no_non_empty_task_folder_under_output_downloads_by_task",
    normalizeSlashes(path.join(byTaskRoot, task.taskId))
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

function latestRecordByTask(records) {
  const latest = new Map();
  for (const record of records) {
    latest.set(record.taskId, record);
  }
  return latest;
}

function dailyPageUsage(records) {
  let total = 0;
  const pendingSubmissionPagesByTask = new Map();
  for (const record of records) {
    if (record.status !== "download_started" && record.status !== "downloaded") {
      continue;
    }
    const pages = Math.max(0, Number(record.pages) || 0);
    if (record.status === "download_started") {
      const pendingPages = pendingSubmissionPagesByTask.get(record.taskId);
      if (pendingPages !== undefined) {
        total += pendingPages;
      }
      pendingSubmissionPagesByTask.set(record.taskId, pages);
      continue;
    }

    const pendingPages = pendingSubmissionPagesByTask.get(record.taskId);
    if (pendingPages === undefined) {
      total += pages;
      continue;
    }
    total += Math.max(pages, pendingPages);
    pendingSubmissionPagesByTask.delete(record.taskId);
  }
  for (const pages of pendingSubmissionPagesByTask.values()) {
    total += pages;
  }
  return total;
}

function latestTaskFolders(byTaskRoot, limit) {
  if (!fs.existsSync(byTaskRoot)) {
    return { nonEmpty: 0, empty: 0, newest: [] };
  }
  let nonEmpty = 0;
  let empty = 0;
  const newest = [];
  for (const entry of fs.readdirSync(byTaskRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(byTaskRoot, entry.name);
    const entries = fs.readdirSync(dir);
    if (entries.length > 0) {
      nonEmpty += 1;
    } else {
      empty += 1;
    }
    let newestMtime = 0;
    let fileCount = 0;
    let bytes = 0;
    for (const child of entries) {
      const childPath = path.join(dir, child);
      const stat = fs.statSync(childPath);
      if (stat.isFile()) {
        fileCount += 1;
        bytes += stat.size;
        newestMtime = Math.max(newestMtime, stat.mtimeMs);
      }
    }
    if (newestMtime > 0) {
      newest.push({ taskId: entry.name, fileCount, bytes, newest: new Date(newestMtime).toISOString() });
    }
  }
  newest.sort((a, b) => b.newest.localeCompare(a.newest));
  return { nonEmpty, empty, newest: newest.slice(0, limit) };
}

function findRunnerPids(configPath) {
  const escaped = configPath.replace(/\\/g, "\\\\").replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$pattern = '${escaped}'`,
    "Get-CimInstance Win32_Process |",
    "  Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like \"*$pattern*\" -and $_.CommandLine -match 'dist/src/cli\\.js' } |",
    "  Select-Object -ExpandProperty ProcessId"
  ].join("\n");
  try {
    return execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((value) => Number(value))
      .filter(Number.isInteger);
  } catch {
    return [];
  }
}

function pick(object, keys) {
  const result = {};
  for (const key of keys) {
    if (object[key] !== undefined) {
      result[key] = object[key];
    }
  }
  return result;
}

function rowNumberToTaskId(rowNumber) {
  return `T${String(rowNumber).padStart(4, "0")}`;
}

function parsePositiveInt(value, label) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer for ${label}, got ${value}`);
  }
  return parsed;
}

function parseBoolean(value, label) {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  throw new Error(`Expected boolean for ${label}, got ${value}`);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function todayLocal() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("");
}

function normalizeSlashes(filePath) {
  return String(filePath).replace(/\\/g, "/");
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
