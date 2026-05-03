import type { LsegConfig } from "../config.js";
import { applyGlobalFilters, applyTaskFilters, ensureQueryMode } from "../browser/filters.js";
import { executeBulkDownload } from "../browser/download.js";
import { reviewResultCompanyList } from "../browser/results.js";
import { openBrowserSession } from "../browser/session.js";
import { getResearchScope, waitForResearchScope } from "../browser/scope.js";
import { classifyAppState, classifyResults } from "../browser/state.js";
import { PageGuard } from "../domain/pageGuard.js";
import { loadTasks } from "../domain/tasks.js";
import type { FinalTaskStatus, RequestTask } from "../domain/types.js";
import { RecordStore } from "../io/records.js";
import { RunLogger } from "../io/runLogger.js";
import type { Page } from "playwright";

export interface RunOptions {
  dryRun: boolean;
  maxTasks?: number;
  maxDownloads?: number;
  startFromTask?: string;
}

export interface InspectResult {
  state: string;
  pageUrl: string;
  scopeUrl: string;
  reason: string;
}

export async function inspectCurrentBrowser(config: LsegConfig): Promise<InspectResult> {
  const logger = new RunLogger(config.run_log_jsonl);
  const session = await openBrowserSession(config, logger);
  try {
    const scope = await waitForResearchScope(session.page, config, logger);
    const state = await classifyAppState(session.page, config);
    return {
      state: state.state,
      pageUrl: state.pageUrl,
      scopeUrl: scope.url(),
      reason: state.reason
    };
  } finally {
    await session.browser.close().catch(() => undefined);
  }
}

export async function runAutomation(config: LsegConfig, options: RunOptions): Promise<void> {
  const logger = new RunLogger(config.run_log_jsonl);
  const store = new RecordStore(config.mapping_csv, config.status_log_jsonl, config.progress_csv, config.daily_page_limit);
  await store.initialize();

  const allTasks = await loadTasks(config.input_file);
  const doneIds = await store.doneTaskIds();
  const pending = selectPendingTasks(allTasks, doneIds, options);
  await logger.event("INFO", "Loaded task queue", {
    totalTasks: allTasks.length,
    doneTasks: doneIds.size,
    pendingTasks: pending.length,
    dryRun: options.dryRun
  });

  if (options.dryRun) {
    const previewLimit = (options.maxTasks ?? config.behavior.debug_max_tasks) || 10;
    for (const task of pending.slice(0, previewLimit)) {
      process.stdout.write(`${task.taskId}\t${task.company}\t${task.ticker}\t${task.dateFrom}..${task.dateTo}\n`);
    }
    return;
  }

  let session = await openBrowserSession(config, logger);
  try {
    await waitForResearchScope(session.page, config, logger);
    const initialState = await classifyAppState(session.page, config);
    await logger.event("INFO", "Initial app state", { ...initialState });
    if (initialState.state === "auth") {
      throw new Error("LSEG session is not authenticated. Log in manually, then run again.");
    }

    let globalApplied = false;
    let downloaded = 0;
    const usedPages = await store.dailyPages();
    const guard = new PageGuard(config.daily_page_limit, usedPages);

    for (const task of pending) {
      if (session.page.isClosed() || !session.browser.isConnected()) {
        session = await reconnectBrowserSession(config, logger);
      }

      if (options.maxTasks && downloaded >= options.maxTasks) {
        break;
      }
      if (effectiveMaxDownloads(config, options) > 0 && downloaded >= effectiveMaxDownloads(config, options)) {
        await logger.event("INFO", "Reached max downloads", { downloaded });
        break;
      }

      await logger.event("INFO", "Starting task", {
        taskId: task.taskId,
        company: task.company,
        ticker: task.ticker,
        dateFrom: task.dateFrom,
        dateTo: task.dateTo,
        remainingPages: guard.remaining
      });

      const status = await runOneTask({
        config,
        logger,
        store,
        task,
        pageGuard: guard,
        page: session.page,
        applyGlobalFilters: !globalApplied || !config.behavior.apply_global_filters_once
      });

      if (status === "downloaded") {
        downloaded += 1;
        globalApplied = true;
      } else if (status !== "filter_not_applied") {
        globalApplied = true;
      }
    }
  } finally {
    await session.browser.close().catch(() => undefined);
  }
}

async function reconnectBrowserSession(config: LsegConfig, logger: RunLogger) {
  const session = await openBrowserSession(config, logger);
  await waitForResearchScope(session.page, config, logger);
  const state = await classifyAppState(session.page, config);
  await logger.event("INFO", "Reconnected browser session", { ...state });
  return session;
}

async function runOneTask(input: {
  config: LsegConfig;
  logger: RunLogger;
  store: RecordStore;
  task: RequestTask;
  pageGuard: PageGuard;
  page: Page;
  applyGlobalFilters: boolean;
}): Promise<FinalTaskStatus> {
  const { config, logger, store, task, pageGuard } = input;
  const { page } = input;
  let scope = await waitForResearchScope(page, config, logger);

  try {
    if (!(await ensureQueryMode(scope, config))) {
      await writeFailure(store, task, "filter_not_applied", "query_mode_not_available", page.url());
      return "filter_not_applied";
    }

    if (input.applyGlobalFilters) {
      const globalResult = await applyGlobalFilters(scope, config);
      await logger.event(globalResult.ok ? "INFO" : "WARN", "Global filter result", globalResult.details);
      if (!globalResult.ok) {
        await writeFailure(store, task, "filter_not_applied", globalResult.reason, page.url());
        return "filter_not_applied";
      }
    }

    scope = getResearchScope(page);
    const taskResult = await applyTaskFilters(scope, config, task);
    await logger.event("INFO", "Task filter result", {
      taskId: task.taskId,
      okCompany: taskResult.okCompany,
      okFrom: taskResult.okFrom,
      okTo: taskResult.okTo,
      closedBlankTabs: taskResult.closedBlankTabs,
      companyDetails: taskResult.companyDetails
    });
    if (!taskResult.okCompany || !taskResult.okFrom || !taskResult.okTo) {
      if (taskResult.companyDetails.needsHumanReview === true) {
        await store.writeStatus({
          task,
          status: "special_company_case",
          pages: 0,
          note: String(taskResult.companyDetails.reason ?? "company_selection_needs_human_review"),
          pageUrl: page.url()
        });
        return "special_company_case";
      }
      await writeFailure(store, task, "filter_not_applied", "task_filter_validation_failed", page.url());
      return "filter_not_applied";
    }

    scope = getResearchScope(page);
    const resultState = await classifyResults(scope, config);
    await logger.event("INFO", "Result classification", { taskId: task.taskId, ...resultState });

    if (resultState.status === "no_results" || resultState.status === "no_rows") {
      const status = resultState.status;
      await store.writeStatus({
        task,
        status,
        pages: 0,
        note: resultState.reason,
        pageUrl: page.url()
      });
      return status;
    }

    if (resultState.status !== "results" && resultState.status !== "document_info") {
      await writeFailure(store, task, "task_failed", `unexpected_result_state:${resultState.status}`, page.url());
      return "task_failed";
    }

    const companyListReview = await reviewResultCompanyList(scope, config, task.company, task.ticker);
    await logger.event(companyListReview.ok ? "INFO" : "WARN", "Result company review", {
      taskId: task.taskId,
      ...companyListReview
    });
    if (!companyListReview.ok && companyListReview.needsHumanReview) {
      await store.writeStatus({
        task,
        status: "special_company_case",
        pages: 0,
        note: `human_review_required:${companyListReview.reason}`,
        pageUrl: page.url()
      });
      return "special_company_case";
    }

    const estimatedPages = Math.max(1, resultState.estimatedPages);
    if (!pageGuard.canSpend(estimatedPages)) {
      await store.writeStatus({
        task,
        status: "page_limit",
        pages: 0,
        note: `estimated_pages=${estimatedPages}; remaining=${pageGuard.remaining}`,
        pageUrl: page.url()
      });
      return "page_limit";
    }

    const downloadSourceUrl = page.url();
    const download = await executeBulkDownload({ page, scope, config, task, estimatedPages });
    if (!download.ok || (config.behavior.require_download_artifacts && download.artifacts.length === 0)) {
      const failureStatus = download.status === "downloaded" ? "task_failed" : download.status;
      await writeFailure(store, task, failureStatus, download.error || "download_failed_without_artifact", downloadSourceUrl);
      return failureStatus;
    }

    const pages = download.artifacts.reduce((sum, artifact) => sum + artifact.pages, 0) || download.pages;
    pageGuard.spend(pages);
    for (const mapping of download.mappingRecords) {
      await store.appendMapping(mapping);
    }
    await store.writeStatus({
      task,
      status: "downloaded",
      pages,
      note: "download_event_verified",
      pageUrl: downloadSourceUrl,
      artifacts: download.artifacts
    });
    return "downloaded";
  } catch (error) {
    await logger.event("ERROR", "Task failed", { taskId: task.taskId, error: String(error) });
    await writeFailure(store, task, "task_failed", String(error), page.url());
    return "task_failed";
  }
}

function selectPendingTasks(tasks: RequestTask[], doneIds: Set<string>, options: RunOptions): RequestTask[] {
  let selected = tasks.filter((task) => !doneIds.has(task.taskId));
  if (options.startFromTask) {
    const index = selected.findIndex((task) => task.taskId === options.startFromTask);
    selected = index >= 0 ? selected.slice(index) : selected;
  }
  if (options.maxTasks && options.maxTasks > 0) {
    selected = selected.slice(0, options.maxTasks);
  }
  return selected;
}

function effectiveMaxDownloads(config: LsegConfig, options: RunOptions): number {
  return options.maxDownloads ?? config.max_downloads;
}

async function writeFailure(
  store: RecordStore,
  task: RequestTask,
  status: Extract<FinalTaskStatus, "filter_not_applied" | "task_failed" | "no_downloadable_report" | "special_company_case">,
  note: string,
  pageUrl: string
): Promise<void> {
  await store.writeStatus({
    task,
    status,
    pages: 0,
    note,
    pageUrl
  });
}
