#!/usr/bin/env python
"""Reset stable manual-loop state files once, archiving existing progress first."""

from __future__ import annotations

import argparse
import csv
import shutil
from datetime import datetime
from pathlib import Path


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

MAPPING_FIELDS = [
    "timestamp",
    "task_id",
    "company",
    "date_from",
    "date_to",
    "report_title",
    "report_date",
    "pages",
    "file_path",
    "status",
    "error",
    "source_url",
]


def archive_if_exists(path: Path, archive_dir: Path, tag: str) -> Path | None:
    if not path.exists():
        return None
    archive_dir.mkdir(parents=True, exist_ok=True)
    target = archive_dir / f"{path.stem}_{tag}{path.suffix}"
    shutil.move(str(path), str(target))
    return target


def write_csv_header(path: Path, fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerow(fields)


def touch_empty(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Initialize stable manual-loop state files.")
    parser.add_argument("--status-log", default="logs/manual_task_status.jsonl")
    parser.add_argument("--progress-csv", default="output/manual_task_progress.csv")
    parser.add_argument("--mapping-csv", default="output/task_file_mapping.csv")
    parser.add_argument("--run-log-jsonl", default="logs/run_log.jsonl")
    args = parser.parse_args()

    tag = datetime.now().strftime("%Y%m%d_%H%M%S")
    archive_log_dir = Path("logs/archive")
    archive_output_dir = Path("output/archive")

    archived = []
    for raw in [args.status_log, args.run_log_jsonl]:
        moved = archive_if_exists(Path(raw), archive_log_dir, tag)
        if moved:
            archived.append(moved)
    for raw in [args.progress_csv, args.mapping_csv]:
        moved = archive_if_exists(Path(raw), archive_output_dir, tag)
        if moved:
            archived.append(moved)

    touch_empty(Path(args.status_log))
    touch_empty(Path(args.run_log_jsonl))
    write_csv_header(Path(args.progress_csv), PROGRESS_FIELDS)
    write_csv_header(Path(args.mapping_csv), MAPPING_FIELDS)

    print(f"Initialized manual loop state with tag: {tag}")
    if archived:
        print("Archived old files:")
        for path in archived:
            print(f"  {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
