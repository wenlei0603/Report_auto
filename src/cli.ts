#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { inspectCurrentBrowser, runAutomation } from "./automation/engine.js";
import {
  applyArchiveRepairPlan,
  buildArchiveRepairPlan,
  expandPathPatterns,
  splitPathList,
  summarizeArchiveRepairPlan,
  writeArchiveRepairReports
} from "./io/archiveRepair.js";
import { buildUnfinishedQueue } from "./io/unfinishedQueue.js";
import { resolveProjectPath } from "./utils/paths.js";

const program = new Command();

program
  .name("lseg-rn")
  .description("LSEG Research Next full automation runner")
  .option("-c, --config <path>", "config file", "config/lseg.yaml");

program
  .command("run")
  .description("Run the full automation loop against a manually logged-in browser")
  .option("--dry-run", "parse and print pending tasks without browser actions", false)
  .option("--max-tasks <count>", "maximum tasks to process", parsePositiveInt)
  .option("--max-downloads <count>", "maximum successful downloads", parseNonNegativeInt)
  .option("--start-from-task <taskId>", "start from a specific task id, for example T0100")
  .option("--tasks-file <path>", "run only tasks from a specific task file")
  .option("--include-done", "include tasks that already have terminal status records", false)
  .action(async (options) => {
    const rootOptions = program.opts<{ config: string }>();
    const config = await loadConfig(rootOptions.config);
    await runAutomation(config, {
      dryRun: Boolean(options.dryRun),
      maxTasks: options.maxTasks,
      maxDownloads: options.maxDownloads,
      startFromTask: options.startFromTask,
      tasksFile: options.tasksFile,
      includeDone: Boolean(options.includeDone)
    });
  });

program
  .command("inspect")
  .description("Attach to the current browser and print detected LSEG app state")
  .action(async () => {
    const rootOptions = program.opts<{ config: string }>();
    const config = await loadConfig(rootOptions.config);
    const state = await inspectCurrentBrowser(config);
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  });

program
  .command("repair-archive")
  .description("Rebuild a clean by-task archive from raw PDFs in the browser Downloads folder")
  .option("--run-log <paths>", "comma/semicolon separated run log paths or wildcard patterns")
  .option("--status-log <paths>", "comma/semicolon separated task status log paths or wildcard patterns")
  .option("--raw-downloads <dir>", "browser Downloads folder containing raw platform PDFs")
  .option("--existing-archive-root <dir>", "current by_task archive root to audit")
  .option("--target-archive-root <dir>", "target by_task root for repaired copies")
  .option("--report-dir <dir>", "directory for CSV/JSON repair reports", "output/archive_repair")
  .option("--include-unsubmitted", "include selected rows without download_started/downloaded status records", false)
  .option("--apply", "copy matched raw PDFs into the repair target", false)
  .action(async (options) => {
    const rootOptions = program.opts<{ config: string }>();
    const config = await loadConfig(rootOptions.config);
    const runLogPatterns = splitPathList(options.runLog).length > 0 ? splitPathList(options.runLog) : [config.run_log_jsonl];
    const statusLogPatterns = splitPathList(options.statusLog).length > 0 ? splitPathList(options.statusLog) : [config.status_log_jsonl];
    const runLogPaths = await expandPathPatterns(runLogPatterns);
    const statusLogPaths = await expandPathPatterns(statusLogPatterns);
    if (runLogPaths.length === 0) {
      throw new Error("No run logs matched --run-log");
    }

    const defaultRawDownloads = process.env.USERPROFILE
      ? path.resolve(process.env.USERPROFILE, "Downloads")
      : process.env.HOME
        ? path.resolve(process.env.HOME, "Downloads")
        : config.download_dir;
    const rawDownloadsDir = resolveProjectPath(options.rawDownloads ?? defaultRawDownloads);
    const existingArchiveRoot = resolveProjectPath(options.existingArchiveRoot ?? path.resolve(config.download_dir, "by_task"));
    const targetArchiveRoot = resolveProjectPath(options.targetArchiveRoot ?? path.resolve(config.download_dir, "by_task_repaired"));
    const reportDir = resolveProjectPath(options.reportDir);
    const plan = await buildArchiveRepairPlan({
      runLogPaths,
      statusLogPaths,
      rawDownloadsDir,
      existingArchiveRoot,
      includeUnsubmitted: Boolean(options.includeUnsubmitted)
    });
    const reports = await writeArchiveRepairReports(plan, reportDir);
    const summary = summarizeArchiveRepairPlan(plan);

    process.stdout.write(
      [
        `raw_pdfs=${plan.rawPdfCount}`,
        `row_selection_tasks=${plan.rowSelectionTaskCount}`,
        `repair_tasks=${plan.tasks.length}`,
        `already_clean=${summary.already_clean}`,
        `needs_copy=${summary.needs_copy}`,
        `existing_polluted=${summary.existing_polluted}`,
        `partial_raw_match=${summary.partial_raw_match}`,
        `no_raw_match=${summary.no_raw_match}`,
        `report_csv=${reports.csvPath}`,
        `report_json=${reports.jsonPath}`
      ].join("\n") + "\n"
    );

    if (options.apply) {
      const applied = await applyArchiveRepairPlan(plan, targetArchiveRoot);
      process.stdout.write(
        [`target_archive_root=${applied.targetRoot}`, `copied=${applied.copied}`, `skipped_existing=${applied.skippedExisting}`].join("\n") +
          "\n"
      );
    } else {
      process.stdout.write(`dry_run=true\ntarget_archive_root=${targetArchiveRoot}\n`);
    }
  });

program
  .command("build-unfinished-queue")
  .description("Build a portable task_id queue from the original task file and non-empty output/downloads/by_task folders")
  .option("--task-file <path>", "source task file; defaults to config input_file")
  .option("--by-task-root <dir>", "folder root used as completion source of truth; defaults to download_dir/by_task")
  .option("--output <path>", "portable explicit task_id TSV queue")
  .option("--audit <path>", "CSV audit report path")
  .option("--from-task <taskId>", "only include unfinished tasks at or after this original task id")
  .action(async (options) => {
    const rootOptions = program.opts<{ config: string }>();
    const config = await loadConfig(rootOptions.config);
    const today = todayLocal();
    const outputFile = resolveProjectPath(options.output ?? path.join("queues", `unfinished_${today}.tsv`));
    const auditFile = resolveProjectPath(options.audit ?? path.join("output", `unfinished_${today}.audit.csv`));
    const taskFile = resolveProjectPath(options.taskFile ?? config.input_file);
    const byTaskRoot = resolveProjectPath(options.byTaskRoot ?? path.resolve(config.download_dir, "by_task"));
    const summary = await buildUnfinishedQueue({
      taskFile,
      byTaskRoot,
      outputFile,
      auditFile,
      fromTask: options.fromTask
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  });

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, got ${value}`);
  }
  return parsed;
}

function parseNonNegativeInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected non-negative integer, got ${value}`);
  }
  return parsed;
}

function todayLocal(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("");
}
