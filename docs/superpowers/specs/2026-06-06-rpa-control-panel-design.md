# RPA Control Panel Design

## Goal

Provide a local Windows control panel so the user can open CDP browser ports, log in manually, and start or stop LSEG download runs without asking an agent for routine operations.

The control panel must keep the current downloader behavior intact. It wraps the existing Chrome CDP launcher and `dist/src/cli.js` automation rather than replacing the download engine.

## Configuration Model

Add `config/rpa-control-panel.json` as the main operator-editable configuration file.

The config defines:

- `defaultTaskFile`: default source task TSV.
- `downloadDir`: canonical output directory, normally `output/downloads`.
- `dailyPageLimit`: default daily page limit, normally `700`.
- `stopOnPageLimit`: default `true`; near the page limit the run stops when the next selected task exceeds remaining pages.
- `ports`: extensible list of browser workers.

Each port entry defines:

- `id`: display identifier, such as `9222`.
- `port`: CDP port number.
- `profile`: Chrome user data directory.
- `defaultStartTask`: default resume point.
- Optional future fields such as `maxDownloads`, `taskFile`, or per-port page limit.

## GUI Scope

Create a PowerShell Windows Forms panel in `scripts/rpa-control-panel.ps1`, launched by `RPA-Control-Panel.bat`.

The GUI reads the config and renders one row per configured port. The visible controls are intentionally limited:

- Start task field.
- Task file field.
- Page limit field.
- Open Browser.
- Inspect Login.
- Start Download.
- Stop Runner.
- Status.

Advanced behavior remains configurable in JSON rather than crowding the UI.

## Helper Scope

Create `scripts/rpa-control-helper.mjs` for non-UI operations. PowerShell calls this helper so parsing, queue generation, JSONL status summarization, and config generation stay testable and easier to extend.

Helper commands:

- `make-run-config`: scan `output/downloads/by_task`, generate a sparse queue from the task file, and generate a per-run YAML config.
- `status`: summarize the per-run status and run logs.
- `runner-pids`: find node runner processes matching a generated config.

The helper must preserve original `Txxxx` numbering by writing sparse queues. It must exclude tasks with non-empty `output/downloads/by_task/Txxxx*` directories and ignore logs when determining whether a task has already landed.

## Run Behavior

When the GUI starts a download:

1. It calls the helper to generate a queue and run config for the selected port, task file, start task, and page limit.
2. The generated run config points to the selected CDP port and Chrome profile.
3. The run uses independent status, progress, mapping, and run logs under `logs/` and `output/`.
4. Downloads still land in `output/downloads/by_task`.
5. The GUI starts `node dist/src/cli.js -c <generated-config> run` in the background and records stdout/stderr paths.

Default page-limit behavior is `stop_on_page_limit: true`. If the selected rows for a task exceed remaining pages, the run stops instead of searching for smaller tasks.

Existing accounting remains unchanged: `download_started` pages count toward the daily limit even if later platform handoff or local archive verification fails.

## Stop Behavior

`Stop Runner` stops only the node runner process for that port/config. It does not close Chrome. This lets the user keep the logged-in browser session and restart cleanly.

## Status Behavior

`Status` reports:

- Runner PID if active.
- Last started task.
- Latest status counts.
- Accounted pages and remaining pages.
- Recent statuses.
- Recent warnings or errors.
- Latest non-empty task folders.

## Extensibility

Adding a new worker should require only adding a `ports` entry to `config/rpa-control-panel.json`.

Changing task file, page limit, profile, start task, or stop-on-limit behavior should not require edits to the GUI script.

## Verification

Verification should cover:

- Helper can generate a sparse queue and config.
- Existing task parser reads generated queue with original task IDs.
- Status command summarizes a sample or real JSONL log.
- GUI script parses and loads without syntax errors.
- TypeScript build remains valid because downloader core is not changed.
