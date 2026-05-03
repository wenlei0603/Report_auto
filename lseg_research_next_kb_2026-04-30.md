# LSEG Research Next Automation Knowledge Base v1

Date: 2026-04-30
Workspace: `D:\000-Academia\Agent\Report_download_0422`
Target page: `https://workspace.refinitiv.com/web/Apps/research-next/?st=OAPermID#/?st=OAPermID`

## 1. Purpose

This document captures the current understanding of the semi-automated LSEG Research Next workflow, the real website/application structure, the existing code coverage, and the boundary conditions that a fully automated downloader must handle.

This is a system knowledge base, not yet the final implementation design.

## 2. Current Repository Model

Core files:

- `README.md`: describes the current human-in-the-loop workflow.
- `config/config.yaml`: runtime config for URL, input task file, selectors, CDP, download directory, limits.
- `scripts/manual_loop_driver.py`: stable semi-automatic driver used in actual runs.
- `scripts/lseg_rpa.py`: shared automation primitives plus a legacy full-automation path.
- `scripts/action_recorder.py`: exploratory recorder for UI/network discovery.

Stable outputs and logs:

- `logs/manual_task_status.jsonl`: operator-entered task outcomes.
- `output/manual_task_progress.csv`: flattened task progress.
- `output/task_file_mapping.csv`: task to downloaded-file mapping.
- `logs/run_log.jsonl`: structured automation/runtime log.
- `output/downloads/by_task/Txxxx/`: archived PDFs by task.

Observed task corpus:

- input rows: 4242
- unique companies: 831
- current mapped statuses in `output/task_file_mapping.csv`:
  - `downloaded`: 20
  - `no_downloadable_report`: 41
  - `task_failed`: 2

## 3. Input Task Model

The primary input file is TSV-like:

`permno | companyname | tickers | cc_date | window_start | window_end`

Example:

`22592    3M Co    MMM    22-Oct-2015 00:00    22-Oct-2015 00:00    05-Nov-2015 00:00`

Current parser behavior in `scripts/lseg_rpa.py`:

- Generates task IDs as `T0001`, `T0002`, ...
- Uses `companyname` as company input.
- Uses `tickers` as secondary matching input.
- Uses `window_start/window_end` as the actual search interval.
- Keeps `cc_date` but only as metadata/operator prompt context.

Important implication:

- The search window is not `cc_date .. cc_date+7`.
- The search window is the task window from the file.

## 4. Website/Application Model

### 4.1 Outer/Inner App Structure

The visible URL starts as:

- `/web/Apps/research-next/?st=OAPermID#/?st=OAPermID`

But the functional research UI runs inside an inner app/frame URL like:

- `/Apps/research-next/2.22.3/#/?st=OAPermID`

The current code correctly treats the inner `/Apps/research-next/2.*` frame as the real automation scope.

Observed from action logs:

- the app bootstraps through multiple frame hops
- the research app version observed in logs is `2.22.3`
- Batch download can redirect the browser into:
  - `/web/Apps/BatchSavePrint/?ws=true&batchmode=basic...`

This is a critical state transition. If the browser remains in BatchSavePrint instead of the research app, the automation cannot continue normal task filling until it returns to the research scope.

### 4.2 Query Page Structure

Confirmed query controls:

- company: `Search by company or portfolio`
- date range selector: `Date Range`
- contributor filter: `Contributors (Any)`
- industry filter: `Industry (Any)`
- country/region filter: `Countries/Regions (Any)`
- action buttons: `SEARCH` and `CLEAR`

Confirmed component types:

- company: `app-companies-filter emerald-multi-select`
- contributor: `app-contributors-filter emerald-multi-select`
- country/region: `app-regions-filter emerald-multi-select`
- industry: `app-industry-filter emerald-multi-select`
- date range dropdown: `app-date-range-filter coral-select`
- custom date popup: `app-date-range-filter app-date-picker-popup`
- date inputs inside popup: `emerald-datetime-picker` shadow inputs `#input` and `#input-to`

### 4.3 Results/Download Structure

Observed result/download area:

- row checkboxes
- select-all checkbox
- page-level `DOWNLOAD` button
- a later state containing `DOCUMENT INFORMATION`
- a later button `SAVE DOCUMENTS TO PC`

Important implication:

- the app has at least two UI modes after search:
  - result selection mode
  - document information / save-to-PC mode

If the automation clicks in the wrong mode, it can misfire or fail to capture downloads.

## 5. Actual Parameter Model

### 5.1 Global Fixed Filters

These are fixed across all tasks:

- contributor: `Morgan Stanley`
- country/region: `USA` / `United States of America`
- industry: none

Hard rule:

- `preferred contributors` must not be enabled.

### 5.2 Per-Task Mutable Filters

These change for each task:

- company
- ticker fallback
- custom date range from task file

### 5.3 Output Parameters

Per task, the system needs to emit:

- final status
- page count
- downloaded file path(s)
- source URL
- any error or anomaly note

## 6. Current Automation Coverage

### 6.1 What Already Works

In `scripts/lseg_rpa.py`, the current code already has working primitives for:

- parse task rows
- connect to browser over CDP
- detect the inner research frame
- wait for login/session readiness
- restart app on load failure
- apply contributor/country/industry filters through web-component state
- enforce unchecking preferred-contributor checkbox variants
- apply company via component injection and dropdown scoring
- apply date range through the custom popup and shadow DOM inputs
- return to query mode via `MODIFY QUERY CONDITIONS` / `MODIFY SEARCH CRITERIA`
- attempt bulk download
- attempt row-level fallback download
- write mapping CSV and JSONL logs

### 6.2 Semi-Automatic Production Flow

The actual stable workflow today is:

1. user opens a logged-in browser
2. script attaches over CDP
3. script fills company and date
4. script runs search
5. user manually reviews results
6. user manually downloads PDFs
7. user manually enters status and pages
8. script tries to recover downloaded PDFs from browser history and archive them by task

This means the current production path is not truly download-driven. It is still operator-confirmed.

## 7. Current Logic for Key Controls

### 7.1 Contributor Control

The automation:

- opens the contributor component directly
- forces include mode
- clears existing selections
- searches for `Morgan Stanley`
- selects exactly one matching label
- unchecks any checkbox whose label looks like `preferred contributor` or `preferred broker`

This is good, but the system still needs a postcondition stronger than current logging:

- selected label count must equal 1
- selected label must equal `Morgan Stanley`
- preferred checkbox count checked must equal 0

### 7.2 Company Control

The automation currently uses two paths:

- preferred path: manipulate `app-companies-filter emerald-multi-select` directly
- fallback path: type into visible input and choose from visible suggestions

Current component ranking logic:

- exact ticker value match gets highest score
- ticker with exchange suffix like `.N` is preferred next
- company exact label match is secondary
- label contains company name is a lower score

This is a reasonable start, but there is a major missing artifact:

- candidate list and final selection are not yet written into a reusable company-resolution knowledge base.

### 7.3 Date Control

The reliable date path is:

1. open `Date Range`
2. click `Custom...`
3. focus picker shadow input `#input`
4. type `DD-MMM-YYYY 00:00`
5. tab to `#input-to`
6. type `DD-MMM-YYYY 00:00`
7. click popup `OK`
8. verify summary contains both formatted dates

This is the strongest confirmed control path in the current codebase.

## 8. Network/API Clues From Action Logs

Observed request patterns:

- suggestion endpoint:
  - `/synapse/service/suggestions/suggest/?profile=ResearchAdvancedSearch&query=...`
- document cart polling:
  - `/Apps/DART/research-next/2.22.3/documentCart/userDocuments?...`
- report thumbnail fetches:
  - `/Apps/UDF/MsfBinary?...`
- app metadata/features:
  - `/Apps/AppFeaturesPublicAPI/Api/research-next/FeaturesMap`

Implications:

- company search is not a free local list; it is backed by a suggestion service
- result/download state likely has a server-backed document cart
- some download state may be inferable via network, not only via visible buttons

This is important for future full automation because UI-only polling will be brittle.

## 9. Real Failure Modes Seen In Logs

### 9.1 Query/Date Application Failure

Observed case:

- `T0054`
- `ok_company = true`
- `ok_from = false`
- `ok_to = false`

Meaning:

- company applied
- date picker confirmation or summary verification failed

This is a real production blocker and must become a first-class retry state, not just a logged failure.

### 9.2 Downloaded But No Archived File

Observed many records:

- mapping status `downloaded`
- no file archived
- note `archive_warning=no_pdf_found_since_task_prompt`

Meaning:

- human/operator reports a successful download
- archive recovery from browser history fails

This exposes a core weakness:

- current artifact capture is indirect
- the system does not truly own the download event

### 9.3 BatchSavePrint Scope Drift

Observed in runtime logs:

- startup sometimes sees current URL inside `BatchSavePrint`
- then the manual loop cannot immediately attach to research scope

Meaning:

- after download, the browser may remain in a different app context
- full automation must explicitly recover from this state before next task

### 9.4 Company Special Cases Hidden In Free-Text Notes

Observed examples:

- `AK Steel Holding Corp` tasks with note `退市`

Current problem:

- these are stored as `no_report` plus free-text note
- they are not normalized into a machine-actionable resolution type

This means historical operator knowledge is present, but not yet encoded.

### 9.5 File/Task Mismatch Risk

Observed archived files that do not obviously match the queried company:

- `AbbVie Inc` task archived a `GILD.OQ`-prefixed file
- `Abbott Laboratories` task archived `JNJ.N` and `NVRO.N` files in some cases

Interpretation:

- some result sets contain sector/peer/comp read-through reports, not only pure issuer reports
- querying by company/date alone does not guarantee one-company-only output

This is not necessarily wrong, but it means:

- "downloaded report" and "report belongs to exact company" are not the same condition

The full automation needs an explicit document-acceptance rule.

## 10. Boundary Conditions That Must Be Modeled Explicitly

### 10.1 Company Name Drift

Examples of drift types:

- company name differs from dropdown label
- ticker survives but issuer name changed
- `Corp` -> `plc` / `Ltd` / `LLC`
- private or delisted company
- post-merger rename

Required solution direction:

- maintain a persistent company resolution cache
- store for each task/company:
  - original company
  - ticker
  - dropdown candidates
  - chosen candidate
  - match type
  - confidence
  - resolution note

### 10.2 No Results In Time Window

Possible causes:

- no report exists
- exact company match wrong
- date filter not applied
- results exist but zero downloadable rows

Required statuses must stay separated:

- `filter_not_applied`
- `no_results`
- `no_rows`
- `no_downloadable_report`

### 10.3 Download Ambiguity

Possible cases:

- bulk select-all works
- bulk flow enters `DOCUMENT INFORMATION`
- save button appears late
- multiple files download
- page shows duplicate hidden buttons
- download event fires but file is not captured

Required solution direction:

- visible-only button policy
- explicit mode detection before clicking
- detect whether page is in result-selection mode or document-information mode
- direct file capture first
- browser-history recovery only as fallback

### 10.4 Session Expiry

Possible symptoms:

- login page
- signed-in-to-another-device page
- app frame never loads
- research page replaced by auth/session page

Required solution direction:

- a pause-and-recover state
- after user relogin, reattach CDP
- redetect research frame
- revalidate key controls before resuming the queued task

### 10.5 Daily Page Guard

Current limit is 500 pages/day in config.

Current weakness:

- automatic path estimates pages from row text
- semi-auto path trusts operator input

Required solution direction:

- keep a durable day ledger
- estimate before click
- reconcile after download if actual page counts become visible from filenames or PDF metadata
- stop before crossing limit, not after

## 11. Gaps Between Existing Code And Required Full Automation

### 11.1 Missing Explicit State Machine

The full automation still needs an explicit task state machine like:

- `attach_browser`
- `detect_scope`
- `recover_from_batchsaveprint`
- `ensure_query_mode`
- `apply_global_filters`
- `validate_global_filters`
- `apply_task_filters`
- `validate_task_filters`
- `run_search`
- `classify_results_state`
- `estimate_page_impact`
- `choose_download_strategy`
- `execute_download`
- `verify_download_artifacts`
- `archive_files`
- `write_final_status`
- `recover_or_retry`

### 11.2 Missing Persistent Company Resolution Memory

This is the main knowledge gap for automation quality.

The system currently resolves companies transiently. It does not learn across runs.

### 11.3 Missing Result Classification Layer

The current logic mainly distinguishes:

- no rows
- no results
- downloaded
- failed

It still needs a richer classifier for:

- wrong mode
- stale search state
- empty cart
- selection failed
- save dialog missing
- document info mode without selected rows

### 11.4 Missing Download Verification Ownership

Today the system does not own the download lifecycle end to end.

For true full automation it must:

- know which click should create which file set
- wait for those files
- verify they exist
- map them to the triggering task

## 12. Practical Design Constraints For v1 Full Automation

Recommended constraints for first full-automation build:

- keep `max_downloads=1` or another low debug value until one end-to-end path is verified
- default to the safest visible-control path
- avoid hidden duplicate buttons
- do not click `SAVE DOCUMENTS TO PC` unless the system first confirms it is in the correct UI mode
- persist every candidate/company/date/download decision to JSONL
- treat task completion as invalid unless the final artifact state is known

## 13. Known Unknowns

These still need live exploration with an active CDP session:

- exact DOM markers for:
  - result-selection mode
  - document-information mode
  - no-results text in the live current app version
  - BatchSavePrint recovery path
- whether download completion can be inferred from document-cart XHRs
- whether bulk download always goes through the same save app flow
- whether company dropdown exposes permanent IDs that are better than labels

## 14. Immediate Next Steps

1. add a persistent company-resolution knowledge store
2. add a formal UI state classifier for query/results/document-info/batch-save/auth
3. refactor the download flow into an explicit state machine with retries
4. promote archive recovery to fallback-only, not primary success signal
5. run a live CDP exploration session to capture current DOM markers for each state

## 15. 2026-05-03 Operational Update (CDP + BatchSavePrint)

### 15.1 Newly Confirmed Behavior

In current live runs, the click chain is often valid:

- select rows
- click `DOWNLOAD`
- click `Save Documents to PC`

But when automation remains attached over CDP after `BatchSavePrint` appears, PDF ownership becomes unreliable:

- browser disk/history may show download traces
- automation may miss the Playwright `download` event
- task is likely marked as `download_event_missing_or_page_closed` even though the site flow was triggered

### 15.2 Working Mitigation Rule

For full-automation runs attached via CDP:

1. keep normal in-page click flow
2. once `BatchSavePrint` is detected, immediately detach CDP session
3. allow native browser path to finish file landing
4. poll the configured/native download landing folders for up to 150 seconds
5. archive newly landed stable PDFs into `output/downloads/by_task/<taskId>/`
6. after landing completes, reconnect CDP and continue next task

This rule is now treated as an operational handoff strategy, not as a selector bug.

### 15.3 Implementation Notes

- A dedicated human-review note is used if no stable PDF appears after handoff:
  - `human_review_required:pdf_landing_timeout_after_batchsaveprint`
- Visible row re-filtering must use the result row `Date` field for the `ccDate..ccDate+7` event window, not `Available Date`.
- Main loop must support auto-reconnect before the next task.
- This is intentionally preferred over multi-page download-event listeners in the current project phase.

