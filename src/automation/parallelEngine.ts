import { classifyAppState } from "../browser/state.js";
import { openBrowserSession } from "../browser/session.js";
import { waitForResearchScope } from "../browser/scope.js";
import { configForAccount, normalizeAccounts, type LsegAccountConfig, type LsegConfig } from "../config.js";
import { PageGuard } from "../domain/pageGuard.js";
import { loadTasks } from "../domain/tasks.js";
import type { FinalTaskStatus, RequestTask } from "../domain/types.js";
import { RecordStore } from "../io/records.js";
import { RunLogger } from "../io/runLogger.js";
import { effectiveMaxDownloads, runOneTask, selectPendingTasks, type RunOptions } from "./engine.js";
import { TaskQueue } from "./taskQueue.js";
import type { BrowserSession } from "../browser/types.js";

export interface ParallelRunSummary {
  accountCount: number;
  completedTasks: number;
}

interface SharedCounters {
  leasedTasks: number;
  inFlightTasks: number;
  completedTasks: number;
  downloadedTasks: number;
}

export async function runParallelAutomation(config: LsegConfig, options: RunOptions): Promise<ParallelRunSummary> {
  const accounts = normalizeAccounts(config);
  if (accounts.length < 1) {
    throw new Error("run-parallel requires at least one account");
  }

  const store = new RecordStore(config.mapping_csv, config.status_log_jsonl, config.progress_csv, config.daily_page_limit);
  await store.initialize();

  const allTasks = await loadTasks(config.input_file);
  const doneIds = await store.doneTaskIds();
  const pending = selectPendingTasks(allTasks, doneIds, options);

  if (options.dryRun) {
    const previewLimit = (options.maxTasks ?? config.behavior.debug_max_tasks) || 10;
    for (const task of pending.slice(0, previewLimit)) {
      process.stdout.write(`${task.taskId}\t${task.company}\t${task.ticker}\t${task.dateFrom}..${task.dateTo}\n`);
    }
    return { accountCount: accounts.length, completedTasks: 0 };
  }

  const queue = new TaskQueue(pending);
  const counters: SharedCounters = { leasedTasks: 0, inFlightTasks: 0, completedTasks: 0, downloadedTasks: 0 };
  await Promise.all(accounts.map((account) => runAccountWorker(config, account, store, queue, options, counters)));
  return { accountCount: accounts.length, completedTasks: counters.completedTasks };
}

async function runAccountWorker(
  baseConfig: LsegConfig,
  account: LsegAccountConfig,
  store: RecordStore,
  queue: TaskQueue,
  options: RunOptions,
  counters: SharedCounters
): Promise<void> {
  const config = configForAccount(baseConfig, account);
  const logger = new RunLogger(config.run_log_jsonl);
  const accountStore = new RecordStore(config.mapping_csv, config.status_log_jsonl, config.progress_csv, account.daily_page_limit);
  await accountStore.initialize();
  const usedPages = await store.dailyPagesForAccount(account.id);
  const pageGuard = new PageGuard(account.daily_page_limit, usedPages);
  let session = await openAccountSession(config, account.id, logger);
  let globalApplied = false;
  const maxDownloads = effectiveMaxDownloads(config, options);
  let sessionFailureCount = 0;

  try {
    while (true) {
      if (options.maxTasks && counters.leasedTasks >= options.maxTasks) {
        break;
      }
      if (maxDownloads > 0 && counters.downloadedTasks + counters.inFlightTasks >= maxDownloads) {
        break;
      }

      const task: RequestTask | undefined = queue.leaseNext(account.id);
      if (!task) {
        break;
      }
      counters.leasedTasks += 1;
      counters.inFlightTasks += 1;

      const status = await runOneTask({
        config,
        logger,
        store: accountStore,
        task,
        pageGuard,
        page: session.page,
        accountId: account.id,
        applyGlobalFilters: !globalApplied || !config.behavior.apply_global_filters_once
      });
      let finalStatus = status;

      if (status === "task_failed") {
        const action = nextSessionFailureAction(sessionFailureCount);
        sessionFailureCount += 1;
        await logger.event("WARN", "Parallel worker task failed; applying session recovery policy", {
          accountId: account.id,
          taskId: task.taskId,
          action,
          sessionFailureCount
        });

        if (action === "retry_session") {
          await session.browser.close().catch(() => undefined);
          session = await openAccountSession(config, account.id, logger);
          globalApplied = false;
          finalStatus = await runOneTask({
            config,
            logger,
            store: accountStore,
            task,
            pageGuard,
            page: session.page,
            accountId: account.id,
            applyGlobalFilters: true
          });
          if (finalStatus === "task_failed") {
            sessionFailureCount += 1;
          }
        }

        if (finalStatus === "task_failed" && sessionFailureCount >= 2) {
          await accountStore.writeStatus({
            accountId: account.id,
            task,
            status: "special_company_case",
            pages: 0,
            note: "human_review_required:session_failed_twice",
            pageUrl: session.page.url()
          });
          finalStatus = "special_company_case";
        }
      }

      queue.complete(task.taskId);
      counters.inFlightTasks -= 1;
      counters.completedTasks += 1;
      if (finalStatus === "downloaded") {
        counters.downloadedTasks += 1;
      }
      globalApplied = finalStatus !== "filter_not_applied";

      if (!shouldWorkerContinueAfterStatus(finalStatus) || sessionFailureCount >= 2) {
        break;
      }
    }
  } finally {
    await session.browser.close().catch(() => undefined);
  }
}

async function openAccountSession(config: LsegConfig, accountId: string, logger: RunLogger): Promise<BrowserSession> {
  const session = await openBrowserSession(config, logger);
  await waitForResearchScope(session.page, config, logger);
  const initialState = await classifyAppState(session.page, config);
  await logger.event("INFO", "Parallel worker app state", { accountId, ...initialState });
  if (initialState.state === "auth") {
    throw new Error(`LSEG session is not authenticated for account ${accountId}`);
  }
  return session;
}

export function shouldWorkerContinueAfterStatus(status: FinalTaskStatus): boolean {
  return status !== "page_limit" && status !== "max_downloads";
}

export function nextSessionFailureAction(previousSessionFailures: number): "retry_session" | "human_review" {
  return previousSessionFailures <= 0 ? "retry_session" : "human_review";
}
