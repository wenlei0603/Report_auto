# Parallel LSEG Account Downloader Design

## Goal

Add a multi-account run mode for the LSEG Research Next downloader. One command should coordinate multiple manually logged-in browser sessions, one per account, so the same task corpus can be downloaded with separate daily page budgets.

The first target is two accounts, each with a 700-page daily budget. The design must support adding more accounts later by editing configuration, not by changing task-splitting code.

## Non-Goals

- Do not automate login.
- Do not bypass LSEG controls or page limits.
- Do not run multiple workers against the same CDP endpoint.
- Do not replace the existing single-account `run` command.
- Do not commit runtime logs, downloaded PDFs, or account-specific local paths beyond example configuration.

## Configuration

Add an optional `accounts` array to the YAML config:

```yaml
accounts:
  - id: "account_a"
    cdp_endpoint: "http://127.0.0.1:9222"
    daily_page_limit: 700
    download_dir: "output/downloads/account_a"
  - id: "account_b"
    cdp_endpoint: "http://127.0.0.1:9223"
    daily_page_limit: 700
    download_dir: "output/downloads/account_b"
```

If `accounts` is absent, the current single-account behavior remains unchanged and uses top-level `cdp_endpoint`, `daily_page_limit`, and `download_dir`.

Each account must have a unique `id` and unique `cdp_endpoint`. The runner should fail fast if duplicates are configured.

## CLI

Add a separate command:

```powershell
npm run dev -- run-parallel
```

`run-parallel` accepts the same task-shaping options as `run`:

- `--dry-run`
- `--max-tasks <count>`
- `--max-downloads <count>`
- `--start-from-task <taskId>`
- `--include-done`

The separate command keeps the current stable single-account command semantics intact.

## Architecture

Add a parallel orchestration layer rather than rewriting the existing task execution flow.

Main modules:

- `src/automation/parallelEngine.ts`: loads tasks, builds the shared queue, starts account workers, aggregates stop conditions.
- `src/automation/taskQueue.ts`: owns dynamic task leasing inside the process so a task is assigned to at most one worker.
- Existing `runOneTask` behavior should be reused or extracted from `engine.ts` so each worker runs the same browser flow as the single-account runner.
- `PageGuard` remains the page-budget primitive, with one instance per account.
- `RecordStore` gains account-aware reads and writes.

## Task Dispatch

Use dynamic in-process leasing:

1. Build pending tasks from the same rules as the single-account runner.
2. Each worker asks the queue for the next task when idle.
3. The queue marks the task as in-flight before returning it.
4. Completed terminal tasks are not reassigned.
5. If a worker hits account-level `page_limit`, that worker stops asking for tasks.
6. If a recoverable browser error happens, the task is recorded using the existing failure semantics and is not immediately handed to another account in the same run.

This avoids fixed odd/even task splits and scales naturally from two accounts to more accounts.

## Page Accounting

Page accounting is per account per day.

`task_status.jsonl` records written by parallel mode include `accountId`. Daily page usage for an account counts the latest `download_started` or `downloaded` record for each task where:

- `runDate` is today, and
- `accountId` matches that account.

When a selected batch would exceed the worker account's remaining budget:

- write `page_limit` with that `accountId`;
- do not select rows;
- do not start a download;
- stop only that worker.

Other account workers continue until they hit their own limits or the shared queue is empty.

Old status records without `accountId` remain readable. For single-account mode, they are treated as belonging to the implicit default account for compatibility.

## Records And Outputs

Extend status and progress records with `accountId`.

Recommended fields:

- JSONL: `accountId`
- progress CSV: `account_id`
- mapping CSV: `account_id`

Parallel downloads should be isolated by account:

```text
output/downloads/account_a/by_task/T0001/
output/downloads/account_b/by_task/T0002/
```

The existing by-task layout remains available for single-account mode.

## Browser Sessions

Each worker opens one browser session through its account config:

- account A connects to its own CDP endpoint;
- account B connects to its own CDP endpoint;
- workers never share a `Page`, `Browser`, `BrowserContext`, or `PageGuard`.

Before starting a live parallel run, the operator must start and log into each browser manually.

Example:

```powershell
# Browser A
chrome --remote-debugging-port=9222 --user-data-dir=D:/chrome-rpa-profile-a

# Browser B
chrome --remote-debugging-port=9223 --user-data-dir=D:/chrome-rpa-profile-b
```

## Stop Conditions

Global stop conditions:

- shared queue is empty;
- every account worker is stopped because of page limit or unrecoverable setup failure;
- `--max-tasks` is reached across all workers;
- `--max-downloads` is reached across all workers.

Worker stop conditions:

- that account reaches `page_limit`;
- browser is unauthenticated;
- CDP endpoint cannot be used;
- repeated existing recovery attempts fail.

## Testing

Implement test-first.

Required unit coverage:

- config parser accepts `accounts[]` and preserves old single-account config behavior;
- config parser rejects duplicate account IDs and duplicate CDP endpoints;
- task queue never leases the same task twice;
- account page usage counts only records for the requested account;
- one account hitting `page_limit` does not stop another account in parallel orchestration;
- status/progress/mapping output includes `accountId` in parallel mode;
- old records without `accountId` are still handled by single-account mode.

Live browser verification still requires authenticated LSEG sessions and should start with conservative limits:

```powershell
npm run dev -- run-parallel --max-tasks 2 --max-downloads 1
```

## Risks

- Two browsers writing to the same native download directory can confuse artifact detection. Account-specific download directories are required for parallel mode.
- The current `RecordStore` appends files without cross-process locking. The recommended parallel mode is a single process with multiple workers; do not run multiple `run-parallel` commands at once.
- If both accounts select reports for the same task through operator error or manual runs, logs may contain conflicting terminal records. The queue prevents this only within one `run-parallel` process.

## Acceptance Criteria

- A config with two accounts can run `run-parallel`.
- Each account connects to its own browser endpoint.
- Tasks are dynamically distributed without duplicate leasing.
- Each account enforces its own 700-page limit.
- One account hitting `page_limit` does not stop the other.
- Runtime records identify which account handled each task.
- Existing single-account commands and tests continue to pass.
