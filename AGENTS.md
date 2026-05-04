# AGENTS.md

Project-specific instructions for AI coding agents working in this repository.

## Project Identity

This repository is the TypeScript + Playwright rewrite of an LSEG Research Next report downloader.

The automation attaches to a browser session that the human user has already logged into manually. It does not bypass login, does not attack the site, and does not attempt to defeat platform controls. The core job is reliable research-data collection within the user's allowed daily page budget.

## First 10 Minutes

When a new AI agent starts from a fresh clone, do this first:

1. Read `README.md` for operator-facing setup and run commands.
2. Read `workflow.md` for architecture, state machine, browser recovery, and implementation route.
3. Read `lseg_research_next_kb_2026-04-30.md` for current Research Next UI findings.
4. Inspect `config/lseg.yaml`, especially local paths, CDP endpoint, page limits, and download limits.
5. Run static verification before changing code:

```powershell
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

If dependencies are already installed, do not reinstall unless needed.

## Runtime Model

- Primary language: TypeScript.
- Browser automation: Playwright over Chrome DevTools Protocol.
- Login model: manual login by the user, then attach to `http://127.0.0.1:9222`.
- Browser launcher: `npm run browser:start`.
- Inspect command: `npm run automation:inspect`.
- Dry run command: `npm run automation:dry-run -- --max-tasks 5`.
- Conservative live run: `npm run dev -- run --max-tasks 1 --max-downloads 1`.

Do not start a long live run unless the user explicitly asks for it and confirms the browser is logged in.

## Core Architecture

- `src/cli.ts`: command-line entrypoint and run options.
- `src/config.ts`: YAML config validation.
- `src/automation/engine.ts`: task loop, state transitions, page-limit stop behavior.
- `src/browser/session.ts`: CDP connection lifecycle.
- `src/browser/scope.ts`: correct Research Next page/frame selection.
- `src/browser/state.ts`: UI state classification.
- `src/browser/filters.ts`: query/filter panel control.
- `src/browser/results.ts`: result-grid extraction and eligibility classification.
- `src/browser/download.ts`: checkbox selection, batch download, PDF completion verification.
- `src/domain/pageGuard.ts`: daily page-budget accounting.
- `src/domain/tasks.ts`: input task parsing.
- `src/io/records.ts`: JSONL/CSV persistence and resume state.
- `tests/`: unit tests for queueing, page accounting, records, parsing, and browser helper logic.

## Browser Rules

The correct working surface is the original Research Next app page, not the temporary `Batch Service Print Service` page.

Important UI facts:

- Reopen collapsed filters through the `Search options` pencil/filter button.
- The reliable selector for that button is currently `app-button.edit-filters-button coral-button[icon='filter']`.
- Clicking `Search` can collapse the filter panel.
- Date-range controls may not expand unless the filter panel has been reopened through Search options.
- Result rows live in an `emerald-grid` shadow-DOM grid, not a normal HTML table.
- A batch download may open or focus a temporary Batch Service Print page. After all expected PDFs are complete, reconnect to the Research Next page before the next task.

Prefer evidence from live browser state, network/download events, logs, and saved PDFs over assumptions about the UI.

## Page-Limit Rules

Daily page-budget protection is a hard requirement.

- `daily_page_limit` in `config/lseg.yaml` is the configured budget.
- Page usage counts both `download_started` and `downloaded` task records.
- Selected report pages are reserved before download starts.
- If the next selected batch would exceed the remaining budget, record `page_limit`, do not select rows, do not download, and stop the run.
- Do not change this behavior to "wait until PDFs land" before accounting. That was a known failure mode for multi-PDF batches.

## Download Rules

- Select all eligible reports for a task, not just the first eligible row.
- Eligibility must consider company, date range, contributor, page count, and ticker classification.
- Strict ticker matches and company/date matches with incomplete or unavailable ticker data should both be downloadable when requested, but must be distinguished in logs for later local archival.
- Wait for all expected PDFs in a batch before advancing to the next task.
- Do not treat the first observed PDF as proof the batch is complete.

## Logs And Outputs

Primary runtime artifacts:

- `logs/run_log.jsonl`: runtime events and breadcrumbs.
- `logs/task_status.jsonl`: task statuses, selected reports, page accounting, and artifacts.
- `output/task_progress.csv`: flattened progress.
- `output/task_file_mapping.csv`: task-to-file mapping.
- `output/downloads/by_task/Txxxx/`: verified task PDFs.

Generated logs and downloads are runtime data. Do not commit them unless the user explicitly asks for a reproducible fixture or documentation example.

## Development Rules

- Preserve the TypeScript rewrite structure. Historical Python automation is reference material only.
- Keep browser-specific behavior in `src/browser/`, task/domain policy in `src/domain/`, orchestration in `src/automation/`, and persistence in `src/io/`.
- Add or update tests for page accounting, task state transitions, result classification, or selector behavior when those areas change.
- Prefer small, focused modules over large rewrites.
- Do not hardcode local secrets, credentials, or account-specific tokens.
- Do not modify `config/lseg.yaml` for a user's local path unless explicitly requested.
- Use conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.

## Verification Expectations

Before claiming a code change is complete, run:

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

For documentation-only changes, at minimum run:

```powershell
git diff --check
```

Live behavior still requires an authenticated browser session and human confirmation that the correct LSEG page is open.

## Safe AI Handoff Summary

If you need to brief the next AI agent, include:

- Current branch and latest commit.
- Whether the browser is open and logged in.
- Current page-limit budget and recent `task_status.jsonl` state.
- Last task ID attempted and whether it stopped because of `page_limit`, `max_downloads`, `task_failed`, or user interruption.
- Commands already run and their results.
