# LSEG Research Next Manual Download Assistant

This workspace supports a human-in-the-loop workflow for downloading LSEG Research Next reports. The script controls only the repetitive query setup:

- company selection
- custom date range
- search trigger
- progress logging
- daily page-count warning

You still manually review the results, download documents, and enter the task status/page count.

## Main Workflow

Use this for normal multi-day work:

```powershell
.\start_manual_loop.bat
```

On macOS:

```bash
bash ./start_manual_loop.sh
```

What it does:

- Checks whether Chrome CDP is already available at `http://127.0.0.1:9222/json/version`.
- If not available, starts Chrome with:
  - `--remote-debugging-port=9222`
  - `--user-data-dir="D:\chrome-rpa-profile"`
  - the LSEG Research Next URL from the project notes.
- Connects to the existing Chrome session.
- Reads tasks from `D:\20-temp\0422\lseg_request_by_call_2015_2018_end_plus_7d.txt`.
- Skips tasks that already have a final status in `logs/manual_task_status.jsonl`.
- Waits for your manual trigger before each task.

Per-task interaction:

```text
Trigger > Enter   fills company/date and runs search
Trigger > s       skips this task for now
Trigger > q       exits

Prompt window      shows `cc_date .. cc_date+7d` for operator reference
Search window      still uses dataset `window_start .. window_end`

Status > 1        downloaded
Status > 2        no_report
Status > 3        failed
Status > 4        skip
Status > 5        special_company_case (e.g. privatized/delisted)
Status > q        exits

Downloaded pages > enter the page count you downloaded manually
Note > optional note
```

## Daily Page Limit

The manual loop tracks pages by calendar date using the page counts you enter.

- Default daily warning threshold: `650` pages.
- The script prints the current daily total at startup and before each task.
- When the daily total reaches or exceeds `650`, it prints a `[WARN]` message and records the total in the logs.

The daily page count is calculated from:

```text
logs/manual_task_status.jsonl
```

Each status record includes:

- `run_date`
- `task_id`
- `company`
- `date_from`
- `date_to`
- `status`
- `pages`
- `daily_total_pages`
- `day_page_limit`
- `note`
- `page_url`

## Stable Output Files

Normal daily runs reuse these files:

- Status log: `logs/manual_task_status.jsonl`
- Progress CSV: `output/manual_task_progress.csv`
- Task mapping CSV: `output/task_file_mapping.csv`
- Run log: `logs/run_log.jsonl`

These files are intentionally stable so the work can continue across multiple days.

## Reinitializing All Tasks

Use this only when you want to restart the entire process from the first task:

```powershell
.\init_manual_loop_state.bat
```

On macOS:

```bash
bash ./init_manual_loop_state.sh
```

It requires typing:

```text
RESET
```

Then it archives the current stable files and creates clean replacements.

Archived files go to:

- `logs/archive/`
- `output/archive/`

## Optional New-Run Button

This button creates timestamped output files for an isolated run:

```powershell
.\start_manual_loop_new_run.bat
```

On macOS:

```bash
bash ./start_manual_loop_new_run.sh
```

This is not the default daily workflow. Use it only when you want a separate one-off batch with timestamped logs.

## Configuration

Main config:

```text
config/config.yaml
```

macOS example config:

```text
config/config.macos.example.yaml
```

Important fields:

- `workspace_url`: LSEG Research Next URL.
- `input_file`: task input file.
- `cdp_endpoint`: Chrome CDP endpoint, normally `http://127.0.0.1:9222`.
- `selectors`: UI selectors used by the automation.

For macOS setup:

- Copy `config/config.macos.example.yaml` to `config/config.macos.yaml`.
- Update `input_file` to the dataset location on your Mac.
- Keep `browser.user_data_dir` aligned with the profile launched by `start_manual_loop.sh`.

The manual loop forces these runtime behavior settings:

- `manual_setup_mode = true`
- `skip_initial_goto = true`
- `apply_global_filters_once = true`

This means you should manually set global filters in the UI before running tasks:

- Contributor: Morgan Stanley only
- Country/Region: USA
- Industry: none
- Do not enable preferred contributors

## Scripts

- `scripts/manual_loop_driver.py`: main human-in-the-loop driver.
- `scripts/init_manual_loop_state.py`: archives and resets stable progress files.
- `scripts/lseg_rpa.py`: underlying automation helpers and legacy full automation path.
- `scripts/action_recorder.py`: optional UI recorder for discovering selectors/components.

## Advanced Commands

Run the manual loop directly:

```powershell
$env:PYTHONPATH = (Resolve-Path .deps).Path
.\.venv\Scripts\python.exe scripts\manual_loop_driver.py --config config\config.yaml --day-page-limit 650
```

macOS:

```bash
PYTHONPATH="$(pwd)/.deps" ./.venv/bin/python scripts/manual_loop_driver.py --config config/config.macos.yaml --day-page-limit 650
```

Start from a specific task:

```powershell
$env:PYTHONPATH = (Resolve-Path .deps).Path
.\.venv\Scripts\python.exe scripts\manual_loop_driver.py --config config\config.yaml --start-from-task T0100 --day-page-limit 650
```

macOS:

```bash
PYTHONPATH="$(pwd)/.deps" ./.venv/bin/python scripts/manual_loop_driver.py --config config/config.macos.yaml --start-from-task T0100 --day-page-limit 650
```

Change the daily warning threshold:

```powershell
$env:PYTHONPATH = (Resolve-Path .deps).Path
.\.venv\Scripts\python.exe scripts\manual_loop_driver.py --config config\config.yaml --day-page-limit 600
```

macOS:

```bash
PYTHONPATH="$(pwd)/.deps" ./.venv/bin/python scripts/manual_loop_driver.py --config config/config.macos.yaml --day-page-limit 600
```

Legacy dry run for task parsing:

```powershell
$env:PYTHONPATH = (Resolve-Path .deps).Path
.\.venv\Scripts\python.exe scripts\lseg_rpa.py --config config\config.yaml --dry-run
```

macOS:

```bash
PYTHONPATH="$(pwd)/.deps" ./.venv/bin/python scripts/lseg_rpa.py --config config/config.macos.yaml --dry-run
```

## Notes

- The startup scripts use a persistent browser profile so login/session state can survive restarts.
- If the LSEG session expires, log in again in the Chrome window, then continue from the terminal prompt.
- The script only knows page counts that you manually enter after each task.
- `skipped` tasks are not final; they will appear again in later runs unless they are later recorded as `downloaded`, `no_report`, or `task_failed`.
