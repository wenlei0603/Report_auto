# CLAUDE.md

Quick-start instructions for Claude Code or any Claude-based coding agent working on this repository.

## What This Project Is

This is a TypeScript + Playwright automation project for downloading LSEG Research Next reports from a browser session where the human user has already logged in.

The project goal is reliability, not scraping aggressiveness:

- Attach to a logged-in Chrome browser through CDP.
- Apply company/date/contributor/page filters in Research Next.
- Select all eligible report rows.
- Download every selected PDF.
- Verify that the full batch completed before moving on.
- Track page usage so the daily page budget is not exceeded.
- Record enough metadata to re-archive strict ticker matches separately from company/date matches with incomplete ticker data.

## Read These First

1. `README.md`: operator setup, configuration, commands, outputs.
2. `workflow.md`: architecture, implementation route, current milestones.
3. `AGENTS.md`: cross-agent engineering rules and browser-specific constraints.
4. `lseg_research_next_kb_2026-04-30.md`: current UI knowledge base.
5. `config/lseg.yaml`: active runtime settings and local paths.

## Fast Local Verification

Use PowerShell from the repository root.

```powershell
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

If `node_modules` already exists and the lockfile has not changed, skip `npm install`.

## Browser Startup

Start Chrome with CDP:

```powershell
npm run browser:start
```

The human user must log in to LSEG manually in that browser. After login, inspect the current app state:

```powershell
npm run automation:inspect
```

Preview the queue without live browser actions:

```powershell
npm run automation:dry-run -- --max-tasks 5
```

Run conservatively:

```powershell
npm run dev -- run --max-tasks 1 --max-downloads 1
```

Do not run a long live download loop unless the user explicitly asks and confirms readiness.

## Critical Implementation Facts

- The correct page for filtering is the original Research Next page.
- `Batch Service Print Service` is a temporary download-status page. Never continue filtering there.
- After batch download completion, reconnect to the Research Next page.
- Reopen collapsed filters via the `Search options` pencil/filter button.
- The strongest known Search options selector is `app-button.edit-filters-button coral-button[icon='filter']`.
- Result rows are inside an `emerald-grid` shadow-DOM grid.
- Date-range controls can depend on the Search options panel being reopened first.
- Page accounting happens when rows are selected for download, before files land.
- A run must wait for all expected PDFs in a selected batch, not just the first PDF.

## Where To Edit

- CLI options: `src/cli.ts`.
- Config schema: `src/config.ts`.
- Task loop and stop behavior: `src/automation/engine.ts`.
- CDP/browser lifecycle: `src/browser/session.ts`.
- Research Next page/frame selection: `src/browser/scope.ts`.
- Filter UI: `src/browser/filters.ts`.
- Result extraction and report classification: `src/browser/results.ts`.
- Download flow and PDF verification: `src/browser/download.ts`.
- Daily page budget: `src/domain/pageGuard.ts`.
- Task parsing: `src/domain/tasks.ts`.
- Records, resume, CSV/JSONL outputs: `src/io/records.ts`.

## Do Not Break These Guarantees

- Do not count only completed PDFs for page budgeting. Count `download_started` reservations too.
- Do not proceed after `page_limit`.
- Do not select rows when the selected page total exceeds the remaining budget.
- Do not treat the temporary Batch Service Print page as the next task surface.
- Do not select only one eligible report if multiple rows pass the task filters.
- Do not remove metadata needed to distinguish strict ticker matches from non-strict company/date matches.
- Do not commit runtime downloads, logs, local browser profiles, or account-specific artifacts.

## Status Values To Know

- `download_started`: selected rows entered the download flow and pages were reserved.
- `downloaded`: expected PDFs were verified.
- `no_rows`: no result-grid rows.
- `no_results`: Research Next returned no results.
- `no_downloadable_report`: rows existed but none passed selection rules.
- `filter_not_applied`: UI state did not match the requested filters.
- `special_company_case`: task needs human handling.
- `page_limit`: next batch would exceed the page budget and the run should stop.
- `task_failed`: unrecovered runtime failure.

## Before Handoff

Leave the next agent with:

- Current branch and commit.
- Files changed.
- Verification commands run.
- Whether any live browser run happened.
- Last task ID and stop reason.
- Current page-budget state if a live run touched downloads.
