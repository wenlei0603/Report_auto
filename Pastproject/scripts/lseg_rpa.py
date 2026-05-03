#!/usr/bin/env python
"""LSEG Workspace research report downloader (RPA-like automation).

Key capabilities:
- Read company/date windows from text file
- Connect to an existing Chrome via CDP (remote debugging), or launch fallback browser
- Apply filters (broker/country/company/date)
- Download reports with page-limit guard (default 500 pages/day)
- Write task-file mapping CSV and structured JSONL logs
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import platform
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, date
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable, Optional

try:
    import yaml
except ImportError:
    yaml = None

try:
    from playwright.sync_api import (
        Browser,
        BrowserContext,
        Error,
        Page,
        Playwright,
        TimeoutError as PlaywrightTimeoutError,
        sync_playwright,
    )
except ImportError:
    if TYPE_CHECKING:
        from playwright.sync_api import Browser, BrowserContext, Page, Playwright  # pragma: no cover
    Browser = BrowserContext = Page = Playwright = Any  # type: ignore[assignment]
    Error = Exception
    PlaywrightTimeoutError = Exception
    sync_playwright = None


def get_scope_page(scope):
    if hasattr(scope, "keyboard"):
        return scope
    if hasattr(scope, "page"):
        return scope.page
    raise RuntimeError("Cannot resolve page from scope")


def focus_target(target) -> None:
    try:
        target.click(timeout=1200)
        return
    except Error:
        pass
    try:
        target.click(timeout=1200, force=True)
        return
    except Error:
        pass
    try:
        target.focus()
    except Error:
        pass


DEFAULT_CONFIG = {
    "workspace_url": "https://workspace.refinitiv.com/web/Apps/research-next/?st=OAPermID#/?st=OAPermID",
    "input_file": r"D:\\20-temp\\0422\\lseg_request_by_call_2015_2018_end_plus_7d.txt",
    "download_dir": "output/downloads",
    "mapping_csv": "output/task_file_mapping.csv",
    "run_log_jsonl": "logs/run_log.jsonl",
    "daily_page_limit": 500,
    "max_downloads": 1,
    "cdp_endpoint": "http://127.0.0.1:9222",
    "browser": {
        "headless": False,
        "slow_mo_ms": 200,
        "fallback_channel": "chrome",
    },
    "filters": {
        "broker": "Morgan Stanley",
        "country": "USA",
        "industry_id": "none",
    },
    "behavior": {
        "apply_global_filters_once": True,
        "skip_task_when_no_results": True,
        "login_wait_seconds": 600,
        "app_restart_attempts": 3,
        "manual_setup_mode": False,
        "skip_initial_goto": False,
    },
    "selectors": {
        "company_input": [
            "input[placeholder*='Search by company or portfolio' i]",
            "input[placeholder*='company or portfolio' i]",
            "input[placeholder*='Company' i]",
            "input[aria-label*='Company' i]",
            "[data-testid*='company' i] input",
        ],
        "company_option_items": [
            "[role='option']",
            "li[role='option']",
            ".suggestion-item",
            "[class*='suggest' i] li",
            "[data-testid*='option' i]",
        ],
        "broker_input": [
            "xpath=//*[normalize-space()='Contributors']/following::input[1]",
            "input[placeholder*='Contributors (Any)' i]",
            "input[placeholder*='Contributors' i]",
            "input[placeholder*='Broker' i]",
            "input[aria-label*='Broker' i]",
            "[data-testid*='broker' i] input",
        ],
        "country_input": [
            "xpath=//*[normalize-space()='Countries/Regions']/following::input[1]",
            "input[placeholder*='Countries/Regions (Any)' i]",
            "input[placeholder*='Countries/Regions' i]",
            "input[placeholder*='Country' i]",
            "input[aria-label*='Country' i]",
            "[data-testid*='country' i] input",
        ],
        "industry_id_input": [
            "xpath=//*[normalize-space()='Industry']/following::input[1]",
            "input[placeholder*='Industry (Any)' i]",
            "input[placeholder*='Industry' i]",
            "input[placeholder*='Industry' i]",
            "input[aria-label*='Industry' i]",
            "[data-testid*='industry' i] input",
        ],
        "from_date_input": [
            "input[placeholder*='From' i]",
            "input[aria-label*='From' i]",
            "input[name*='from' i]",
        ],
        "to_date_input": [
            "input[placeholder*='To' i]",
            "input[aria-label*='To' i]",
            "input[name*='to' i]",
        ],
        "apply_buttons": [
            "button:has-text('UPDATE')",
            "button:has-text('Apply')",
            "button:has-text('Search')",
            "button:has-text('Run')",
        ],
        "modify_query_buttons": [
            "button:has-text('MODIFY QUERY CONDITIONS')",
            "button:has-text('MODIFY SEARCH CRITERIA')",
            "button:has-text('Modify query conditions')",
            "button:has-text('Modify search criteria')",
            "a:has-text('MODIFY QUERY CONDITIONS')",
            "a:has-text('MODIFY SEARCH CRITERIA')",
            "text=/modify\\s+(query\\s+conditions|search\\s+criteria)/i",
        ],
        "result_rows": [
            "table tbody tr:visible",
            "[data-testid*='result' i] [role='row']",
            "[role='rowgroup'] [role='row']:visible",
            "table tbody tr",
            "[role='rowgroup'] [role='row']",
        ],
        "next_page_buttons": [
            "button[aria-label*='Next' i]",
            "button:has-text('Next')",
        ],
        "download_buttons": [
            "button:has-text('DOWNLOAD')",
            "button:has-text('Download')",
            "a:has-text('Download')",
            "button[aria-label*='download' i]",
            "a[href*='.pdf' i]",
        ],
        "select_all_checkboxes": [
            "coral-checkbox.select-doc-checkbox",
            "input[aria-label*='Select all' i]",
            "[aria-label*='Select all' i]",
        ],
        "save_to_pc_buttons": [
            "button:has-text('SAVE DOCUMENTS TO PC')",
            "button:has-text('Save Documents to PC')",
            "button:has-text('Save to my PC')",
            "button:has-text('SAVE TO MY PC')",
        ],
        "pages_text": [
            "text=/\\b\\d+\\s*pages?\\b/i",
        ],
        "report_title": [
            "[data-testid*='title' i]",
            "h1",
            "h2",
            "[role='heading']",
        ],
        "report_date": [
            "[data-testid*='date' i]",
            "time",
            "text=/\\b(20\\d{2}[-/]\\d{1,2}[-/]\\d{1,2}|\\d{1,2}[-/]\\d{1,2}[-/]20\\d{2})\\b/",
        ],
        "no_results_text": [
            "text=/\\bNo results\\b/i",
            "text=/\\b0 results\\b/i",
            "text=/\\bNo matching\\b/i",
            "text=/\\bNothing found\\b/i",
        ],
    },
    "timeouts": {
        "default_ms": 20000,
        "download_ms": 60000,
    },
}


def resolve_config_path(value: str, *, base_dir: Path | None = None) -> Path:
    expanded = os.path.expandvars(os.path.expanduser(value))
    path = Path(expanded)
    if not path.is_absolute() and base_dir is not None:
        path = base_dir / path
    return path.resolve()


@dataclass
class RequestTask:
    task_id: str
    company: str
    ticker: str
    cc_date: date
    date_from: date
    date_to: date
    raw_line: str


class Runner:
    def __init__(self, config: dict):
        self.config = config
        self.download_dir = Path(config["download_dir"]).resolve()
        self.mapping_csv = Path(config["mapping_csv"]).resolve()
        self.log_jsonl = Path(config["run_log_jsonl"]).resolve()
        self.page_limit = int(config["daily_page_limit"])
        self.page_used = 0
        self.max_downloads = int(config.get("max_downloads", 0))
        self.downloaded_files = 0
        self.date_today = datetime.now().date().isoformat()

        self.download_dir.mkdir(parents=True, exist_ok=True)
        self.mapping_csv.parent.mkdir(parents=True, exist_ok=True)
        self.log_jsonl.parent.mkdir(parents=True, exist_ok=True)

        self._ensure_mapping_header()

    def _ensure_mapping_header(self) -> None:
        if self.mapping_csv.exists() and self.mapping_csv.stat().st_size > 0:
            return
        with self.mapping_csv.open("w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(
                [
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
            )

    def log_event(self, level: str, message: str, **extra: object) -> None:
        payload = {
            "ts": datetime.now().isoformat(timespec="seconds"),
            "level": level,
            "message": message,
            "page_used": self.page_used,
            "page_limit": self.page_limit,
            **extra,
        }
        with self.log_jsonl.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")
        print(f"[{payload['ts']}] {level:<5} {message}")

    def append_mapping(
        self,
        *,
        task: RequestTask,
        report_title: str,
        report_date: str,
        pages: int,
        file_path: str,
        status: str,
        error: str = "",
        source_url: str = "",
    ) -> None:
        with self.mapping_csv.open("a", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(
                [
                    datetime.now().isoformat(timespec="seconds"),
                    task.task_id,
                    task.company,
                    task.date_from.isoformat(),
                    task.date_to.isoformat(),
                    report_title,
                    report_date,
                    pages,
                    file_path,
                    status,
                    error,
                    source_url,
                ]
            )


def deep_merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for key, value in override.items():
        if key in out and isinstance(out[key], dict) and isinstance(value, dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def sanitize_filename(name: str, max_len: int = 140) -> str:
    cleaned = re.sub(r"[\\/:*?\"<>|]+", "_", name)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    if not cleaned:
        cleaned = "report"
    return cleaned[:max_len]


def parse_date(raw: str) -> date:
    txt = raw.strip()
    for fmt in ("%d-%b-%Y %H:%M", "%d-%b-%Y", "%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(txt, fmt).date()
        except ValueError:
            continue

    normalized = txt.replace(".", "/").replace("-", "/")
    for fmt in ("%Y/%m/%d", "%m/%d/%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(normalized, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"Unsupported date format: {txt}")


def parse_tasks(lines: Iterable[str]) -> list[RequestTask]:
    tasks: list[RequestTask] = []
    for idx, line in enumerate(lines, start=1):
        raw = line.strip()
        if not raw or raw.startswith("#"):
            continue

        # TSV rows like:
        # permno companyname tickers cc_date window_start window_end
        parts = [p.strip() for p in raw.split("\t")]
        if len(parts) >= 6:
            company = parts[1]
            ticker = parts[2] if len(parts) >= 3 else ""
            try:
                cc_date = parse_date(parts[3])
                d1 = parse_date(parts[4])
                d2 = parse_date(parts[5])
            except ValueError:
                cc_date = d1 = d2 = None
            if cc_date is not None and d1 is not None and d2 is not None:
                date_from, date_to = (d1, d2) if d1 <= d2 else (d2, d1)
                tasks.append(
                    RequestTask(
                        task_id=f"T{idx:04d}",
                        company=company or f"UNKNOWN_{idx}",
                        ticker=ticker,
                        cc_date=cc_date,
                        date_from=date_from,
                        date_to=date_to,
                        raw_line=raw,
                    )
                )
                continue

        date_hits = list(
            re.finditer(
                r"(20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]20\d{2}|\d{1,2}-[A-Za-z]{3}-20\d{2}(?:\s+\d{2}:\d{2})?)",
                raw,
            )
        )
        if len(date_hits) < 2:
            continue

        d1 = parse_date(date_hits[0].group(1))
        d2 = parse_date(date_hits[1].group(1))
        date_from, date_to = (d1, d2) if d1 <= d2 else (d2, d1)

        company_part = raw[: date_hits[0].start()].strip(" ,|\t;:-")
        if not company_part:
            tail = raw[date_hits[1].end() :].strip(" ,|\t;:-")
            company_part = tail or f"UNKNOWN_{idx}"

        tasks.append(
            RequestTask(
                task_id=f"T{idx:04d}",
                company=company_part,
                ticker="",
                cc_date=date_from,
                date_from=date_from,
                date_to=date_to,
                raw_line=raw,
            )
        )
    return tasks


def first_visible_locator(page_or_scope, selectors: list[str]):
    for sel in selectors:
        loc = page_or_scope.locator(sel)
        try:
            if loc.count() > 0 and loc.first.is_visible(timeout=1200):
                return loc.first
        except Error:
            continue
    return None


def fill_filter(page: Page, selectors: list[str], value: str) -> bool:
    target = first_visible_locator(page, selectors)
    if target is None:
        return False
    scope_page = get_scope_page(page)
    focus_target(target)
    try:
        target.fill("")
    except Error:
        pass
    target.fill(value)
    scope_page.keyboard.press("Enter")
    return True


def read_input_value(scope, selectors: list[str]) -> str:
    target = first_visible_locator(scope, selectors)
    if target is None:
        return ""
    try:
        return (target.input_value(timeout=1000) or "").strip()
    except Error:
        try:
            return (target.evaluate("el => (el.value || '').toString()") or "").strip()
        except Error:
            return ""


def clear_input_value(scope, target) -> None:
    scope_page = get_scope_page(scope)
    focus_target(target)
    try:
        target.press("Control+A")
        target.press("Backspace")
    except Error:
        pass
    try:
        target.fill("")
    except Error:
        pass
    try:
        scope_page.keyboard.press("Control+A")
        scope_page.keyboard.press("Backspace")
    except Error:
        pass


def select_option_by_terms(scope, option_selectors: list[str], terms: list[str]) -> bool:
    wanted = [t.strip().lower() for t in terms if t and t.strip()]
    if not wanted:
        return False
    targets = [scope]
    try:
        targets.append(get_scope_page(scope))
    except Exception:  # noqa: BLE001
        pass

    for target in targets:
        for sel in option_selectors:
            loc = target.locator(sel)
            count = min(loc.count(), 24)
            for i in range(count):
                item = loc.nth(i)
                try:
                    if not item.is_visible(timeout=200):
                        continue
                    txt = (item.inner_text(timeout=250) or "").strip().lower()
                    if not txt:
                        continue
                    if any(t in txt for t in wanted):
                        item.click(timeout=800)
                        return True
                except Error:
                    continue
    return False


def set_filter_or_clear(
    scope,
    selectors: list[str],
    value: Optional[str],
    *,
    option_terms: Optional[list[str]] = None,
    allow_keyboard_fallback: bool = True,
) -> bool:
    target = first_visible_locator(scope, selectors)
    if target is None:
        return False
    scope_page = get_scope_page(scope)
    clear_input_value(scope, target)
    if value is None or str(value).strip().lower() in {"", "none", "(none)"}:
        scope_page.keyboard.press("Enter")
        return True
    q = str(value).strip()
    target.type(q, delay=30)
    time.sleep(0.25)
    option_selectors = [
        "[role='option']",
        "li[role='option']",
        "coral-selectlist-item",
        "coral-selectlist-item-content",
        ".suggestion-item",
        "[class*='suggest' i] li",
        "[data-testid*='option' i]",
    ]
    terms = option_terms or [q]
    matched = select_option_by_terms(scope, option_selectors, terms)
    if not matched:
        for target in [scope, scope_page]:
            for term in terms:
                try:
                    txt_loc = target.get_by_text(term, exact=False)
                    if txt_loc.count() > 0 and txt_loc.first.is_visible(timeout=350):
                        txt_loc.first.click(timeout=1000)
                        matched = True
                        break
                except Error:
                    continue
            if matched:
                break
    if not matched:
        if not allow_keyboard_fallback:
            return False
        scope_page.keyboard.press("ArrowDown")
        scope_page.keyboard.press("Enter")
    return True


def fill_company_with_suggestion(page: Page, selectors: dict, task: RequestTask) -> bool:
    target = first_visible_locator(page, selectors.get("company_input", []))
    if target is None:
        return False

    scope_page = get_scope_page(page)
    query = (task.ticker or task.company).strip()
    focus_target(target)
    try:
        target.fill("")
    except Error:
        pass
    target.fill(query)
    time.sleep(1.5)

    option_selectors = selectors.get(
        "company_option_items",
        [
            "[role='option']",
            "li[role='option']",
            "ul li",
            ".suggestion-item",
            "[class*='suggest' i] li",
            "[data-testid*='option' i]",
        ],
    )
    company_l = task.company.lower()
    ticker_l = (task.ticker or "").lower()
    for sel in option_selectors:
        loc = page.locator(sel)
        count = min(loc.count(), 20)
        if count == 0:
            continue
        for i in range(count):
            opt = loc.nth(i)
            try:
                if not opt.is_visible(timeout=250):
                    continue
                txt = opt.inner_text(timeout=250).strip().lower()
                if not txt:
                    continue
                if (ticker_l and ticker_l in txt) or (company_l and company_l in txt):
                    opt.click(timeout=800)
                    return True
            except Error:
                continue

    # Fallback: choose first suggestion via keyboard.
    scope_page.keyboard.press("ArrowDown")
    scope_page.keyboard.press("Enter")
    return True


def fill_date(page: Page, selectors: list[str], value: date) -> bool:
    target = first_visible_locator(page, selectors)
    if target is None:
        return False
    scope_page = get_scope_page(page)
    txt = value.strftime("%Y-%m-%d")
    focus_target(target)
    try:
        target.fill("")
    except Error:
        pass
    target.fill(txt)
    scope_page.keyboard.press("Enter")
    return True


def set_custom_date_range(scope, date_from: date, date_to: date) -> tuple[bool, bool]:
    # Reliable path for this page: open Date Range -> Custom..., type both values into
    # emerald-datetime-picker shadow inputs (#input / #input-to), then click popup OK.
    from_txt = _format_picker_text(date_from)
    to_txt = _format_picker_text(date_to)
    scope_page = get_scope_page(scope)

    close_popup_dialogs(scope)
    time.sleep(0.2)

    try:
        scope.evaluate(
            """() => {
                const root = document.querySelector('app-date-range-filter');
                if (!root) return;
                root.querySelector('coral-select')?.click();
                const custom = [...root.querySelectorAll('coral-item')]
                  .find(x => /custom/i.test((x.textContent || '').trim()));
                custom?.click();
            }"""
        )
    except Error:
        return False, False
    time.sleep(0.35)

    try:
        focused = scope.evaluate(
            """() => {
                const picker = document.querySelector('app-date-range-filter emerald-datetime-picker');
                const i1 = picker?.shadowRoot?.querySelector('#input');
                if (!i1) return false;
                i1.focus();
                return true;
            }"""
        )
        if not focused:
            return False, False
    except Error:
        return False, False

    try:
        scope_page.keyboard.press("Control+A")
        scope_page.keyboard.press("Backspace")
        scope_page.keyboard.type(from_txt, delay=18)
        scope_page.keyboard.press("Tab")
        scope_page.keyboard.press("Control+A")
        scope_page.keyboard.press("Backspace")
        scope_page.keyboard.type(to_txt, delay=18)
        time.sleep(0.15)
    except Error:
        return False, False

    try:
        scope.evaluate(
            """() => {
                const panel = document.querySelector('app-date-range-filter app-date-picker-popup coral-popup-panel.popup-dialog');
                if (!panel) return;
                const ok = [...panel.querySelectorAll('coral-button')]
                  .find(b => ((b.textContent || '').trim() === 'OK'));
                ok?.click();
            }"""
        )
    except Error:
        return False, False

    time.sleep(0.4)
    try:
        summary = scope.evaluate(
            """() => (document.querySelector('app-date-range-filter .date-range-filter__date-summary')?.textContent || '').trim()"""
        )
    except Error:
        summary = ""

    ok = from_txt in summary and to_txt in summary
    return ok, ok


def clear_industry_filter(scope, selectors: list[str]) -> bool:
    target = first_visible_locator(scope, selectors)
    if target is None:
        return False
    scope_page = get_scope_page(scope)
    focus_target(target)
    time.sleep(0.2)
    click_first(
        scope,
        [
            "button:has-text('Deselect all')",
            "[role='menuitem']:has-text('Deselect all')",
            "text=/Deselect all/i",
            "text=/Clear all/i",
        ],
    )
    clear_input_value(scope, target)
    try:
        scope_page.keyboard.press("Escape")
    except Error:
        pass
    return True


def read_component_text(scope, selectors: list[str]) -> str:
    for sel in selectors:
        loc = scope.locator(sel)
        try:
            if loc.count() > 0 and loc.first.is_visible(timeout=400):
                txt = (loc.first.inner_text(timeout=400) or "").strip()
                if txt:
                    return txt
        except Error:
            continue
    return ""


def close_popup_dialogs(scope) -> None:
    # Close currently opened modal popup dialogs in filter area (Contributors lookup, date popup, etc).
    try:
        scope.evaluate(
            """() => {
                const visible = (el) => {
                  const s = getComputedStyle(el);
                  const r = el.getBoundingClientRect();
                  return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 2 && r.height > 2;
                };
                const panels = [...document.querySelectorAll('coral-popup-panel.popup-dialog')].filter(visible);
                for (const panel of panels) {
                  const buttons = [...panel.querySelectorAll('coral-button')];
                  const cancel = buttons.find(b => ((b.textContent || '').trim().toLowerCase() === 'cancel'));
                  if (cancel) {
                    cancel.click();
                    continue;
                  }
                  const close = panel.querySelector('coral-button[icon="cross"]');
                  if (close) close.click();
                }
            }"""
        )
    except Error:
        pass


def _format_picker_text(v: date) -> str:
    return v.strftime("%d-%b-%Y 00:00")


def _set_contributor_component(scope, contributor_name: str) -> bool:
    try:
        state = scope.evaluate(
            """async (name) => {
                const el = document.querySelector('app-contributors-filter emerald-multi-select');
                if (!el) return { ok: false, reason: 'no_contributor_component' };

                // Keep include mode.
                const includeBtn = document.querySelector('app-contributors-filter coral-radio-button');
                if (includeBtn) includeBtn.click();

                // Ensure "preferred contributors" style checkbox is not used if present.
                const labels = [...document.querySelectorAll('app-contributors-filter coral-checkbox')];
                for (const cb of labels) {
                  const t = (cb.textContent || '').toLowerCase();
                  if (t.includes('preferred')) {
                    if (cb.hasAttribute('checked') || cb.checked === true) cb.click();
                  }
                }

                el.values = [];
                el.value = '';
                el.query = name;
                el.opened = true;
                await new Promise(r => setTimeout(r, 700));

                const pool = [...(el._resolvedData || []), ...(el._data || [])];
                const exact = pool.find(x => (x?.label || '').trim().toLowerCase() === name.trim().toLowerCase());
                const fuzzy = pool.find(x => (x?.label || '').trim().toLowerCase().includes(name.trim().toLowerCase()));
                const chosen = exact || fuzzy;
                if (!chosen || !chosen.value) {
                  return {
                    ok: false,
                    reason: 'not_found',
                    labels: pool.slice(0, 8).map(x => x?.label || '')
                  };
                }

                el.values = [String(chosen.value)];
                el.value = String(chosen.value);
                el.opened = false;
                el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                el.dispatchEvent(new CustomEvent('confirm', { bubbles: true, composed: true }));
                await new Promise(r => setTimeout(r, 150));

                return {
                  ok:
                    (el.selectedLabels || []).length == 1 &&
                    (el.values || []).length == 1 &&
                    (el.selectedLabels || []).some(x => (x || '').toLowerCase().includes(name.toLowerCase())),
                  selectedLabels: el.selectedLabels || [],
                  values: el.values || []
                };
            }""",
            contributor_name,
        )
        return bool(state.get("ok"))
    except Error:
        return False


def _force_uncheck_preferred_contributors(scope) -> dict[str, int]:
    try:
        result = scope.evaluate(
            """() => {
                const isPreferredLabel = (txt) => {
                  const t = String(txt || '').toLowerCase();
                  // English + common variants.
                  return t.includes('preferred') && (t.includes('contributor') || t.includes('broker'));
                };
                const boxes = [...document.querySelectorAll('coral-checkbox')];
                let found = 0;
                let unchecked = 0;
                let stillChecked = 0;
                for (const cb of boxes) {
                  const txt = (cb.textContent || '').replace(/\\s+/g, ' ').trim();
                  if (!isPreferredLabel(txt)) continue;
                  found += 1;
                  const checked = cb.hasAttribute('checked') || cb.checked === true || cb.getAttribute('aria-checked') === 'true';
                  if (checked) {
                    cb.click();
                    unchecked += 1;
                  }
                  const after = cb.hasAttribute('checked') || cb.checked === true || cb.getAttribute('aria-checked') === 'true';
                  if (after) stillChecked += 1;
                }
                return { found, unchecked, stillChecked };
            }"""
        )
        return {
            "found": int(result.get("found", 0)),
            "unchecked": int(result.get("unchecked", 0)),
            "still_checked": int(result.get("stillChecked", 0)),
        }
    except Error:
        return {"found": 0, "unchecked": 0, "still_checked": 0}


def _set_country_component(scope, country_name: str) -> bool:
    try:
        state = scope.evaluate(
            """(country) => {
                const el = document.querySelector('app-regions-filter emerald-multi-select');
                if (!el) return { ok: false, reason: 'no_regions_component' };

                const walk = (arr) => {
                  for (const item of (arr || [])) {
                    if (!item) continue;
                    const label = String(item.label || '').toLowerCase();
                    if (label.includes('united states of america') || label === 'usa' || label === 'united states') {
                      return item;
                    }
                    const child = walk(item.items || item.children || []);
                    if (child) return child;
                  }
                  return null;
                };

                const selected = (el.selection || [])[0];
                if (selected && String(selected.label || '').toLowerCase().includes('united states')) {
                  return { ok: true, selectedLabels: el.selectedLabels || [], values: el.values || [] };
                }

                const data = [...(el._resolvedData || []), ...(el._data || []), ...(el.data || [])];
                const target = walk(data);
                if (!target || !target.value) {
                  return { ok: false, reason: 'usa_not_found' };
                }

                el.values = [String(target.value)];
                el.value = String(target.value);
                el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                el.dispatchEvent(new CustomEvent('confirm', { bubbles: true, composed: true }));

                return {
                  ok: (el.selectedLabels || []).some(x => String(x || '').toLowerCase().includes('united states')),
                  selectedLabels: el.selectedLabels || [],
                  values: el.values || []
                };
            }""",
            country_name,
        )
        return bool(state.get("ok"))
    except Error:
        return False


def _clear_industry_component(scope) -> bool:
    try:
        state = scope.evaluate(
            """() => {
                const el = document.querySelector('app-industry-filter emerald-multi-select');
                if (!el) return { ok: false, reason: 'no_industry_component' };
                el.values = [];
                el.value = '';
                el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                el.dispatchEvent(new CustomEvent('confirm', { bubbles: true, composed: true }));
                return {
                  ok: !el.values || el.values.length === 0,
                  values: el.values || [],
                  selectedLabels: el.selectedLabels || []
                };
            }"""
        )
        return bool(state.get("ok"))
    except Error:
        return False


def _set_company_component(scope, company: str, ticker: str) -> bool:
    try:
        state = scope.evaluate(
            """async ({company, ticker}) => {
                const el = document.querySelector('app-companies-filter emerald-multi-select');
                if (!el) return { ok: false, reason: 'no_company_component' };

                const q = (ticker || company || '').trim();
                if (!q) return { ok: false, reason: 'empty_query' };

                el.values = [];
                el.value = '';
                el.opened = true;

                const input = el.shadowRoot?.querySelector('coral-text-field');
                if (input) {
                  input.focus();
                  input.value = '';
                  input.value = q;
                  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                }

                el.query = q;
                await new Promise(r => setTimeout(r, 1500));

                const data = [...(el._resolvedData || []), ...(el._data || []), ...(el.data || [])];
                const norm = (s) => String(s || '').trim().toLowerCase();
                const c = norm(company);
                const t = norm(ticker);

                const ranked = data
                  .filter(x => x && x.value)
                  .map(x => {
                    const label = norm(x.label);
                    const value = norm(x.value);
                    let score = 0;
                    if (t && value === t) score += 100;
                    if (t && value === `${t}.n`) score += 90;
                    if (t && value.startsWith(`${t}.`)) score += 75;
                    if (c && label === c) score += 60;
                    if (c && label.includes(c)) score += 35;
                    if (t && label.includes(t)) score += 20;
                    return { item: x, score };
                  })
                  .filter(x => x.score > 0)
                  .sort((a, b) => b.score - a.score);

                const chosen = ranked.length ? ranked[0].item : null;
                if (!chosen) {
                  return {
                    ok: false,
                    reason: 'no_dropdown_match',
                    sample: data.slice(0, 10).map(x => ({ label: x?.label || '', value: x?.value || '' }))
                  };
                }

                el.values = [String(chosen.value)];
                el.value = String(chosen.value);
                el.opened = false;
                el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                el.dispatchEvent(new CustomEvent('confirm', { bubbles: true, composed: true }));
                await new Promise(r => setTimeout(r, 150));

                const labels = el.selectedLabels || [];
                return {
                  ok: labels.length > 0 && labels.some(x => norm(x).includes(c) || (t && norm(x).includes(t))),
                  selectedLabels: labels,
                  values: el.values || [],
                  chosen: { label: chosen.label || '', value: chosen.value || '' }
                };
            }""",
            {"company": company, "ticker": ticker},
        )
        return bool(state.get("ok"))
    except Error:
        return False


def _read_global_component_state(scope) -> dict[str, str]:
    try:
        return scope.evaluate(
            """() => {
                const c = document.querySelector('app-contributors-filter emerald-multi-select');
                const r = document.querySelector('app-regions-filter emerald-multi-select');
                const i = document.querySelector('app-industry-filter emerald-multi-select');
                return {
                  contributor: (c?.selectedLabels || []).join(', '),
                  country: (r?.selectedLabels || []).join(', '),
                  industry: (i?.selectedLabels || []).join(', '),
                };
            }"""
        )
    except Error:
        return {"contributor": "", "country": "", "industry": ""}


def set_contributor_filter(scope, value: str) -> bool:
    target = first_visible_locator(
        scope,
        [
            "app-contributors-filter emerald-multi-select",
            "xpath=//*[normalize-space()='Contributors']/ancestor::*[contains(@class,'filter')][1]//emerald-multi-select",
        ],
    )
    if target is None:
        return False
    scope_page = get_scope_page(scope)

    click_first(scope, ["app-contributors-filter coral-radio-button:has-text('Include')"])
    focus_target(target)
    clear_input_value(scope, target)
    try:
        target.type(value, delay=25)
    except Error:
        scope_page.keyboard.type(value, delay=25)
    time.sleep(0.35)

    option_selectors = [
        "[role='option']",
        "li[role='option']",
        "coral-selectlist-item",
        "coral-selectlist-item-content",
        ".suggestion-item",
        "[class*='suggest' i] li",
    ]
    matched = select_option_by_terms(scope, option_selectors, [value.lower(), "morgan stanley"])
    if not matched:
        try:
            scope_page.keyboard.press("Enter")
        except Error:
            pass
    time.sleep(0.25)

    txt = read_component_text(
        scope,
        [
            "app-contributors-filter",
            "xpath=//*[normalize-space()='Contributors']/ancestor::*[contains(@class,'filter')][1]",
        ],
    ).lower()
    return "morgan stanley" in txt


def click_first(page_or_scope, selectors: list[str]) -> bool:
    for sel in selectors:
        loc = page_or_scope.locator(sel)
        if loc.count() == 0:
            continue
        try:
            loc.first.click(timeout=2000)
            return True
        except Error:
            continue
    return False


def click_first_multi(targets: list[object], selectors: list[str]) -> bool:
    for target in targets:
        if click_first(target, selectors):
            return True
    return False


def _is_blank_or_newtab(page: Page) -> bool:
    try:
        url = (page.url or "").strip().lower()
    except Error:
        return False
    if url in {"", "about:blank"}:
        return True
    return url.startswith("edge://newtab") or url.startswith("chrome://newtab")


def close_new_blank_pages(
    context: BrowserContext,
    before_pages: Optional[set[Page]],
    keep_page: Page,
    runner: Runner,
) -> int:
    closed = 0
    for candidate in list(context.pages):
        if candidate == keep_page:
            continue
        if before_pages is not None and candidate in before_pages:
            continue
        if not _is_blank_or_newtab(candidate):
            continue
        try:
            url = candidate.url
            candidate.close()
            closed += 1
            runner.log_event("INFO", "Closed blank tab opened during task fill", tab_url=url)
        except Error as ex:
            runner.log_event("WARN", "Failed to close blank tab opened during task fill", error=str(ex))
    try:
        keep_page.bring_to_front()
    except Error:
        pass
    return closed


def try_extract_text(scope, selectors: list[str]) -> str:
    for sel in selectors:
        loc = scope.locator(sel)
        if loc.count() == 0:
            continue
        try:
            txt = loc.first.inner_text(timeout=1000).strip()
            if txt:
                return txt
        except Error:
            continue
    return ""


def parse_pages(text: str) -> int:
    if not text:
        return 1
    m = re.search(r"(\d+)\s*pages?", text, flags=re.I)
    if not m:
        return 1
    v = int(m.group(1))
    return max(v, 1)


def estimate_pages_from_rows(row_loc) -> int:
    total = 0
    count = min(row_loc.count(), 120)
    for i in range(count):
        try:
            txt = row_loc.nth(i).inner_text(timeout=200) or ""
        except Error:
            continue
        p = parse_pages(txt)
        total += p
    return max(total, 1)


def try_bulk_download(
    *,
    scope,
    browser_page: Page,
    task: RequestTask,
    config: dict,
    runner: Runner,
    estimated_pages: int,
    download_timeout: int,
) -> tuple[bool, int]:
    sel = config["selectors"]
    if runner.page_used + estimated_pages > runner.page_limit:
        runner.log_event("WARN", "Daily page limit reached. Stop downloading.", next_pages=estimated_pages)
        return False, -1

    if not click_first(scope, sel.get("select_all_checkboxes", [])):
        return False, 0
    time.sleep(0.25)

    try:
        with browser_page.expect_download(timeout=download_timeout) as dl_info:
            if not click_first(scope, sel["download_buttons"]):
                return False, 0
            clicked_save = False
            for _ in range(14):
                if click_first(scope, sel.get("save_to_pc_buttons", [])):
                    clicked_save = True
                    break
                time.sleep(0.35)
            if not clicked_save:
                return False, 0

        download = dl_info.value
        suggested = sanitize_filename(download.suggested_filename or f"{task.task_id}_bulk.pdf")
        if not suggested.lower().endswith(".pdf"):
            suggested += ".pdf"
        target = runner.download_dir / suggested
        download.save_as(str(target))

        runner.page_used += estimated_pages
        runner.downloaded_files += 1
        runner.append_mapping(
            task=task,
            report_title="(bulk_selected_results)",
            report_date="",
            pages=estimated_pages,
            file_path=str(target),
            status="downloaded",
            source_url=browser_page.url,
        )
        runner.log_event(
            "INFO",
            f"Downloaded (bulk): {target.name}",
            task_id=task.task_id,
            pages=estimated_pages,
            page_used=runner.page_used,
        )
        return True, 1
    except Exception as ex:  # noqa: BLE001
        runner.log_event("WARN", "Bulk download path failed; fallback to row mode", task_id=task.task_id, error=str(ex))
        return False, 0


def open_workspace_page(playwright: Playwright, config: dict, runner: Runner) -> tuple[Browser, BrowserContext, Page]:
    cdp_endpoint = config.get("cdp_endpoint", "")
    workspace_url = config["workspace_url"]

    browser: Optional[Browser] = None
    if cdp_endpoint:
        try:
            browser = playwright.chromium.connect_over_cdp(cdp_endpoint)
            runner.log_event("INFO", f"Connected browser over CDP: {cdp_endpoint}")
        except Error as ex:
            runner.log_event("WARN", "CDP connect failed, switching to fallback launch", error=str(ex))

    if browser is None:
        browser = playwright.chromium.launch(
            channel=config["browser"].get("fallback_channel", "chrome"),
            headless=bool(config["browser"].get("headless", False)),
            slow_mo=int(config["browser"].get("slow_mo_ms", 0)),
        )
        runner.log_event("INFO", "Launched fallback browser. Login may be required manually.")

    context: BrowserContext
    if browser.contexts:
        context = browser.contexts[0]
    else:
        context = browser.new_context(accept_downloads=True)

    # Ensure download handling for existing context too.
    context.set_default_timeout(int(config["timeouts"].get("default_ms", 20000)))

    page: Optional[Page] = None
    for p in context.pages:
        if "research-next" in p.url or "workspace.refinitiv.com" in p.url:
            page = p
            break

    if page is None:
        page = context.new_page()
        page.goto(workspace_url, wait_until="domcontentloaded")

    return browser, context, page


def apply_global_filters(page: Page, config: dict, runner: Runner) -> dict[str, bool]:
    scope = get_research_scope(page)
    filters = config["filters"]
    sel = config["selectors"]

    close_popup_dialogs(scope)
    preferred_before = _force_uncheck_preferred_contributors(scope)
    ok_broker = _set_contributor_component(scope, str(filters.get("broker") or "Morgan Stanley"))
    preferred_after = _force_uncheck_preferred_contributors(scope)
    ok_country = _set_country_component(scope, str(filters.get("country") or "USA"))
    industry_value = (filters.get("industry_id", "none") or "").strip().lower()
    if industry_value in {"", "none", "(none)"}:
        ok_industry = _clear_industry_component(scope)
    else:
        ok_industry = set_filter_or_clear(scope, sel.get("industry_id_input", []), filters.get("industry_id", "none"))

    click_first(scope, sel["apply_buttons"])

    component_state = _read_global_component_state(scope)
    actual_broker = component_state.get("contributor", "")
    actual_country = component_state.get("country", "")
    actual_industry = component_state.get("industry", "")
    expected_broker = (filters.get("broker") or "").strip().lower()
    expected_country = (filters.get("country") or "").strip().lower()
    expected_industry = (filters.get("industry_id") or "").strip().lower()
    broker_matched = expected_broker in actual_broker.lower() if expected_broker else True
    if expected_country in {"usa", "us", "united states", "united states of america"}:
        country_matched = ("united states" in actual_country.lower()) or ("usa" in actual_country.lower())
    else:
        country_matched = expected_country in actual_country.lower() if expected_country else True
    industry_cleared = (actual_industry == "") if expected_industry in {"", "none", "(none)"} else (expected_industry in actual_industry.lower())
    preferred_ok = preferred_after.get("still_checked", 0) == 0

    runner.log_event(
        "INFO",
        "Applied global filters",
        ok_broker=ok_broker,
        ok_country=ok_country,
        ok_industry=ok_industry,
        preferred_before=preferred_before,
        preferred_after=preferred_after,
        actual_broker=actual_broker,
        actual_country=actual_country,
        actual_industry=actual_industry,
        broker_matched=broker_matched,
        country_matched=country_matched,
        industry_matched=industry_cleared,
        preferred_matched=preferred_ok,
    )
    return {
        "broker_matched": broker_matched,
        "country_matched": country_matched,
        "industry_matched": industry_cleared,
        "preferred_matched": preferred_ok,
    }


def apply_task_filters(page: Page, task: RequestTask, config: dict, runner: Runner) -> dict[str, bool]:
    scope = get_research_scope(page)
    sel = config["selectors"]

    close_popup_dialogs(scope)
    close_new_blank_pages(page.context, None, page, runner)
    ok_company = _set_company_component(scope, task.company, task.ticker)
    if not ok_company:
        ok_company = fill_company_with_suggestion(scope, sel, task)
    ok_from, ok_to = set_custom_date_range(scope, task.date_from, task.date_to)

    before_search_pages = set(page.context.pages)
    click_first(scope, sel["apply_buttons"])
    time.sleep(0.5)
    closed_blank_tabs = close_new_blank_pages(page.context, before_search_pages, page, runner)

    runner.log_event(
        "INFO",
        f"Applied task filters for {task.task_id} {task.company}",
        ok_company=ok_company,
        ticker=task.ticker,
        ok_from=ok_from,
        ok_to=ok_to,
        closed_blank_tabs=closed_blank_tabs,
    )
    return {"ok_company": ok_company, "ok_from": ok_from, "ok_to": ok_to}


def ensure_query_mode(page: Page, config: dict, runner: Runner) -> bool:
    scope = get_research_scope(page)
    sel = config["selectors"]
    company_selectors = sel.get("company_input", [])
    if first_visible_locator(scope, company_selectors) is not None:
        return True

    clicked = click_first_multi([scope, page], sel.get("modify_query_buttons", []))
    if clicked:
        time.sleep(0.9)
    scope = get_research_scope(page)
    if first_visible_locator(scope, company_selectors) is not None:
        return True

    close_popup_dialogs(scope)
    time.sleep(0.3)
    scope = get_research_scope(page)
    ok = first_visible_locator(scope, company_selectors) is not None
    if not ok:
        runner.log_event("WARN", "Could not return to query mode before task")
    return ok


def has_no_results(scope, selectors: dict) -> bool:
    for sel in selectors.get("no_results_text", []):
        loc = scope.locator(sel)
        try:
            if loc.count() > 0 and loc.first.is_visible(timeout=800):
                return True
        except Error:
            continue
    return False


def download_reports_for_task(browser_page: Page, task: RequestTask, config: dict, runner: Runner) -> dict[str, int | str]:
    sel = config["selectors"]
    download_timeout = int(config["timeouts"].get("download_ms", 60000))

    visited = set()
    page_idx = 1
    downloaded_count = 0
    failed_count = 0

    while True:
        scope = get_research_scope(browser_page)
        row_loc = None
        for candidate in sel["result_rows"]:
            loc = scope.locator(candidate)
            if loc.count() > 0:
                row_loc = loc
                break

        if row_loc is None or row_loc.count() == 0:
            if has_no_results(scope, sel):
                runner.log_event("INFO", f"No results for {task.task_id}")
                return {"status": "no_results", "downloaded": downloaded_count, "failed": failed_count}
            runner.log_event("WARN", f"No result rows found for {task.task_id}")
            return {"status": "no_rows", "downloaded": downloaded_count, "failed": failed_count}

        row_count = row_loc.count()
        runner.log_event("INFO", f"Task {task.task_id} page {page_idx}: {row_count} rows")

        estimated_pages = estimate_pages_from_rows(row_loc)
        bulk_ok, bulk_count = try_bulk_download(
            scope=scope,
            browser_page=browser_page,
            task=task,
            config=config,
            runner=runner,
            estimated_pages=estimated_pages,
            download_timeout=download_timeout,
        )
        if bulk_count == -1:
            return {"status": "page_limit", "downloaded": downloaded_count, "failed": failed_count}
        if bulk_ok:
            downloaded_count += bulk_count
            if runner.max_downloads > 0 and runner.downloaded_files >= runner.max_downloads:
                return {"status": "max_downloads", "downloaded": downloaded_count, "failed": failed_count}
            return {"status": "done", "downloaded": downloaded_count, "failed": failed_count}

        for i in range(row_count):
            if runner.max_downloads > 0 and runner.downloaded_files >= runner.max_downloads:
                runner.log_event("INFO", "Max downloads reached; stop now", max_downloads=runner.max_downloads)
                return {"status": "max_downloads", "downloaded": downloaded_count, "failed": failed_count}

            row = row_loc.nth(i)
            try:
                if not row.is_visible(timeout=300):
                    continue
            except Error:
                continue
            row_key = f"{page_idx}-{i}"
            if row_key in visited:
                continue
            visited.add(row_key)

            title = try_extract_text(row, sel["report_title"]) or f"report_{task.task_id}_{page_idx}_{i+1}"
            report_date = try_extract_text(row, sel["report_date"])
            page_text = try_extract_text(row, sel["pages_text"])
            pages = parse_pages(page_text)

            if runner.page_used + pages > runner.page_limit:
                runner.log_event("WARN", "Daily page limit reached. Stop downloading.", next_pages=pages)
                return {"status": "page_limit", "downloaded": downloaded_count, "failed": failed_count}

            try:
                with browser_page.expect_download(timeout=download_timeout) as dl_info:
                    if not click_first(row, sel["download_buttons"]):
                        # Fallback: click row then click page-level download button.
                        row.click(timeout=2000)
                        if not click_first(scope, sel["download_buttons"]):
                            raise RuntimeError("download button not found")

                download = dl_info.value
                safe_name = sanitize_filename(f"{task.task_id}_{title}") + ".pdf"
                target = runner.download_dir / safe_name
                download.save_as(str(target))

                runner.page_used += pages
                runner.downloaded_files += 1
                downloaded_count += 1
                runner.append_mapping(
                    task=task,
                    report_title=title,
                    report_date=report_date,
                    pages=pages,
                    file_path=str(target),
                    status="downloaded",
                    source_url=browser_page.url,
                )
                runner.log_event(
                    "INFO",
                    f"Downloaded: {safe_name}",
                    task_id=task.task_id,
                    report_title=title,
                    pages=pages,
                    page_used=runner.page_used,
                )

                if runner.max_downloads > 0 and runner.downloaded_files >= runner.max_downloads:
                    return {"status": "max_downloads", "downloaded": downloaded_count, "failed": failed_count}

            except Exception as ex:  # noqa: BLE001
                failed_count += 1
                runner.append_mapping(
                    task=task,
                    report_title=title,
                    report_date=report_date,
                    pages=pages,
                    file_path="",
                    status="failed",
                    error=str(ex),
                    source_url=browser_page.url,
                )
                runner.log_event(
                    "ERROR",
                    "Download failed",
                    task_id=task.task_id,
                    report_title=title,
                    error=str(ex),
                )

        # Next page if possible.
        if not click_first(scope, sel["next_page_buttons"]):
            break
        page_idx += 1
        time.sleep(1.2)

    if downloaded_count == 0 and has_no_results(scope, sel):
        return {"status": "no_results", "downloaded": downloaded_count, "failed": failed_count}
    if downloaded_count == 0 and failed_count == 0:
        return {"status": "no_downloadable_report", "downloaded": downloaded_count, "failed": failed_count}
    return {"status": "done", "downloaded": downloaded_count, "failed": failed_count}


def load_config(path: Path) -> dict:
    if not path.exists():
        return DEFAULT_CONFIG
    if yaml is None:
        print("PyYAML is not installed; falling back to default config.", file=sys.stderr)
        return DEFAULT_CONFIG
    with path.open("r", encoding="utf-8") as f:
        user_cfg = yaml.safe_load(f) or {}
    config = deep_merge(DEFAULT_CONFIG, user_cfg)
    resolved_path = path.resolve()
    base_dir = resolved_path.parent.parent if resolved_path.parent.name.lower() == "config" else resolved_path.parent

    for key in ("input_file", "download_dir", "mapping_csv", "run_log_jsonl"):
        raw = str(config.get(key, "") or "").strip()
        if raw:
            config[key] = str(resolve_config_path(raw, base_dir=base_dir))

    browser_cfg = config.setdefault("browser", {})
    user_data_dir = str(browser_cfg.get("user_data_dir", "") or "").strip()
    if user_data_dir:
        browser_cfg["user_data_dir"] = str(resolve_config_path(user_data_dir, base_dir=base_dir))

    if platform.system() == "Darwin" and browser_cfg.get("fallback_channel") == "msedge":
        browser_cfg["fallback_channel"] = "chrome"

    return config


def get_research_scope(page: Page):
    def is_inner_ready_url(url: str) -> bool:
        return "/Apps/research-next/2." in url

    for fr in page.frames:
        if is_inner_ready_url(fr.url):
            return fr
    return page


def is_research_scope(scope, page: Page) -> bool:
    def is_inner_ready_url(url: str) -> bool:
        return "/Apps/research-next/2." in url

    try:
        scope_url = getattr(scope, "url", "")
    except Exception:  # noqa: BLE001
        scope_url = ""
    page_url = page.url or ""
    return is_inner_ready_url(scope_url) or is_inner_ready_url(page_url)


def has_workspace_load_failure(scope, page: Page) -> bool:
    patterns = [
        "text=/Failed to load:/i",
        "text=/restart the application/i",
        "text=/permissions.*user.?info.*settings/i",
    ]
    for target in (scope, page):
        for pattern in patterns:
            try:
                loc = target.locator(pattern)
                if loc.count() > 0 and loc.first.is_visible(timeout=400):
                    return True
            except Error:
                continue
    return False


def wait_until_research_ready(
    page: Page,
    runner: Runner,
    timeout_seconds: int,
    workspace_url: str,
    max_restart_attempts: int,
) -> object:
    deadline = time.time() + max(timeout_seconds, 5)
    last_url = ""
    restart_count = 0
    while time.time() < deadline:
        scope = get_research_scope(page)
        url = getattr(scope, "url", page.url)
        if has_workspace_load_failure(scope, page):
            if restart_count >= max_restart_attempts:
                raise RuntimeError("Workspace app failed to load after restart attempts")
            restart_count += 1
            runner.log_event(
                "WARN",
                "Workspace app load failure detected; restarting app",
                restart_attempt=restart_count,
                current_url=url,
            )
            try:
                page.goto(workspace_url, wait_until="domcontentloaded", timeout=45000)
            except PlaywrightTimeoutError:
                runner.log_event("WARN", "Restart goto timed out; continue waiting")
            time.sleep(2.5)
            continue
        if is_research_scope(scope, page):
            return scope
        if url != last_url:
            runner.log_event("INFO", "Waiting for login/session ready", current_url=url)
            last_url = url
        time.sleep(2.0)
    raise RuntimeError(f"Timed out waiting for research page after {timeout_seconds}s")


def run_dry_run(tasks: list[RequestTask], input_file: Path, runner: Runner) -> int:
    runner.log_event("INFO", "Dry run mode enabled. Browser automation is skipped.", input_file=str(input_file))
    for task in tasks:
        planned_pattern = str(runner.download_dir / f"{sanitize_filename(task.task_id + '_' + task.company)}_*.pdf")
        runner.append_mapping(
            task=task,
            report_title="(dry-run) planned task",
            report_date="",
            pages=0,
            file_path=planned_pattern,
            status="planned_task",
            error="",
            source_url="",
        )
        runner.log_event(
            "INFO",
            f"[DRY-RUN] Planned {task.task_id}: {task.company} {task.date_from}..{task.date_to}",
            planned_output=planned_pattern,
            raw_line=task.raw_line,
        )
    runner.log_event("INFO", "Dry run completed", planned_tasks=len(tasks))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Download LSEG Workspace reports with automation.")
    parser.add_argument("--config", default="config/config.yaml", help="Path to yaml config")
    parser.add_argument("--input", default=None, help="Override input task file")
    parser.add_argument("--dry-run", action="store_true", help="Parse tasks and write planned outputs only")
    parser.add_argument("--max-downloads", type=int, default=None, help="Stop after N successful PDF downloads (0 = unlimited)")
    parser.add_argument(
        "--manual-setup-mode",
        action="store_true",
        help="Only loop company/date/search/download; keep global filters as manually prepared in UI.",
    )
    parser.add_argument(
        "--skip-initial-goto",
        action="store_true",
        help="Do not force navigation to workspace_url at startup (use current tab as-is).",
    )
    args = parser.parse_args()

    config_path = Path(args.config)
    config = load_config(config_path)

    if args.input:
        config["input_file"] = args.input
    if args.max_downloads is not None:
        config["max_downloads"] = int(args.max_downloads)
    if args.manual_setup_mode:
        config.setdefault("behavior", {})["manual_setup_mode"] = True
    if args.skip_initial_goto:
        config.setdefault("behavior", {})["skip_initial_goto"] = True

    if args.dry_run:
        config["mapping_csv"] = "output/task_file_mapping.dryrun.csv"
        config["run_log_jsonl"] = "logs/run_log.dryrun.jsonl"

    input_file = Path(config["input_file"])
    if not input_file.exists():
        print(f"Input file not found: {input_file}", file=sys.stderr)
        return 2

    runner = Runner(config)

    lines = input_file.read_text(encoding="utf-8", errors="ignore").splitlines()
    tasks = parse_tasks(lines)
    if not tasks:
        runner.log_event("ERROR", "No valid tasks parsed from input file")
        return 3

    runner.log_event("INFO", f"Parsed {len(tasks)} tasks", input_file=str(input_file))

    if args.dry_run:
        return run_dry_run(tasks, input_file, runner)

    if sync_playwright is None:
        print("Playwright is not installed. Install dependencies or run with --dry-run.", file=sys.stderr)
        return 4

    with sync_playwright() as pw:
        browser, _, page = open_workspace_page(pw, config, runner)

        behavior = config.get("behavior", {})
        if not bool(behavior.get("skip_initial_goto", False)):
            try:
                page.goto(config["workspace_url"], wait_until="domcontentloaded")
            except PlaywrightTimeoutError:
                runner.log_event("WARN", "Initial goto timeout; continue with current page")
        else:
            runner.log_event("INFO", "Skip initial goto and continue with current page", current_url=page.url)

        wait_seconds = int(behavior.get("login_wait_seconds", 600))
        restart_attempts = int(behavior.get("app_restart_attempts", 3))
        scope = wait_until_research_ready(
            page,
            runner,
            wait_seconds,
            config["workspace_url"],
            restart_attempts,
        )
        runner.log_event("INFO", "Using automation scope", scope_url=getattr(scope, "url", page.url))

        manual_mode = bool(config.get("behavior", {}).get("manual_setup_mode", False))
        if manual_mode:
            runner.log_event("INFO", "Manual setup mode enabled: skip global filters, only company/date/download loop")
        elif config.get("behavior", {}).get("apply_global_filters_once", True):
            try:
                global_state = apply_global_filters(page, config, runner)
                if not all(global_state.values()):
                    time.sleep(0.8)
                    global_state = apply_global_filters(page, config, runner)
                if not all(global_state.values()):
                    runner.log_event("WARN", "Global filters are not fully matched; run may be incomplete", **global_state)
                time.sleep(0.8)
            except Exception as ex:  # noqa: BLE001
                runner.log_event("WARN", "Applying global filters failed; continue per-task", error=str(ex))

        for task in tasks:
            if runner.page_used >= runner.page_limit:
                runner.log_event("WARN", "Daily page limit reached before task start", task_id=task.task_id)
                break

            runner.log_event(
                "INFO",
                f"Start task {task.task_id}: {task.company} {task.date_from}..{task.date_to}",
                raw_line=task.raw_line,
            )
            attempt = 0
            while True:
                attempt += 1
                try:
                    if not ensure_query_mode(page, config, runner):
                        runner.append_mapping(
                            task=task,
                            report_title="",
                            report_date="",
                            pages=0,
                            file_path="",
                            status="filter_not_applied",
                            error="query_mode_unavailable",
                            source_url=page.url,
                        )
                        runner.log_event("WARN", "Query mode unavailable; skip task", task_id=task.task_id)
                        break

                    if (not manual_mode) and (not config.get("behavior", {}).get("apply_global_filters_once", True)):
                        global_state = apply_global_filters(page, config, runner)
                        if not all(global_state.values()):
                            runner.log_event("WARN", "Global filters mismatch on per-task apply", **global_state)
                    task_state = apply_task_filters(page, task, config, runner)
                    if not all(task_state.values()):
                        runner.append_mapping(
                            task=task,
                            report_title="",
                            report_date="",
                            pages=0,
                            file_path="",
                            status="filter_not_applied",
                            error=json.dumps(task_state, ensure_ascii=False),
                            source_url=page.url,
                        )
                        runner.log_event("WARN", "Task filters not fully applied; skip", task_id=task.task_id, **task_state)
                        break
                    time.sleep(1.0)
                    result = download_reports_for_task(page, task, config, runner)
                    if result.get("status") == "max_downloads":
                        runner.log_event("INFO", "Run stopped by max-downloads", total_downloaded=runner.downloaded_files)
                        break
                    if result.get("status") in {"no_results", "no_rows", "no_downloadable_report"}:
                        runner.append_mapping(
                            task=task,
                            report_title="",
                            report_date="",
                            pages=0,
                            file_path="",
                            status=str(result.get("status")),
                            error="",
                            source_url=page.url,
                        )
                        runner.log_event(
                            "INFO",
                            f"Skip to next task due to {result.get('status')}",
                            task_id=task.task_id,
                        )
                    break
                except Exception as ex:  # noqa: BLE001
                    error_txt = str(ex)
                    if "Frame was detached" in error_txt and attempt < 2:
                        runner.log_event(
                            "WARN",
                            "Frame detached during task; retrying once",
                            task_id=task.task_id,
                            attempt=attempt,
                        )
                        time.sleep(1.2)
                        continue
                    runner.log_event("ERROR", "Task failed", task_id=task.task_id, error=error_txt)
                    runner.append_mapping(
                        task=task,
                        report_title="",
                        report_date="",
                        pages=0,
                        file_path="",
                        status="task_failed",
                        error=error_txt,
                        source_url=page.url,
                    )
                    break

        if runner.max_downloads > 0 and runner.downloaded_files >= runner.max_downloads:
            runner.log_event("INFO", "Reached requested download target", target=runner.max_downloads)

        runner.log_event("INFO", "Run completed", total_pages=runner.page_used)
        # Keep attached browser alive only if CDP was used and you want to continue manually.
        if not config.get("cdp_endpoint"):
            browser.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
