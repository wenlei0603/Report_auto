# LSEG Research Next Automation Notes (Workspace)

Last updated: 2026-04-23
Workspace: `D:\000-Academia\Agent\Report_download_0422`
Target page: `https://workspace.refinitiv.com/web/Apps/research-next/?st=OAPermID#/?st=OAPermID`

## 1) Scope And Objective

- Data source is a controlled-option query UI (not free-text full search).
- Input tasks come from `D:\20-temp\0422\lseg_request_by_call_2015_2018.txt`.
- Per-task mutable filters:
  - company
  - date range (`Custom...` from/to)
- Global fixed filters:
  - contributor: `Morgan Stanley`
  - country/region: `USA` (United States of America)
  - industry: none
- Daily limit: total downloaded pages <= 500.

## 2) Confirmed UI Structure

- The functional UI is inside a frame URL like:
  - `/Apps/research-next/2.22.3/#/?st=OAPermID`
- Query area contains:
  - `Search by company or portfolio`
  - `Date Range` menu (includes `Custom...`)
  - `Contributors (Any)`
  - `Industry (Any)`
  - `Countries/Regions (Any)`
  - `SEARCH` and `CLEAR`
- Actual controls are web components (important for automation):
  - company: `app-companies-filter emerald-multi-select`
  - contributor: `app-contributors-filter emerald-multi-select`
  - country/region: `app-regions-filter emerald-multi-select`
  - industry: `app-industry-filter emerald-multi-select`
  - date range dropdown: `app-date-range-filter coral-select`
  - custom date popup: `app-date-range-filter app-date-picker-popup` with `emerald-datetime-picker`
- Results area contains:
  - row checkboxes
  - top select-all checkbox
  - toolbar buttons like `DOWNLOAD`
  - after selection/download flow: `DOCUMENT INFORMATION` + `SAVE DOCUMENTS TO PC`

## 3) Critical Rules From User

- `Contributor` must be Morgan Stanley only.
- Do **not** use or tick `preferred contributors`.
- Enforcement rule in automation:
  - if any checkbox label matching `preferred + contributor/broker` is checked, uncheck it immediately.
  - contributor selection is valid only when exactly one selected label remains and it is `Morgan Stanley`.
- If no matching report under current filters, skip to next task.
- There is a button in search/results flow to return to query settings:
  - use the `modify query conditions`/`modify search criteria` entry as the main way back to filter-edit mode.

## 4) Query UX Logic (Automation Policy)

- Because this is controlled matching:
  - do not treat company input as arbitrary text search.
  - after typing company/ticker, select from dropdown suggestions/options.
  - if exact company text is not selectable, try ticker-based match; if still unavailable, mark task as no-match and continue.
- Company selection must be resolved against dropdown candidates (do not accept free text as success).
- For `3M Co`, candidate list includes multiple entries (`MMM`, `MMM.N`, etc.); selection must choose from list, not typed text.
- Date handling:
  - open `Date Range`
  - choose `Custom...`
  - set from/to datetime
  - confirm with `OK` (or equivalent)
  - verify summary text reflects selected interval before searching.
  - implementation detail: custom range picker uses shadow inputs `#input` and `#input-to` inside `emerald-datetime-picker`.
  - required validation: summary line must equal `DD-MMM-YYYY 00:00 To DD-MMM-YYYY 00:00`.

## 5) Download Decision Policy (500-page Guard)

- Preferred path A:
  - run search
  - select all results
  - `DOWNLOAD` -> `SAVE DOCUMENTS TO PC`
- Alternative path B:
  - row-level info/download documents
  - `SAVE DOCUMENTS TO PC`
- Choose A/B based on expected page impact and availability of bulk action.
- Before each download action, estimate/add pages and stop before exceeding 500/day.
- Additional hard safety:
  - `max_downloads` default is `1` per run during debugging.
  - only increase `max_downloads` after verifying filters and one successful download.
  - never repeatedly click `SAVE DOCUMENTS TO PC` when UI state is unclear.
  - if page is already in `DOCUMENT INFORMATION` mode, return to result-selection mode before re-triggering downloads.

## 6) Logging And Mapping Requirements

- Keep both:
  - execution log JSONL (events, selectors, decisions, errors)
  - task-file mapping CSV (task -> downloaded file(s) / status)
- Required statuses include:
  - `downloaded`
  - `no_results`
  - `no_rows`
  - `no_downloadable_report`
  - `task_failed`
  - `page_limit`
  - `filter_not_applied`

## 7) Session-Handling Notes

- If session expires, user re-login is needed, then automation re-attaches via CDP.
- After re-attach, first action is to re-detect frame + re-validate key controls before continuing tasks.

## 8) Current Known Risks

- Download capture can fail if UI switches into `DOCUMENT INFORMATION` mode and `SAVE DOCUMENTS TO PC` flow is triggered outside expected event timing.
- Some toolbar buttons have hidden duplicates; automation should always act on visible controls only.
