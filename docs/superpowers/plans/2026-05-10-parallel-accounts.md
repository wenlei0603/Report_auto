# Parallel Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `run-parallel` command that coordinates multiple logged-in LSEG browser sessions with one worker per account and independent daily page budgets.

**Architecture:** Keep the existing single-account `run` path stable. Add account-aware config/types, account-aware records, an in-process task queue, and a parallel orchestration layer that reuses the existing one-task browser workflow. Each worker owns its own CDP session, download directory, logger path, and `PageGuard`.

**Tech Stack:** TypeScript, Node.js 22, Commander, Zod, Playwright over CDP, Vitest.

---

## File Structure

- Modify `src/config.ts`: parse optional `accounts[]`, validate unique account IDs/endpoints, expose helper to derive single-account compatibility.
- Modify `src/domain/types.ts`: add optional `accountId` to status and mapping record types.
- Modify `src/io/records.ts`: write/read account-aware status, progress, and mapping records; add account-specific daily page usage.
- Create `src/automation/taskQueue.ts`: in-process leasing queue for pending tasks.
- Modify `src/automation/engine.ts`: export `runOneTask`, `effectiveMaxDownloads`, and account-scoped runner helpers without changing single-account behavior.
- Create `src/automation/parallelEngine.ts`: start one worker per configured account and coordinate global stop conditions.
- Modify `src/cli.ts`: add `run-parallel`.
- Add tests in `tests/configAccounts.test.ts`, `tests/accountRecords.test.ts`, `tests/taskQueue.test.ts`, and `tests/parallelEngine.test.ts`.

---

### Task 1: Account Config Parsing

**Files:**
- Modify: `src/config.ts`
- Test: `tests/configAccounts.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/configAccounts.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { normalizeAccounts, type LsegConfig } from "../src/config.js";

function baseConfig(overrides: Partial<LsegConfig> = {}): LsegConfig {
  return {
    workspace_url: "https://workspace.refinitiv.com/web/Apps/research-next/?st=OAPermID#/?st=OAPermID",
    input_file: "input.txt",
    download_dir: "output/downloads",
    mapping_csv: "output/task_file_mapping.csv",
    status_log_jsonl: "logs/task_status.jsonl",
    progress_csv: "output/task_progress.csv",
    run_log_jsonl: "logs/run_log.jsonl",
    daily_page_limit: 700,
    max_downloads: 1,
    cdp_endpoint: "http://127.0.0.1:9222",
    browser: {
      headless: false,
      slow_mo_ms: 0,
      fallback_channel: "chrome",
      user_data_dir: "D:/chrome-rpa-profile"
    },
    filters: {
      contributor: "Morgan Stanley",
      country: "USA",
      industry: "none",
      max_pages: 23
    },
    timeouts: {
      default_ms: 20000,
      download_ms: 90000,
      login_wait_seconds: 600
    },
    behavior: {
      apply_global_filters_once: true,
      app_restart_attempts: 3,
      recover_from_batchsaveprint: true,
      require_download_artifacts: true,
      debug_max_tasks: 1
    },
    selectors: {
      company_input: [],
      company_option_items: [],
      apply_buttons: [],
      modify_query_buttons: [],
      result_rows: [],
      no_results_text: [],
      next_page_buttons: [],
      download_buttons: [],
      select_all_checkboxes: [],
      save_to_pc_buttons: [],
      pages_text: [],
      report_title: [],
      report_date: []
    },
    ...overrides
  };
}

describe("normalizeAccounts", () => {
  test("derives a default account from legacy single-account config", () => {
    const accounts = normalizeAccounts(baseConfig());

    expect(accounts).toEqual([
      {
        id: "default",
        cdp_endpoint: "http://127.0.0.1:9222",
        daily_page_limit: 700,
        download_dir: "output/downloads"
      }
    ]);
  });

  test("uses configured accounts when present", () => {
    const accounts = normalizeAccounts(
      baseConfig({
        accounts: [
          {
            id: "account_a",
            cdp_endpoint: "http://127.0.0.1:9222",
            daily_page_limit: 700,
            download_dir: "output/downloads/account_a"
          },
          {
            id: "account_b",
            cdp_endpoint: "http://127.0.0.1:9223",
            daily_page_limit: 700,
            download_dir: "output/downloads/account_b"
          }
        ]
      })
    );

    expect(accounts.map((account) => account.id)).toEqual(["account_a", "account_b"]);
  });

  test("rejects duplicate account ids", () => {
    expect(() =>
      normalizeAccounts(
        baseConfig({
          accounts: [
            { id: "dup", cdp_endpoint: "http://127.0.0.1:9222", daily_page_limit: 700, download_dir: "a" },
            { id: "dup", cdp_endpoint: "http://127.0.0.1:9223", daily_page_limit: 700, download_dir: "b" }
          ]
        })
      )
    ).toThrow(/Duplicate account id: dup/);
  });

  test("rejects duplicate account cdp endpoints", () => {
    expect(() =>
      normalizeAccounts(
        baseConfig({
          accounts: [
            { id: "a", cdp_endpoint: "http://127.0.0.1:9222", daily_page_limit: 700, download_dir: "a" },
            { id: "b", cdp_endpoint: "http://127.0.0.1:9222", daily_page_limit: 700, download_dir: "b" }
          ]
        })
      )
    ).toThrow(/Duplicate account cdp_endpoint: http:\/\/127.0.0.1:9222/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/configAccounts.test.ts`

Expected: FAIL because `normalizeAccounts` and `accounts` do not exist.

- [ ] **Step 3: Implement account config types and validation**

In `src/config.ts`, add:

```typescript
const AccountSchema = z.object({
  id: z.string().min(1),
  cdp_endpoint: z.string().min(1),
  daily_page_limit: z.number().int().positive(),
  download_dir: z.string().min(1)
});
```

Add `accounts: z.array(AccountSchema).optional()` to `ConfigSchema`.

Add exports:

```typescript
export type LsegAccountConfig = z.infer<typeof AccountSchema>;

export function normalizeAccounts(config: LsegConfig): LsegAccountConfig[] {
  const accounts = config.accounts?.length
    ? config.accounts
    : [
        {
          id: "default",
          cdp_endpoint: config.cdp_endpoint,
          daily_page_limit: config.daily_page_limit,
          download_dir: config.download_dir
        }
      ];
  assertUniqueAccounts(accounts);
  return accounts;
}

function assertUniqueAccounts(accounts: LsegAccountConfig[]): void {
  const ids = new Set<string>();
  const endpoints = new Set<string>();
  for (const account of accounts) {
    if (ids.has(account.id)) {
      throw new Error(`Duplicate account id: ${account.id}`);
    }
    ids.add(account.id);
    if (endpoints.has(account.cdp_endpoint)) {
      throw new Error(`Duplicate account cdp_endpoint: ${account.cdp_endpoint}`);
    }
    endpoints.add(account.cdp_endpoint);
  }
}
```

Update `resolveConfigPaths` to resolve each account `download_dir`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/configAccounts.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/config.ts tests/configAccounts.test.ts
git commit -m "feat: add account config parsing"
```

---

### Task 2: Account-Aware Records

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/io/records.ts`
- Test: `tests/accountRecords.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/accountRecords.test.ts`:

```typescript
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { RecordStore } from "../src/io/records.js";
import type { RequestTask } from "../src/domain/types.js";

const task: RequestTask = {
  taskId: "T0001",
  permno: "12345",
  company: "Example Corp",
  ticker: "EXM",
  ccDate: "01-Jan-2016",
  dateFrom: "01-Jan-2016",
  dateTo: "08-Jan-2016"
};

async function storeInTemp(limit = 700): Promise<{ dir: string; store: RecordStore; status: string; progress: string; mapping: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lseg-records-"));
  const mapping = path.join(dir, "mapping.csv");
  const status = path.join(dir, "status.jsonl");
  const progress = path.join(dir, "progress.csv");
  const store = new RecordStore(mapping, status, progress, limit);
  await store.initialize();
  return { dir, store, status, progress, mapping };
}

describe("account-aware records", () => {
  test("dailyPagesForAccount counts only the selected account", async () => {
    const { store } = await storeInTemp();
    await store.writeStatus({ accountId: "account_a", task, status: "download_started", pages: 100, note: "a", pageUrl: "url" });
    await store.writeStatus({
      accountId: "account_b",
      task: { ...task, taskId: "T0002" },
      status: "download_started",
      pages: 200,
      note: "b",
      pageUrl: "url"
    });

    await expect(store.dailyPagesForAccount("account_a")).resolves.toBe(100);
    await expect(store.dailyPagesForAccount("account_b")).resolves.toBe(200);
  });

  test("legacy dailyPages still counts records without accountId", async () => {
    const { store } = await storeInTemp();
    await store.writeStatus({ task, status: "download_started", pages: 77, note: "legacy", pageUrl: "url" });

    await expect(store.dailyPages()).resolves.toBe(77);
  });

  test("progress and mapping CSVs include account_id", async () => {
    const { store, progress, mapping } = await storeInTemp();
    await store.writeStatus({ accountId: "account_a", task, status: "download_started", pages: 12, note: "started", pageUrl: "url" });
    await store.appendMapping({
      accountId: "account_a",
      timestamp: "2026-05-10T00:00:00.000Z",
      taskId: "T0001",
      company: "Example Corp",
      dateFrom: "01-Jan-2016",
      dateTo: "08-Jan-2016",
      reportTitle: "Report",
      reportDate: "01-Jan-2016",
      pages: 12,
      filePath: "file.pdf",
      status: "downloaded",
      error: "",
      sourceUrl: "url"
    });

    await expect(readFile(progress, "utf8")).resolves.toContain("account_id");
    await expect(readFile(mapping, "utf8")).resolves.toContain("account_id");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/accountRecords.test.ts`

Expected: FAIL because `accountId` and `dailyPagesForAccount` do not exist.

- [ ] **Step 3: Add account fields to domain types**

In `src/domain/types.ts`, add `accountId?: string` to `TaskStatusRecord` and `MappingRecord`.

- [ ] **Step 4: Update `RecordStore` headers and writes**

In `src/io/records.ts`:

- Add `"account_id"` to `MAPPING_HEADERS` after `"timestamp"`.
- Add `"account_id"` to `PROGRESS_HEADERS` after `"run_date"`.
- Extend `writeStatus` input with `accountId?: string`.
- Set `record.accountId = input.accountId`.
- Append account ID values to CSV rows with `record.accountId ?? ""`.
- Extend `appendMapping` CSV output with `record.accountId ?? ""`.

- [ ] **Step 5: Add account-specific daily page usage**

In `src/io/records.ts`, add:

```typescript
  async dailyPagesForAccount(accountId: string, runDate = todayIso()): Promise<number> {
    const records = await readJsonl<TaskStatusRecord>(this.statusJsonl);
    return dailyPageUsageForAccount(records, runDate, accountId);
  }
```

Add helper:

```typescript
function dailyPageUsageForAccount(records: TaskStatusRecord[], runDate: string, accountId: string): number {
  return [...latestAccountingRecordByTaskForAccount(records, runDate, accountId).values()].reduce(
    (sum, record) => sum + Math.max(0, record.pages || 0),
    0
  );
}

function latestAccountingRecordByTaskForAccount(records: TaskStatusRecord[], runDate: string, accountId: string): Map<string, TaskStatusRecord> {
  const latest = new Map<string, TaskStatusRecord>();
  for (const record of records) {
    if (record.runDate !== runDate || !PAGE_ACCOUNTING_STATUSES.has(record.status) || record.accountId !== accountId) {
      continue;
    }
    latest.set(record.taskId, record);
  }
  return latest;
}
```

Keep existing `dailyPages()` behavior unchanged for single-account compatibility.

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- tests/accountRecords.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/domain/types.ts src/io/records.ts tests/accountRecords.test.ts
git commit -m "feat: record account-specific progress"
```

---

### Task 3: In-Process Task Queue

**Files:**
- Create: `src/automation/taskQueue.ts`
- Test: `tests/taskQueue.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/taskQueue.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { TaskQueue } from "../src/automation/taskQueue.js";
import type { RequestTask } from "../src/domain/types.js";

function task(id: string): RequestTask {
  return {
    taskId: id,
    permno: id,
    company: `Company ${id}`,
    ticker: id,
    ccDate: "01-Jan-2016",
    dateFrom: "01-Jan-2016",
    dateTo: "08-Jan-2016"
  };
}

describe("TaskQueue", () => {
  test("leases each task at most once while in flight", () => {
    const queue = new TaskQueue([task("T0001"), task("T0002")]);

    const first = queue.leaseNext("account_a");
    const second = queue.leaseNext("account_b");
    const third = queue.leaseNext("account_c");

    expect(first?.taskId).toBe("T0001");
    expect(second?.taskId).toBe("T0002");
    expect(third).toBeUndefined();
    expect(queue.inFlightCount).toBe(2);
  });

  test("complete removes a leased task from in-flight accounting", () => {
    const queue = new TaskQueue([task("T0001")]);
    const leased = queue.leaseNext("account_a");

    queue.complete(leased!.taskId);

    expect(queue.inFlightCount).toBe(0);
    expect(queue.remainingCount).toBe(0);
  });

  test("release returns a task to the front of the queue", () => {
    const queue = new TaskQueue([task("T0001"), task("T0002")]);
    const leased = queue.leaseNext("account_a");

    queue.release(leased!.taskId);

    expect(queue.leaseNext("account_b")?.taskId).toBe("T0001");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/taskQueue.test.ts`

Expected: FAIL because `TaskQueue` does not exist.

- [ ] **Step 3: Implement minimal queue**

Create `src/automation/taskQueue.ts`:

```typescript
import type { RequestTask } from "../domain/types.js";

interface Lease {
  accountId: string;
  task: RequestTask;
}

export class TaskQueue {
  private readonly pending: RequestTask[];
  private readonly inFlight = new Map<string, Lease>();
  private readonly completed = new Set<string>();

  constructor(tasks: RequestTask[]) {
    this.pending = [...tasks];
  }

  get remainingCount(): number {
    return this.pending.length;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  leaseNext(accountId: string): RequestTask | undefined {
    while (this.pending.length > 0) {
      const task = this.pending.shift()!;
      if (this.completed.has(task.taskId) || this.inFlight.has(task.taskId)) {
        continue;
      }
      this.inFlight.set(task.taskId, { accountId, task });
      return task;
    }
    return undefined;
  }

  complete(taskId: string): void {
    this.inFlight.delete(taskId);
    this.completed.add(taskId);
  }

  release(taskId: string): void {
    const lease = this.inFlight.get(taskId);
    if (!lease) {
      return;
    }
    this.inFlight.delete(taskId);
    this.pending.unshift(lease.task);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/taskQueue.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/automation/taskQueue.ts tests/taskQueue.test.ts
git commit -m "feat: add in-process task leasing"
```

---

### Task 4: Extract Account-Scoped Single Task Runner

**Files:**
- Modify: `src/automation/engine.ts`
- Test: `tests/automationQueue.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/automationQueue.test.ts`:

```typescript
import { effectiveMaxDownloads } from "../src/automation/engine.js";

test("effectiveMaxDownloads prefers CLI override over config value", () => {
  expect(effectiveMaxDownloads({ max_downloads: 3 } as never, { dryRun: false, maxDownloads: 1 })).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/automationQueue.test.ts`

Expected: FAIL because `effectiveMaxDownloads` is not exported.

- [ ] **Step 3: Export reusable functions**

In `src/automation/engine.ts`:

- Change `async function runOneTask` to `export async function runOneTask`.
- Change `function effectiveMaxDownloads` to `export function effectiveMaxDownloads`.
- Keep `writeFailure` private.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/automationQueue.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/automation/engine.ts tests/automationQueue.test.ts
git commit -m "refactor: expose reusable automation runner pieces"
```

---

### Task 5: Parallel Engine Worker Stop Semantics

**Files:**
- Create: `src/automation/parallelEngine.ts`
- Test: `tests/parallelEngine.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/parallelEngine.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { shouldWorkerContinueAfterStatus } from "../src/automation/parallelEngine.js";

describe("parallel worker stop semantics", () => {
  test("page_limit stops only the current worker", () => {
    expect(shouldWorkerContinueAfterStatus("page_limit")).toBe(false);
  });

  test("downloaded allows the worker to keep leasing tasks", () => {
    expect(shouldWorkerContinueAfterStatus("downloaded")).toBe(true);
  });

  test("filter_not_applied allows later tasks to continue", () => {
    expect(shouldWorkerContinueAfterStatus("filter_not_applied")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/parallelEngine.test.ts`

Expected: FAIL because `parallelEngine.ts` does not exist.

- [ ] **Step 3: Implement stop helper**

Create `src/automation/parallelEngine.ts` with:

```typescript
import type { FinalTaskStatus } from "../domain/types.js";

export function shouldWorkerContinueAfterStatus(status: FinalTaskStatus): boolean {
  return status !== "page_limit" && status !== "max_downloads";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/parallelEngine.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/automation/parallelEngine.ts tests/parallelEngine.test.ts
git commit -m "feat: add parallel worker stop semantics"
```

---

### Task 6: Implement `runParallelAutomation`

**Files:**
- Modify: `src/automation/parallelEngine.ts`
- Modify: `src/config.ts`
- Modify: `src/automation/engine.ts`
- Test: `tests/parallelEngine.test.ts`

- [ ] **Step 1: Write the failing orchestration test**

Append to `tests/parallelEngine.test.ts`:

```typescript
import { TaskQueue } from "../src/automation/taskQueue.js";

test("leased task completion allows another account to continue after one worker stops", () => {
  const queue = new TaskQueue([
    {
      taskId: "T0001",
      permno: "1",
      company: "A",
      ticker: "A",
      ccDate: "01-Jan-2016",
      dateFrom: "01-Jan-2016",
      dateTo: "08-Jan-2016"
    },
    {
      taskId: "T0002",
      permno: "2",
      company: "B",
      ticker: "B",
      ccDate: "01-Jan-2016",
      dateFrom: "01-Jan-2016",
      dateTo: "08-Jan-2016"
    }
  ]);

  const first = queue.leaseNext("account_a")!;
  queue.complete(first.taskId);
  expect(shouldWorkerContinueAfterStatus("page_limit")).toBe(false);

  const second = queue.leaseNext("account_b")!;
  expect(second.taskId).toBe("T0002");
});
```

- [ ] **Step 2: Run test to verify it fails or passes for the wrong reason**

Run: `npm test -- tests/parallelEngine.test.ts`

Expected before implementation: PASS may occur because this is a small unit test. If it passes immediately, keep it as a guard and add the implementation in the next step with full typecheck verification.

- [ ] **Step 3: Add account config application helper**

In `src/config.ts`, add:

```typescript
export function configForAccount(config: LsegConfig, account: LsegAccountConfig): LsegConfig {
  return {
    ...config,
    cdp_endpoint: account.cdp_endpoint,
    daily_page_limit: account.daily_page_limit,
    download_dir: account.download_dir
  };
}
```

- [ ] **Step 4: Implement parallel engine**

In `src/automation/parallelEngine.ts`, add:

```typescript
import { configForAccount, normalizeAccounts, type LsegAccountConfig, type LsegConfig } from "../config.js";
import { PageGuard } from "../domain/pageGuard.js";
import { loadTasks } from "../domain/tasks.js";
import type { FinalTaskStatus, RequestTask } from "../domain/types.js";
import { RecordStore } from "../io/records.js";
import { RunLogger } from "../io/runLogger.js";
import { openBrowserSession } from "../browser/session.js";
import { waitForResearchScope } from "../browser/scope.js";
import { classifyAppState } from "../browser/state.js";
import { runOneTask, selectPendingTasks, type RunOptions } from "./engine.js";
import { TaskQueue } from "./taskQueue.js";

export interface ParallelRunSummary {
  accountCount: number;
  completedTasks: number;
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
  const counters = { completedTasks: 0 };
  await Promise.all(accounts.map((account) => runAccountWorker(config, account, store, queue, options, counters)));
  return { accountCount: accounts.length, completedTasks: counters.completedTasks };
}

async function runAccountWorker(
  baseConfig: LsegConfig,
  account: LsegAccountConfig,
  store: RecordStore,
  queue: TaskQueue,
  options: RunOptions,
  counters: { completedTasks: number }
): Promise<void> {
  const config = configForAccount(baseConfig, account);
  const logger = new RunLogger(config.run_log_jsonl);
  const usedPages = await store.dailyPagesForAccount(account.id);
  const pageGuard = new PageGuard(account.daily_page_limit, usedPages);
  let session = await openBrowserSession(config, logger);
  let globalApplied = false;

  try {
    await waitForResearchScope(session.page, config, logger);
    const initialState = await classifyAppState(session.page, config);
    await logger.event("INFO", "Initial parallel worker app state", { accountId: account.id, ...initialState });
    if (initialState.state === "auth") {
      throw new Error(`LSEG session is not authenticated for account ${account.id}`);
    }

    while (true) {
      if (options.maxTasks && counters.completedTasks >= options.maxTasks) {
        break;
      }
      const task: RequestTask | undefined = queue.leaseNext(account.id);
      if (!task) {
        break;
      }

      const status = await runOneTask({
        config,
        logger,
        store,
        task,
        pageGuard,
        page: session.page,
        accountId: account.id,
        applyGlobalFilters: !globalApplied || !config.behavior.apply_global_filters_once
      });
      queue.complete(task.taskId);
      counters.completedTasks += 1;
      globalApplied = status !== "filter_not_applied";

      if (!shouldWorkerContinueAfterStatus(status)) {
        break;
      }
    }
  } finally {
    await session.browser.close().catch(() => undefined);
  }
}
```

- [ ] **Step 5: Add `accountId` to `runOneTask` input and writes**

In `src/automation/engine.ts`, extend `runOneTask` input with `accountId?: string`.

Pass `accountId: input.accountId` to every `store.writeStatus` call inside `runOneTask`.

Pass `accountId: input.accountId` to mapping records if the mapping construction is in this file. If mapping records are created in `src/browser/download.ts`, pass account context into `executeBulkDownload` in a later task.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```powershell
npm test -- tests/parallelEngine.test.ts tests/taskQueue.test.ts tests/accountRecords.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/automation/parallelEngine.ts src/automation/engine.ts src/config.ts tests/parallelEngine.test.ts
git commit -m "feat: add parallel account runner"
```

---

### Task 7: CLI Command

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/configAccounts.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/configAccounts.test.ts`:

```typescript
test("parallel command is intentionally backed by account normalization", () => {
  const accounts = normalizeAccounts(
    baseConfig({
      accounts: [{ id: "account_a", cdp_endpoint: "http://127.0.0.1:9222", daily_page_limit: 700, download_dir: "out/a" }]
    })
  );
  expect(accounts).toHaveLength(1);
});
```

- [ ] **Step 2: Run test**

Run: `npm test -- tests/configAccounts.test.ts`

Expected: PASS. This test guards the config path used by the CLI.

- [ ] **Step 3: Add `run-parallel` command**

In `src/cli.ts`, import:

```typescript
import { runParallelAutomation } from "./automation/parallelEngine.js";
```

Add command:

```typescript
program
  .command("run-parallel")
  .description("Run parallel automation across configured LSEG accounts")
  .option("--dry-run", "parse and print pending tasks without browser actions", false)
  .option("--max-tasks <count>", "maximum tasks to process across all accounts", parsePositiveInt)
  .option("--max-downloads <count>", "maximum successful downloads across all accounts", parseNonNegativeInt)
  .option("--start-from-task <taskId>", "start from a specific task id, for example T0100")
  .option("--include-done", "include tasks that already have terminal status records", false)
  .action(async (options) => {
    const rootOptions = program.opts<{ config: string }>();
    const config = await loadConfig(rootOptions.config);
    await runParallelAutomation(config, {
      dryRun: Boolean(options.dryRun),
      maxTasks: options.maxTasks,
      maxDownloads: options.maxDownloads,
      startFromTask: options.startFromTask,
      includeDone: Boolean(options.includeDone)
    });
  });
```

- [ ] **Step 4: Run CLI dry build path**

Run:

```powershell
npm run build
node dist/src/cli.js run-parallel --dry-run --max-tasks 1
```

Expected: build succeeds; dry run prints at most one pending task.

- [ ] **Step 5: Commit**

```powershell
git add src/cli.ts tests/configAccounts.test.ts
git commit -m "feat: add parallel run command"
```

---

### Task 8: Account-Aware Download Mapping

**Files:**
- Modify: `src/browser/download.ts`
- Modify: `src/automation/engine.ts`
- Test: `tests/downloadHandoff.test.ts`

- [ ] **Step 1: Write failing type-level test through existing download tests**

Append to `tests/downloadHandoff.test.ts`:

```typescript
test("download mapping records can carry account id", () => {
  const mapping = {
    accountId: "account_a",
    timestamp: "2026-05-10T00:00:00.000Z",
    taskId: "T0001",
    company: "Example Corp",
    dateFrom: "01-Jan-2016",
    dateTo: "08-Jan-2016",
    reportTitle: "Report",
    reportDate: "01-Jan-2016",
    pages: 1,
    filePath: "file.pdf",
    status: "downloaded",
    error: "",
    sourceUrl: "url"
  };

  expect(mapping.accountId).toBe("account_a");
});
```

- [ ] **Step 2: Run test**

Run: `npm test -- tests/downloadHandoff.test.ts`

Expected: PASS after Task 2 type changes. If it fails, fix the `MappingRecord` type.

- [ ] **Step 3: Add account ID to download input**

In `src/browser/download.ts`, extend the `executeBulkDownload` input type with:

```typescript
accountId?: string;
```

When creating each mapping record, include:

```typescript
accountId: input.accountId,
```

- [ ] **Step 4: Pass account ID from engine**

In `src/automation/engine.ts`, pass `accountId: input.accountId` into `executeBulkDownload`.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npm test -- tests/downloadHandoff.test.ts tests/accountRecords.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/browser/download.ts src/automation/engine.ts tests/downloadHandoff.test.ts
git commit -m "feat: tag download mappings with account id"
```

---

### Task 9: Full Verification

**Files:**
- Modify only if verification reveals a defect.

- [ ] **Step 1: Run full static verification**

Run:

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

Expected: all commands pass.

- [ ] **Step 2: Run dry run**

Run:

```powershell
node dist/src/cli.js run-parallel --dry-run --max-tasks 2
```

Expected: prints at most two pending tasks; does not open or control browsers.

- [ ] **Step 3: Review git status**

Run: `git status --short`

Expected: only intended source, test, and docs files are changed. Runtime logs and downloads remain untracked.

- [ ] **Step 4: Commit final fixes if needed**

If any small verification fix was required:

```powershell
git add <fixed-files>
git commit -m "fix: stabilize parallel account runner"
```

---

## Self-Review

Spec coverage:

- Multi-account config: Task 1.
- Separate `run-parallel` command: Task 7.
- Dynamic queue leasing: Task 3.
- Per-account page budget: Task 2 and Task 6.
- Worker stop on only its own `page_limit`: Task 5 and Task 6.
- Account IDs in records: Task 2 and Task 8.
- Existing single-account compatibility: Task 1, Task 2, Task 4, and full verification.

Placeholder scan:

- No unfinished markers or unspecified implementation steps are intentionally left.

Type consistency:

- Account property name is `accountId` in TypeScript records and `account_id` in CSV output.
- Config property is `accounts[]` with `id`, `cdp_endpoint`, `daily_page_limit`, and `download_dir`.
