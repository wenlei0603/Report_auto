# LSEG Research Next Automation

TypeScript + Playwright rewrite for fully automated LSEG Research Next report downloading.

The browser login remains manual. After login, the runner attaches to Chrome through CDP, applies the LSEG query filters, classifies result state, downloads selected reports, verifies PDF artifacts, and writes resumable logs.

## Setup

```powershell
npm install
```

Start Chrome with CDP:

```powershell
npm run browser:start
```

Log in to LSEG in that Chrome window, then verify the app state:

```powershell
npm run automation:inspect
```

Preview queued tasks without browser actions:

```powershell
npm run automation:dry-run -- --max-tasks 5
```

Run the automation with conservative limits from `config/lseg.yaml`:

```powershell
npm run dev -- run --max-tasks 1 --max-downloads 1
```

## Runtime Model

- `config/lseg.yaml` controls CDP endpoint, input file, output files, page limits, selectors, and download limits.
- `src/automation/engine.ts` owns the task state machine.
- `src/browser/` owns CDP attach, Research Next frame detection, UI state classification, filter control, and downloads.
- `src/domain/` owns task parsing, date formatting, and page guarding.
- `src/io/` owns JSONL, CSV, PDF inspection, and run logging.

## Outputs

- `logs/run_log.jsonl`: automation runtime events.
- `logs/task_status.jsonl`: final task statuses and artifact metadata.
- `output/task_progress.csv`: flattened task progress.
- `output/task_file_mapping.csv`: task-to-file mapping.
- `output/downloads/by_task/Txxxx/`: verified PDF artifacts.

## Verification

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

Live LSEG download behavior still requires an authenticated browser session and should be tested first with `--max-tasks 1 --max-downloads 1`.
