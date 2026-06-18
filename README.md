# LSEG Research Next Automation

TypeScript + Playwright automation for LSEG Research Next report downloading.

The runner does not log in for the user. It attaches to a Chrome instance that has already been logged in manually, controls the Research Next UI through CDP, applies task filters, selects eligible reports, verifies downloaded PDF artifacts, and writes resumable logs.

## Release Scope

This release branch contains the runnable TypeScript rewrite only:

- Browser automation, result classification, row selection, download verification, page-limit accounting, and recovery from the temporary Batch Service Print page.
- Unit tests and build/lint/typecheck configuration.
- Runtime configuration in `config/lseg.yaml`.
- Architecture and implementation notes in `workflow.md`.
- Project knowledge base in `lseg_research_next_kb_2026-04-30.md`.

Development-only agent workspaces, debug dumps, and historical Python reference folders are intentionally excluded from the release branch.

## Requirements

- Node.js `>=22`.
- Chrome or Chromium-compatible browser.
- An LSEG Workspace account with manual login completed in the CDP browser window.
- Windows PowerShell for the bundled Chrome CDP launcher.

## Install

```powershell
npm install
npm run build
```

Start Chrome with a persistent CDP profile:

```powershell
npm run browser:start
```

Log in to LSEG in that browser window before running automation commands.

## Configuration

Edit `config/lseg.yaml` before a real run.

Key fields:

- `input_file`: task list file.
- `download_dir`: root folder for downloaded PDFs.
- `daily_page_limit`: daily page budget. Default is `700`.
- `max_downloads`: successful-download cap for a run. Use CLI overrides for test runs.
- `cdp_endpoint`: browser endpoint. Default is `http://127.0.0.1:9222`.
- `browser.user_data_dir`: persistent browser profile used by `npm run browser:start`.
- `filters.contributor`: expected contributor, currently `Morgan Stanley`.
- `filters.max_pages`: strict report page limit, currently `23`.

The checked-in config avoids machine-specific absolute profile paths. Browser login profiles are created locally and ignored by git.

The control-panel config in `config/rpa-control-panel.json` is intentionally portable:

- Four worker ports are predeclared: `9222`, `9223`, `9224`, and `9225`.
- Browser profiles are relative paths under `profiles/`, which is ignored by git so login state is never committed.
- Add more ports by appending entries with `id`, `port`, `profile`, and `defaultStartTask`.
- Keep `downloadDir` as `output/downloads` unless you also update the archive and queue commands.

## Common Commands

Inspect the current browser and Research Next state:

```powershell
npm run automation:inspect
```

Preview queued tasks without browser actions:

```powershell
npm run automation:dry-run -- --max-tasks 5
```

Run one conservative live task:

```powershell
npm run dev -- run --max-tasks 1 --max-downloads 1
```

Resume from a specific task:

```powershell
node dist/src/cli.js run --start-from-task T0066 --max-downloads 1
```

Re-run completed tasks intentionally:

```powershell
node dist/src/cli.js run --include-done --start-from-task T0001 --max-downloads 1
```

Use `--max-downloads 0` only when the run should not stop on successful-download count. Page-limit protection still applies.

Build a portable unfinished-task queue from local completed folders:

```powershell
node dist/src/cli.js build-unfinished-queue --output queues/unfinished_20260618.tsv
```

The builder uses non-empty folders under `output/downloads/by_task/Txxxx` as the completion source of truth. It does not use logs to decide whether a task is done. The generated TSV has an explicit `task_id` column, so compact queues keep the original `Txxxx` identifiers on any computer.

Run a generated queue:

```powershell
node dist/src/cli.js -c config/lseg.yaml run --tasks-file queues/unfinished_20260618.tsv --start-from-task T1201 --include-done
```

Use `--include-done` when resuming a compact queue from an explicit task id. The folder-based queue should already exclude successfully archived tasks.

## Windows Control Panel

The bundled control panel opens CDP browsers, generates per-port run configs, starts/stops node runners, and reads status.

```powershell
.\RPA-Control-Panel.bat
```

Typical workflow on a new computer:

1. Install dependencies with `npm install` and build with `npm run build`.
2. Open the control panel.
3. Click `Open CDP` for each port you want to use, then log in manually.
4. Set `Start task`, `Task file`, and `Pages`.
5. Click `Inspect` once per port to confirm the browser is authenticated.
6. Click `Start Run`.

The panel writes generated queues and configs under ignored `output/task_slices` and `output/run_configs`. Downloads continue to land under `output/downloads/by_task`.

## Safe Run Procedure

1. Make sure no other automation process is controlling the same CDP browser.
2. Start Chrome with `npm run browser:start`.
3. Log in manually and open LSEG Research Next.
4. Run `npm run automation:inspect`.
5. Run a dry run for the target range.
6. Start with `--max-tasks 1 --max-downloads 1`.
7. Increase limits only after downloaded files, logs, and page accounting look correct.

## Page-Limit Behavior

The runner reserves pages when selected reports enter the download flow, not only after files appear on disk. This prevents the run from exceeding the daily page budget when multiple PDFs are downloaded in one batch.

Current behavior:

- The selected rows' `Pages` values are summed before download.
- If the sum fits the remaining budget, the task is logged as `download_started` and the page count is reserved.
- If the sum would exceed `daily_page_limit`, the task is logged as `page_limit`, rows are not selected, download is not started, and the run stops.
- Existing `download_started` and `downloaded` records are counted when computing the remaining budget.
- Failures before `download_started` refund the in-memory page reservation.
- Failures after `download_started` remain counted in daily usage even if archive verification later fails.

## Download And Browser Recovery

Research Next opens a temporary `Batch Service Print Service` page during batch downloads. That page reports download status but is not the correct surface for the next task.

The runner therefore:

- Clicks Download and Save to PC from the Research Next results page.
- Waits until all expected PDFs for the selected reports are complete, not just until the first PDF appears.
- Detaches/reconnects CDP after the batch-download flow when needed.
- Returns to the original Research Next page for the next filter operation.
- Uses the `Search options` pencil/filter button to reopen the filter panel after a previous query has collapsed it.

## Outputs

- `logs/run_log.jsonl`: runtime events and diagnostic breadcrumbs.
- `logs/task_status.jsonl`: task status, selected reports, page accounting, and artifact metadata.
- `output/task_progress.csv`: flattened progress table.
- `output/task_file_mapping.csv`: task-to-file mapping.
- `output/downloads/by_task/Txxxx/`: verified PDFs grouped by task.

Downloaded reports are logged with enough metadata to distinguish strict ticker matches from company/date matches whose ticker is incomplete or unavailable. Local re-archival can be done from these logs after download.

## Status Values

- `download_started`: eligible rows were selected and page budget was reserved.
- `downloaded`: expected PDFs were verified on disk.
- `no_rows`: result grid did not contain downloadable rows.
- `no_results`: Research Next returned no results.
- `no_downloadable_report`: rows existed, but none passed the selection rules.
- `filter_not_applied`: UI filter state did not match the requested task.
- `special_company_case`: task requires human review or special handling.
- `page_limit`: the next selected batch would exceed the configured page budget.
- `task_failed`: unrecovered runtime failure.

## Verification

```powershell
npm test
npm run lint
npm run typecheck
npm run build
```

Live download verification still requires an authenticated LSEG browser session. Use conservative limits before a longer run.

## More Documentation

- `workflow.md`: current technical architecture, state machine, and implementation route.
- `lseg_research_next_kb_2026-04-30.md`: project knowledge base and UI findings.
