#!/usr/bin/env python
"""Human-in-the-loop task driver for LSEG Research Next.

Flow:
1) Wait for the user to trigger the next task.
2) Auto-apply per-task company/date filters and click search.
3) User manually downloads/checks the result, then enters status and page count.
4) Persist progress and continue from that progress on the next launch.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import platform
import shutil
import sqlite3
import sys
import tempfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

ROOT_DIR = Path(__file__).resolve().parents[1]
DEPS_DIR = ROOT_DIR / ".deps"
if DEPS_DIR.exists() and str(DEPS_DIR) not in sys.path:
    sys.path.insert(0, str(DEPS_DIR))

import lseg_rpa as core  # noqa: E402


STATUS_COMPLETED = "downloaded"
STATUS_NO_REPORT = "no_report"
STATUS_FAILED = "task_failed"
STATUS_SPECIAL_COMPANY_CASE = "special_company_case"
STATUS_SKIPPED = "skipped"

FINAL_STATUSES = {STATUS_COMPLETED, STATUS_NO_REPORT, STATUS_FAILED, STATUS_SPECIAL_COMPANY_CASE}
CHROME_EPOCH = datetime(1601, 1, 1, tzinfo=timezone.utc)

PROGRESS_FIELDS = [
    "timestamp",
    "run_date",
    "task_id",
    "company",
    "date_from",
    "date_to",
    "status",
    "pages",
    "daily_total_pages",
    "day_page_limit",
    "note",
    "page_url",
]


def append_jsonl(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False) + "\n")


def iter_jsonl(path: Path) -> Iterable[dict]:
    if not path.exists():
        return []
    records: list[dict] = []
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            raw = line.strip()
            if not raw:
                continue
            try:
                records.append(json.loads(raw))
            except json.JSONDecodeError:
                continue
    return records


def ensure_progress_csv(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or path.stat().st_size == 0:
        with path.open("w", newline="", encoding="utf-8") as f:
            csv.DictWriter(f, fieldnames=PROGRESS_FIELDS).writeheader()
        return

    with path.open("r", newline="", encoding="utf-8", errors="ignore") as f:
        reader = csv.DictReader(f)
        old_fields = reader.fieldnames or []
        if old_fields == PROGRESS_FIELDS:
            return
        rows = list(reader)

    migrated: list[dict[str, str]] = []
    for row in rows:
        item = {field: str(row.get(field, "") or "") for field in PROGRESS_FIELDS}
        if not item["run_date"]:
            item["run_date"] = infer_run_date(item.get("timestamp", ""))
        if not item["pages"]:
            item["pages"] = "0"
        if not item["daily_total_pages"]:
            item["daily_total_pages"] = ""
        if not item["day_page_limit"]:
            item["day_page_limit"] = ""
        migrated.append(item)

    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=PROGRESS_FIELDS)
        writer.writeheader()
        writer.writerows(migrated)


def append_progress_csv(path: Path, payload: dict) -> None:
    with path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=PROGRESS_FIELDS)
        writer.writerow({field: payload.get(field, "") for field in PROGRESS_FIELDS})


def infer_run_date(timestamp: str) -> str:
    if not timestamp:
        return ""
    return timestamp[:10]


def record_run_date(item: dict) -> str:
    raw = str(item.get("run_date") or "").strip()
    if raw:
        return raw
    return infer_run_date(str(item.get("ts") or item.get("timestamp") or ""))


def record_pages(item: dict) -> int:
    raw = item.get("pages", 0)
    try:
        return max(int(raw), 0)
    except (TypeError, ValueError):
        return 0


def done_task_ids(status_log: Path) -> set[str]:
    done = set()
    for item in iter_jsonl(status_log):
        status = str(item.get("status", "")).strip().lower()
        task_id = str(item.get("task_id", "")).strip()
        if task_id and status in FINAL_STATUSES:
            done.add(task_id)
    return done


def daily_pages(status_log: Path, target_date: str) -> int:
    total = 0
    for item in iter_jsonl(status_log):
        if record_run_date(item) == target_date:
            total += record_pages(item)
    return total


def normalize_user_status(raw: str) -> str | None:
    txt = raw.strip().lower()
    mapping = {
        "1": STATUS_COMPLETED,
        "done": STATUS_COMPLETED,
        "ok": STATUS_COMPLETED,
        "completed": STATUS_COMPLETED,
        "downloaded": STATUS_COMPLETED,
        "2": STATUS_NO_REPORT,
        "no": STATUS_NO_REPORT,
        "no_report": STATUS_NO_REPORT,
        "none": STATUS_NO_REPORT,
        "3": STATUS_FAILED,
        "failed": STATUS_FAILED,
        "fail": STATUS_FAILED,
        "error": STATUS_FAILED,
        "5": STATUS_SPECIAL_COMPANY_CASE,
        "special": STATUS_SPECIAL_COMPANY_CASE,
        "special_company_case": STATUS_SPECIAL_COMPANY_CASE,
        "company_special_case": STATUS_SPECIAL_COMPANY_CASE,
        "delisted": STATUS_SPECIAL_COMPANY_CASE,
        "privatized": STATUS_SPECIAL_COMPANY_CASE,
        "private": STATUS_SPECIAL_COMPANY_CASE,
        "4": STATUS_SKIPPED,
        "skip": STATUS_SKIPPED,
        "s": STATUS_SKIPPED,
        "q": "quit",
        "quit": "quit",
        "exit": "quit",
    }
    return mapping.get(txt)


def status_for_mapping(status: str) -> str:
    if status == STATUS_COMPLETED:
        return "downloaded"
    if status == STATUS_NO_REPORT:
        return "no_downloadable_report"
    if status == STATUS_FAILED:
        return "task_failed"
    if status == STATUS_SPECIAL_COMPANY_CASE:
        return "special_company_case"
    return "task_failed"


def chrome_time(dt: datetime) -> int:
    if dt.tzinfo is None:
        dt = dt.astimezone()
    return int((dt.astimezone(timezone.utc) - CHROME_EPOCH).total_seconds() * 1_000_000)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def is_pdf(path: Path) -> bool:
    try:
        with path.open("rb") as f:
            return f.read(5) == b"%PDF-"
    except OSError:
        return False


def unique_destination(path: Path) -> Path:
    if not path.exists():
        return path
    stem = path.stem
    suffix = path.suffix
    for i in range(1, 1000):
        candidate = path.with_name(f"{stem} ({i}){suffix}")
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"Could not find available destination name for {path}")


def history_candidates(config: dict) -> list[Path]:
    candidates: list[Path] = []
    user_data_dir = str(config.get("browser", {}).get("user_data_dir") or "").strip()
    if user_data_dir:
        base = Path(user_data_dir)
        candidates.extend(
            [
                base / "Default" / "History",
                base / "History",
            ]
        )

    home = Path.home()
    system_name = platform.system()
    if system_name == "Darwin":
        candidates.extend(
            [
                home / "Library/Application Support/Microsoft Edge/Default/History",
                home / "Library/Application Support/Google/Chrome/Default/History",
            ]
        )
    elif system_name == "Windows":
        candidates.extend(
            [
                home / "AppData/Local/Microsoft/Edge/User Data/Default/History",
                home / "AppData/Local/Google/Chrome/User Data/Default/History",
            ]
        )

    seen: set[Path] = set()
    ordered: list[Path] = []
    for path in candidates:
        resolved = path.expanduser()
        if resolved in seen:
            continue
        seen.add(resolved)
        ordered.append(resolved)
    return ordered


def archive_task_downloads(config: dict, task: core.RequestTask, since: datetime, runner: core.Runner) -> list[Path]:
    history = next((path for path in history_candidates(config) if path.exists()), None)
    if history is None:
        runner.log_event(
            "WARN",
            "Browser history not found for download recovery",
            tried_paths=[str(path) for path in history_candidates(config)],
        )
        return []

    if not history.exists():
        runner.log_event("WARN", "Browser history not found for download recovery", history=str(history))
        return []

    tmp = Path(tempfile.gettempdir()) / f"edge_history_recovery_{task.task_id}.sqlite"
    try:
        shutil.copy2(history, tmp)
    except OSError as ex:
        runner.log_event("WARN", "Could not copy browser history for download recovery", error=str(ex))
        return []

    since_chrome = chrome_time(since)
    rows: list[tuple[str, str, str, int, int, int, str]] = []
    try:
        con = sqlite3.connect(tmp)
        try:
            rows = con.execute(
                """
                SELECT d.guid, d.current_path, d.target_path, d.received_bytes, d.total_bytes, d.state, COALESCE(u.url, '')
                FROM downloads d
                LEFT JOIN downloads_url_chains u ON d.id = u.id
                WHERE d.start_time >= ?
                ORDER BY d.start_time ASC
                """,
                (since_chrome,),
            ).fetchall()
        finally:
            con.close()
    except sqlite3.Error as ex:
        runner.log_event("WARN", "Could not read browser download history", error=str(ex))
        return []

    out_dir = Path(config.get("download_dir", "output/downloads")) / "by_task" / task.task_id
    out_dir.mkdir(parents=True, exist_ok=True)
    archived: list[Path] = []
    seen_hashes: set[str] = set()

    for guid, current_path, target_path, received, total, state, url in rows:
        candidates = [Path(current_path), Path(target_path)]
        src = next((p for p in candidates if p.exists() and is_pdf(p)), None)
        if src is None:
            continue
        if state != 1 or not src.exists() or not is_pdf(src):
            continue
        digest = sha256_file(src)
        if digest in seen_hashes:
            continue
        seen_hashes.add(digest)

        if src.suffix.lower() == ".pdf" and src.name != guid:
            filename = core.sanitize_filename(src.stem, max_len=180) + ".pdf"
        else:
            filename = core.sanitize_filename(
                f"{task.task_id}_{task.company}_{task.date_from.isoformat()}_{task.date_to.isoformat()}_{guid}",
                max_len=180,
            ) + ".pdf"

        dst = unique_destination(out_dir / filename)
        shutil.copy2(src, dst)
        archived.append(dst)
        runner.log_event(
            "INFO",
            "Archived task download",
            task_id=task.task_id,
            archived_path=str(dst),
            source_path=str(src),
            bytes=received,
            total_bytes=total,
            source_url=url,
        )

    return archived


def prompt_int(prompt: str, default: int = 0) -> int:
    while True:
        raw = input(prompt).strip()
        if not raw:
            return default
        try:
            value = int(raw)
        except ValueError:
            print("Invalid number. Enter an integer.")
            continue
        if value < 0:
            print("Invalid number. Enter 0 or greater.")
            continue
        return value


def prompt_window_text(task: core.RequestTask) -> str:
    prompt_start = task.cc_date
    prompt_end = task.cc_date + timedelta(days=7)
    return f"{prompt_start.isoformat()}..{prompt_end.isoformat()}"


def search_window_text(task: core.RequestTask) -> str:
    return f"{task.date_from.isoformat()}..{task.date_to.isoformat()}"


def prompt_status(task: core.RequestTask, default_pages: int = 0) -> tuple[str, int, str] | None:
    print("")
    print(f"[TASK] {task.task_id} | {task.company} | prompt {prompt_window_text(task)}")
    print(f"Search window: {search_window_text(task)}")
    print("Status: 1=downloaded  2=no_report  3=failed  4=skip  5=special_company_case  q=quit")
    while True:
        raw = input("Status > ").strip()
        code = normalize_user_status(raw)
        if code is None:
            print("Invalid status. Use 1/2/3/4/5/q.")
            continue
        if code == "quit":
            return None
        pages = prompt_int("Downloaded pages (default 0) > ", default_pages)
        note = input("Note (optional) > ").strip()
        return code, pages, note


def prompt_fill_trigger(task: core.RequestTask, used_pages: int, limit: int) -> str:
    print("")
    print(f"[NEXT] {task.task_id} | {task.company} | prompt {prompt_window_text(task)}")
    print(f"Search window: {search_window_text(task)}")
    print(f"Today pages: {used_pages}/{limit}")
    if used_pages >= limit:
        print(f"[WARN] Today page count has reached or exceeded {limit}.")
    print("Trigger: Enter=fill/search  s=skip  q=quit")
    while True:
        raw = input("Trigger > ").strip().lower()
        if raw in {"", "go", "g", "start", "run"}:
            return "go"
        if raw in {"s", "skip"}:
            return "skip"
        if raw in {"q", "quit", "exit"}:
            return "quit"
        print("Invalid trigger. Use Enter / s / q.")


def write_status(
    *,
    status_log: Path,
    progress_csv: Path,
    task: core.RequestTask,
    status: str,
    pages: int,
    daily_total: int,
    day_limit: int,
    note: str,
    page_url: str,
) -> dict:
    now = datetime.now().isoformat(timespec="seconds")
    payload = {
        "ts": now,
        "timestamp": now,
        "run_date": date.today().isoformat(),
        "task_id": task.task_id,
        "company": task.company,
        "date_from": task.date_from.isoformat(),
        "date_to": task.date_to.isoformat(),
        "status": status,
        "pages": pages,
        "daily_total_pages": daily_total,
        "day_page_limit": day_limit,
        "note": note,
        "page_url": page_url,
    }
    append_jsonl(status_log, payload)
    append_progress_csv(progress_csv, payload)
    return payload


def fill_task_once(config: dict, task: core.RequestTask, runner: core.Runner) -> tuple[dict[str, bool] | None, str]:
    """Attach only for the fill/search step, then let manual downloads happen outside Playwright."""
    if core.sync_playwright is None:
        raise RuntimeError("Playwright is not available. Check .deps/ or installation.")

    with core.sync_playwright() as pw:
        browser, _, page = core.open_workspace_page(pw, config, runner)
        behavior = config.get("behavior", {})

        if not bool(behavior.get("skip_initial_goto", False)):
            try:
                page.goto(config["workspace_url"], wait_until="domcontentloaded")
            except core.PlaywrightTimeoutError:
                runner.log_event("WARN", "Initial goto timeout; continue with current page")

        scope = core.wait_until_research_ready(
            page=page,
            runner=runner,
            timeout_seconds=int(behavior.get("login_wait_seconds", 600)),
            workspace_url=config["workspace_url"],
            max_restart_attempts=int(behavior.get("app_restart_attempts", 3)),
        )
        runner.log_event("INFO", "Manual loop attached for fill", scope_url=getattr(scope, "url", page.url))

        if not core.ensure_query_mode(page, config, runner):
            return None, page.url

        task_state = core.apply_task_filters(page, task, config, runner)
        page_url = page.url

        if not config.get("cdp_endpoint"):
            browser.close()

        return task_state, page_url


def main() -> int:
    parser = argparse.ArgumentParser(description="Manual status loop driver for LSEG tasks.")
    parser.add_argument("--config", default="config/config.yaml", help="Path to yaml config")
    parser.add_argument("--input", default=None, help="Override input task file")
    parser.add_argument("--status-log", default="logs/manual_task_status.jsonl", help="Manual task status log")
    parser.add_argument("--progress-csv", default="output/manual_task_progress.csv", help="Manual task progress csv")
    parser.add_argument("--start-from-task", default="", help="Optional task id to start from, e.g. T0100")
    parser.add_argument("--mapping-csv", default="", help="Optional override mapping csv path")
    parser.add_argument("--run-log-jsonl", default="", help="Optional override run log jsonl path")
    parser.add_argument("--day-page-limit", type=int, default=650, help="Daily manual page warning threshold")
    args = parser.parse_args()

    config = core.load_config(Path(args.config))
    config.setdefault("behavior", {})
    config["behavior"]["manual_setup_mode"] = True
    config["behavior"]["skip_initial_goto"] = True
    config["behavior"]["apply_global_filters_once"] = True

    if args.input:
        config["input_file"] = args.input
    if args.mapping_csv:
        config["mapping_csv"] = args.mapping_csv
    if args.run_log_jsonl:
        config["run_log_jsonl"] = args.run_log_jsonl

    input_file = Path(config["input_file"])
    if not input_file.exists():
        print(f"Input file not found: {input_file}", file=sys.stderr)
        return 2

    status_log = Path(args.status_log).resolve()
    progress_csv = Path(args.progress_csv).resolve()
    ensure_progress_csv(progress_csv)

    today = date.today().isoformat()
    used_pages = daily_pages(status_log, today)
    print(f"[INFO] Status log: {status_log}")
    print(f"[INFO] Progress csv: {progress_csv}")
    print(f"[INFO] Today pages: {used_pages}/{args.day_page_limit}")
    if used_pages >= args.day_page_limit:
        print(f"[WARN] Today page count has reached or exceeded {args.day_page_limit}.")

    lines = input_file.read_text(encoding="utf-8", errors="ignore").splitlines()
    tasks = core.parse_tasks(lines)
    if not tasks:
        print("No valid tasks found in input file.", file=sys.stderr)
        return 3

    if args.start_from_task:
        start_id = args.start_from_task.strip()
        filtered: list[core.RequestTask] = []
        started = False
        for task in tasks:
            if task.task_id == start_id:
                started = True
            if started:
                filtered.append(task)
        if not filtered:
            print(f"Task id not found: {start_id}", file=sys.stderr)
            return 4
        tasks = filtered

    done_ids = done_task_ids(status_log)
    pending = [task for task in tasks if task.task_id not in done_ids]
    if not pending:
        print("No pending tasks. All tasks already have final status.")
        return 0

    runner = core.Runner(config)
    runner.log_event(
        "INFO",
        "Manual loop start",
        total_tasks=len(tasks),
        pending_tasks=len(pending),
        status_log=str(status_log),
        progress_csv=str(progress_csv),
        day_page_limit=args.day_page_limit,
        today_pages=used_pages,
    )

    if core.sync_playwright is None:
        print("Playwright is not available. Check .deps/ or installation.", file=sys.stderr)
        return 5

    current_page_url = config["workspace_url"]
    for task in pending:
        used_pages = daily_pages(status_log, today)
        trigger = prompt_fill_trigger(task, used_pages, args.day_page_limit)
        archived_paths: list[Path] = []
        if trigger == "quit":
            runner.log_event("INFO", "Manual loop stopped by user before filling task", task_id=task.task_id)
            break

        if trigger == "skip":
            status = STATUS_SKIPPED
            pages = 0
            note = "manual_skip_before_fill"
        else:
            runner.log_event(
                "INFO",
                f"Prepare task {task.task_id}",
                company=task.company,
                date_from=task.date_from.isoformat(),
                date_to=task.date_to.isoformat(),
            )

            task_state, current_page_url = fill_task_once(config, task, runner)
            if task_state is None:
                status = STATUS_FAILED
                pages = 0
                note = "query_mode_unavailable"
            else:
                if not all(task_state.values()):
                    status = STATUS_FAILED
                    pages = 0
                    note = f"filter_not_applied:{json.dumps(task_state, ensure_ascii=False)}"
                else:
                    download_window_start = datetime.now(timezone.utc)
                    user_result = prompt_status(task)
                    if user_result is None:
                        runner.log_event("INFO", "Manual loop stopped by user")
                        break
                    status, pages, note = user_result
                    if status == STATUS_COMPLETED:
                        archived_paths = archive_task_downloads(config, task, download_window_start, runner)
                        if archived_paths:
                            archived_note = "archived_files=" + ";".join(str(p) for p in archived_paths)
                            note = f"{note}; {archived_note}" if note else archived_note
                        else:
                            missing_note = "archive_warning=no_pdf_found_since_task_prompt"
                            note = f"{note}; {missing_note}" if note else missing_note

        previous_total = daily_pages(status_log, today)
        new_total = previous_total + pages
        payload = write_status(
            status_log=status_log,
            progress_csv=progress_csv,
            task=task,
            status=status,
            pages=pages,
            daily_total=new_total,
            day_limit=args.day_page_limit,
            note=note,
            page_url=current_page_url,
        )

        if status in FINAL_STATUSES:
            runner.append_mapping(
                task=task,
                report_title="",
                report_date="",
                pages=pages,
                file_path=";".join(str(p) for p in archived_paths),
                status=status_for_mapping(status),
                error=note,
                source_url=current_page_url,
            )

        runner.log_event(
            "INFO",
            "Task status saved",
            task_id=task.task_id,
            status=status,
            pages=pages,
            daily_total_pages=new_total,
            day_page_limit=args.day_page_limit,
            note=note,
        )

        print(f"[SAVED] {payload['task_id']} status={status} pages={pages} today={new_total}/{args.day_page_limit}")
        if previous_total < args.day_page_limit <= new_total:
            print(f"[WARN] Today page count reached {new_total}/{args.day_page_limit}.")
        elif new_total > args.day_page_limit:
            print(f"[WARN] Today page count is over limit: {new_total}/{args.day_page_limit}.")

    runner.log_event("INFO", "Manual loop finished")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
