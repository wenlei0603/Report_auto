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
  const session = await openBrowserSession(config, logger);
  let globalApplied = false;
  const maxDownloads = effectiveMaxDownloads(config, options);

  try {
    await waitForResearchScope(session.page, config, logger);
    const initialState = await classifyAppState(session.page, config);
    await logger.event("INFO", "Initial parallel worker app state", { accountId: account.id, ...initialState });
    if (initialState.state === "auth") {
      throw new Error(`LSEG session is not authenticated for account ${account.id}`);
    }

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

      queue.complete(task.taskId);
      counters.inFlightTasks -= 1;
      counters.completedTasks += 1;
      if (status === "downloaded") {
        counters.downloadedTasks += 1;
      }
      globalApplied = status !== "filter_not_applied";

      if (!shouldWorkerContinueAfterStatus(status)) {
        break;
      }
    }
  } finally {
    await session.browser.close().catch(() => undefined);
  }
}

export function shouldWorkerContinueAfterStatus(status: FinalTaskStatus): boolean {
  return status !== "page_limit" && status !== "max_downloads";
}
