# RPA Control Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a configurable Windows control panel for opening CDP browsers, generating folder-based queues, starting 700-page download runs, checking status, and stopping node runners.

**Architecture:** Keep the existing downloader unchanged. Add a JSON config for worker ports, a Node helper for queue/config/status/process operations, and a PowerShell Windows Forms GUI that calls the helper and existing CLI.

**Tech Stack:** Node.js ESM, YAML package already in dependencies, PowerShell Windows Forms, existing TypeScript CLI.

---

### Task 1: Config And Helper

**Files:**
- Create: `config/rpa-control-panel.json`
- Create: `scripts/rpa-control-helper.mjs`

- [ ] **Step 1: Add operator config**

Create `config/rpa-control-panel.json` with defaults for task file, download directory, page limit, stop-on-limit behavior, and worker ports `9222` and `9223`.

- [ ] **Step 2: Implement helper commands**

Implement `scripts/rpa-control-helper.mjs` commands:

- `make-run-config --config <file> --port-id <id> --start-task <task> --task-file <file> --page-limit <n>`
- `status --status-log <file> --run-log <file> --download-dir <dir> --config-path <file>`
- `runner-pids --config-path <file>`

The helper writes sparse task queues preserving `Txxxx`, excludes non-empty `output/downloads/by_task` folders, and generates per-run YAML configs.

- [ ] **Step 3: Verify helper**

Run:

```powershell
node scripts/rpa-control-helper.mjs make-run-config --config config/rpa-control-panel.json --port-id 9222 --start-task T0362 --task-file lseg_request_by_call_2015_2018_end_plus_7d.txt --page-limit 700
node scripts/rpa-control-helper.mjs status --config-path output/run_configs/gui_9222_latest.yaml
```

Expected: JSON summaries with generated queue/config paths and readable status output.

- [ ] **Step 4: Commit**

```powershell
git add config/rpa-control-panel.json scripts/rpa-control-helper.mjs
git commit -m "feat: add RPA control helper"
```

### Task 2: PowerShell GUI

**Files:**
- Create: `scripts/rpa-control-panel.ps1`
- Create: `RPA-Control-Panel.bat`

- [ ] **Step 1: Build Windows Forms panel**

Create a PowerShell Windows Forms GUI that loads `config/rpa-control-panel.json`, renders a row per port, and exposes fields for start task, task file, and page limit.

- [ ] **Step 2: Wire actions**

Buttons call:

- `scripts/start-chrome-cdp.ps1` for Open Browser.
- `node dist/src/cli.js -c <generated-config> inspect` for Inspect Login.
- `node scripts/rpa-control-helper.mjs make-run-config ...` then `Start-Process node dist/src/cli.js -c <generated-config> run` for Start Download.
- `Stop-Process` for Stop Runner using helper-discovered PIDs.
- Helper `status` for Status.

- [ ] **Step 3: Add launcher**

Create `RPA-Control-Panel.bat` that opens the PowerShell GUI from the repo root.

- [ ] **Step 4: Commit**

```powershell
git add scripts/rpa-control-panel.ps1 RPA-Control-Panel.bat
git commit -m "feat: add RPA control panel GUI"
```

### Task 3: Verification

**Files:**
- Modify only if verification finds a defect.

- [ ] **Step 1: Run parser and helper checks**

Run helper queue generation and load generated queue with `dist/src/domain/tasks.js`.

- [ ] **Step 2: Run project checks**

Run:

```powershell
npm run typecheck
npm test
```

- [ ] **Step 3: Validate PowerShell syntax**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "$null = [scriptblock]::Create((Get-Content scripts/rpa-control-panel.ps1 -Raw)); 'ok'"
```

- [ ] **Step 4: Commit fixes if needed**

Use a focused commit such as:

```powershell
git commit -m "fix: harden RPA control panel launch"
```
