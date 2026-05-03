#!/usr/bin/env python
"""Create a modified copy of the LSEG task dataset with systematic date windows."""

from __future__ import annotations

import argparse
import csv
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path


DATE_FMT = "%d-%b-%Y %H:%M"


@dataclass(frozen=True)
class RowTransform:
    cc_date: datetime
    window_start: datetime
    window_end: datetime


def parse_datetime(value: str) -> datetime:
    text = value.strip()
    for fmt in (DATE_FMT, "%d-%b-%Y", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    raise ValueError(f"Unsupported datetime format: {value}")


def format_datetime(value: datetime) -> str:
    return value.strftime(DATE_FMT)


def build_output_path(input_path: Path, suffix: str) -> Path:
    if input_path.suffix:
        return input_path.with_name(f"{input_path.stem}{suffix}{input_path.suffix}")
    return input_path.with_name(f"{input_path.name}{suffix}")


def transform_row(
    row: dict[str, str],
    *,
    from_anchor_column: str,
    to_anchor_column: str,
    from_offset_days: int,
    to_offset_days: int,
) -> dict[str, str]:
    cc_date = parse_datetime(row["cc_date"])
    window_start = parse_datetime(row["window_start"])
    window_end = parse_datetime(row["window_end"])
    bundle = RowTransform(cc_date=cc_date, window_start=window_start, window_end=window_end)

    from_anchor_value = getattr(bundle, from_anchor_column)
    to_anchor_value = getattr(bundle, to_anchor_column)

    row["window_start"] = format_datetime(from_anchor_value + timedelta(days=from_offset_days))
    row["window_end"] = format_datetime(to_anchor_value + timedelta(days=to_offset_days))
    return row


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="Source TSV dataset path")
    parser.add_argument("--output", help="Destination TSV dataset path")
    parser.add_argument(
        "--from-anchor-column",
        choices=("cc_date", "window_start", "window_end"),
        default="cc_date",
        help="Column used as the base date for the new window_start",
    )
    parser.add_argument(
        "--to-anchor-column",
        choices=("cc_date", "window_start", "window_end"),
        default="cc_date",
        help="Column used as the base date for the new window_end",
    )
    parser.add_argument(
        "--from-offset-days",
        type=int,
        required=True,
        help="Days added to anchor_column for the new window_start",
    )
    parser.add_argument(
        "--to-offset-days",
        type=int,
        required=True,
        help="Days added to anchor_column for the new window_end",
    )
    parser.add_argument(
        "--suffix",
        default="_window_modified",
        help="Suffix for auto-generated output filenames when --output is omitted",
    )
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve() if args.output else build_output_path(input_path, args.suffix)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with input_path.open("r", encoding="utf-8-sig", newline="") as src:
        reader = csv.DictReader(src, delimiter="\t")
        if reader.fieldnames is None:
            raise ValueError("Input file is missing a header row.")

        expected = {"permno", "companyname", "tickers", "cc_date", "window_start", "window_end"}
        missing = expected.difference(reader.fieldnames)
        if missing:
            missing_cols = ", ".join(sorted(missing))
            raise ValueError(f"Input file is missing required columns: {missing_cols}")

        rows = [
            transform_row(
                dict(row),
                from_anchor_column=args.from_anchor_column,
                to_anchor_column=args.to_anchor_column,
                from_offset_days=args.from_offset_days,
                to_offset_days=args.to_offset_days,
            )
            for row in reader
        ]

    with output_path.open("w", encoding="utf-8", newline="") as dst:
        writer = csv.DictWriter(dst, fieldnames=reader.fieldnames, delimiter="\t")
        writer.writeheader()
        writer.writerows(rows)

    print(f"Created dataset copy: {output_path}")
    print(
        "Window rule: "
        f"{args.from_anchor_column} + {args.from_offset_days} days -> window_start, "
        f"{args.to_anchor_column} + {args.to_offset_days} days -> window_end"
    )
    print(f"Rows written: {len(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
