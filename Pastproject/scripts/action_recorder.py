#!/usr/bin/env python
"""Live recorder for LSEG manual operations from an existing Chrome CDP session.

Capabilities:
- Waits for an already-open Chrome remote-debugging endpoint.
- Attaches to all relevant pages/frames and injects event listeners.
- Captures user interactions with shadow-DOM aware selector hints.
- Emits component discovery events for custom web components.
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from playwright.sync_api import Browser, BrowserContext, Error, Frame, Page, sync_playwright


TARGET_HINTS_DEFAULT = "workspace.refinitiv.com,research-next,identity.ciam.refinitiv.net"


def now_ts() -> str:
    return datetime.now().isoformat(timespec="seconds")


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False) + "\n")


def safe_page_title(page: Page) -> str:
    try:
        return page.title()
    except Error:
        return ""


def connect_browser_with_retry(
    playwright,
    cdp: str,
    wait_seconds: int,
    out_path: Path,
    retry_interval: float = 2.0,
) -> Browser:
    start = time.time()
    attempt = 0
    while True:
        attempt += 1
        try:
            browser = playwright.chromium.connect_over_cdp(cdp)
            append_jsonl(
                out_path,
                {
                    "ts": now_ts(),
                    "type": "cdp_connected",
                    "cdp": cdp,
                    "attempt": attempt,
                },
            )
            return browser
        except Error as exc:
            elapsed = int(time.time() - start)
            append_jsonl(
                out_path,
                {
                    "ts": now_ts(),
                    "type": "cdp_waiting",
                    "cdp": cdp,
                    "attempt": attempt,
                    "elapsed_sec": elapsed,
                    "error": str(exc),
                },
            )
            if wait_seconds > 0 and elapsed >= wait_seconds:
                raise RuntimeError(f"CDP not available within {wait_seconds}s: {cdp}") from exc
            if attempt == 1 or attempt % 5 == 0:
                print(f"[{now_ts()}] Waiting for Chrome CDP at {cdp} ... (attempt {attempt})")
            time.sleep(retry_interval)


def get_or_create_context(browser: Browser) -> BrowserContext:
    return browser.contexts[0] if browser.contexts else browser.new_context(accept_downloads=True)


def page_score(page: Page, hints: list[str]) -> int:
    score = 0
    page_url = (page.url or "").lower()
    for hint in hints:
        if hint in page_url:
            score += 5
    for frame in page.frames:
        f_url = (frame.url or "").lower()
        for hint in hints:
            if hint in f_url:
                score += 2
    return score


def pick_best_page(context: BrowserContext, hints: list[str]) -> Page:
    if not context.pages:
        return context.new_page()
    scored = sorted(context.pages, key=lambda pg: page_score(pg, hints), reverse=True)
    return scored[0]


def install_dom_listeners(scope: Frame | Page) -> None:
    scope.evaluate(
        r"""
() => {
  if (window.__rpaRecorderInstalled) return "already";
  window.__rpaRecorderInstalled = true;
  window.__rpaEvents = window.__rpaEvents || [];

  const shortText = (txt, maxLen = 200) => String(txt || "").replace(/\s+/g, " ").trim().slice(0, maxLen);
  const isEl = (x) => x && x.nodeType === 1;
  const toEl = (x) => isEl(x) ? x : (x?.parentElement || null);

  const selectorPart = (el) => {
    if (!isEl(el)) return "";
    let part = el.tagName.toLowerCase();
    if (el.id) return `${part}#${el.id}`;
    const cls = String(el.className || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) part += "." + cls.join(".");
    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(el) + 1})`;
    }
    return part;
  };

  const cssPathLight = (el) => {
    if (!isEl(el)) return "";
    const parts = [];
    let node = el;
    while (isEl(node) && parts.length < 10) {
      parts.unshift(selectorPart(node));
      node = node.parentElement;
    }
    return parts.join(" > ");
  };

  const cssPathDeep = (el) => {
    if (!isEl(el)) return "";
    const segments = [];
    let current = el;
    while (isEl(current) && segments.length < 6) {
      const light = [];
      let node = current;
      while (isEl(node) && light.length < 10) {
        light.unshift(selectorPart(node));
        node = node.parentElement;
      }
      segments.unshift(light.join(" > "));
      const root = current.getRootNode?.();
      if (root && root.host && isEl(root.host)) {
        current = root.host;
      } else {
        break;
      }
    }
    return segments.join(" >>> ");
  };

  const customAncestors = (el) => {
    const out = [];
    const seen = new Set();
    let node = el;
    while (isEl(node) && out.length < 20) {
      const tag = node.tagName.toLowerCase();
      if (tag.includes("-") && !seen.has(tag)) {
        out.push(tag);
        seen.add(tag);
      }
      node = node.parentElement;
    }
    return out;
  };

  const shadowHosts = (el) => {
    const hosts = [];
    const seen = new Set();
    let node = el;
    while (isEl(node) && hosts.length < 10) {
      const root = node.getRootNode?.();
      if (root && root.host && isEl(root.host)) {
        const tag = root.host.tagName.toLowerCase();
        if (!seen.has(tag)) {
          hosts.push(tag);
          seen.add(tag);
        }
        node = root.host;
      } else {
        break;
      }
    }
    return hosts;
  };

  const composedTags = (ev) => {
    try {
      return (ev.composedPath?.() || [])
        .filter((n) => isEl(n))
        .slice(0, 15)
        .map((n) => n.tagName.toLowerCase());
    } catch {
      return [];
    }
  };

  const attrs = (el) => {
    const keys = ["id", "class", "role", "name", "type", "placeholder", "aria-label", "data-testid", "title"];
    const data = {};
    for (const k of keys) {
      const v = el?.getAttribute?.(k);
      if (v) data[k] = shortText(v, 160);
    }
    return data;
  };

  const labelText = (el) => {
    try {
      if (el?.labels?.length) return shortText(el.labels[0].innerText || el.labels[0].textContent || "", 140);
    } catch {}
    return "";
  };

  const valueText = (el) => {
    try {
      const t = String(el?.type || "").toLowerCase();
      if (t === "password") return "<masked>";
      if (typeof el?.value === "string") return shortText(el.value, 200);
      if (typeof el?.textContent === "string") return shortText(el.textContent, 200);
    } catch {}
    return "";
  };

  const emit = (kind, ev, extra = {}) => {
    const target = toEl(ev?.composedPath?.()?.[0]) || toEl(ev?.target);
    if (!target) return;
    const cAnc = customAncestors(target);
    const sHosts = shadowHosts(target);
    const pTags = composedTags(ev);
    const allCustom = [...new Set([...cAnc, ...sHosts, ...pTags.filter((t) => t.includes("-"))])];
    window.__rpaEvents.push({
      t: Date.now(),
      kind,
      frame_url: location.href,
      tag: target.tagName.toLowerCase(),
      path_light: cssPathLight(target),
      path_deep: cssPathDeep(target),
      text: shortText(target.innerText || target.textContent || "", 180),
      value: valueText(target),
      checked: typeof target.checked === "boolean" ? target.checked : null,
      label: labelText(target),
      attrs: attrs(target),
      composed_path_tags: pTags,
      custom_tags: allCustom,
      shadow_hosts: sHosts,
      ...extra
    });
  };

  document.addEventListener("click", (e) => emit("click", e), true);
  document.addEventListener("input", (e) => emit("input", e), true);
  document.addEventListener("change", (e) => emit("change", e), true);
  document.addEventListener("focusin", (e) => emit("focusin", e), true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "Tab" || e.key === "Escape") emit("keydown", e, { key: e.key });
  }, true);

  return "installed";
}
"""
    )


def flush_dom_events(scope: Frame | Page) -> list[dict[str, Any]]:
    try:
        events = scope.evaluate(
            """() => {
  const arr = window.__rpaEvents || [];
  window.__rpaEvents = [];
  return arr;
}"""
        )
        if isinstance(events, list):
            return events
    except Error:
        pass
    return []


def snapshot_custom_elements(scope: Frame | Page) -> dict[str, Any]:
    return scope.evaluate(
        """() => {
  const all = Array.from(document.querySelectorAll("*"));
  const counts = {};
  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    if (tag.includes("-")) counts[tag] = (counts[tag] || 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 80);
  const required = [
    "app-companies-filter",
    "app-contributors-filter",
    "app-regions-filter",
    "app-industry-filter",
    "app-date-range-filter",
    "emerald-multi-select",
    "coral-select",
    "emerald-datetime-picker"
  ];
  const presence = {};
  for (const tag of required) presence[tag] = Boolean(document.querySelector(tag));
  return {
    frame_url: location.href,
    total_nodes: all.length,
    custom_count: Object.keys(counts).length,
    top_custom_tags: top,
    required_tag_presence: presence
  };
}"""
    )


def should_log_network(url: str, resource_type: str) -> bool:
    raw = url.lower()
    rt = resource_type.lower()
    interesting = (
        "research-next",
        "documentcart",
        "suggestions",
        "search",
        "download",
        ".pdf",
        "date",
        "filter",
    )
    return any(x in raw for x in interesting) and rt in {"xhr", "fetch", "document", "script"}


def bind_page_events(page: Page, out_path: Path) -> None:
    page.on(
        "framenavigated",
        lambda frame: append_jsonl(
            out_path,
            {
                "ts": now_ts(),
                "type": "navigated",
                "main_page_url": page.url,
                "frame_url": frame.url,
            },
        ),
    )
    page.on(
        "download",
        lambda d: append_jsonl(
            out_path,
            {
                "ts": now_ts(),
                "type": "download",
                "page_url": page.url,
                "download_url": d.url,
                "suggested_filename": d.suggested_filename,
            },
        ),
    )
    page.on(
        "response",
        lambda r: append_jsonl(
            out_path,
            {
                "ts": now_ts(),
                "type": "response",
                "status": r.status,
                "resource_type": r.request.resource_type,
                "url": r.url,
                "page_url": page.url,
            },
        )
        if should_log_network(r.url, r.request.resource_type)
        else None,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Record manual actions from Chrome over CDP.")
    parser.add_argument("--cdp", default="http://127.0.0.1:9222", help="Chrome CDP endpoint")
    parser.add_argument("--out", default="logs/manual_action_log_live.jsonl", help="Output jsonl path")
    parser.add_argument("--poll-ms", type=int, default=350, help="Polling interval for DOM events")
    parser.add_argument(
        "--connect-wait-sec",
        type=int,
        default=0,
        help="Seconds to wait for CDP endpoint (0 means wait forever).",
    )
    parser.add_argument(
        "--target-hints",
        default=TARGET_HINTS_DEFAULT,
        help="Comma-separated URL keywords used to pick the active page.",
    )
    args = parser.parse_args()

    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    hints = [h.strip().lower() for h in args.target_hints.split(",") if h.strip()]

    with sync_playwright() as p:
        browser = connect_browser_with_retry(
            playwright=p,
            cdp=args.cdp,
            wait_seconds=max(args.connect_wait_sec, 0),
            out_path=out_path,
        )
        context = get_or_create_context(browser)

        bound_pages: set[int] = set()
        snapped_frames: set[str] = set()
        discovered_components: set[str] = set()
        last_active_url = ""

        def ensure_page_bound(pg: Page) -> None:
            key = id(pg)
            if key in bound_pages:
                return
            bind_page_events(pg, out_path)
            bound_pages.add(key)

        for pg in context.pages:
            ensure_page_bound(pg)
        context.on("page", ensure_page_bound)

        active_page = pick_best_page(context, hints)
        try:
            active_page.bring_to_front()
        except Error:
            pass

        append_jsonl(
            out_path,
            {
                "ts": now_ts(),
                "type": "session_start",
                "cdp": args.cdp,
                "active_page_url": active_page.url,
                "active_page_title": safe_page_title(active_page),
                "context_pages": len(context.pages),
            },
        )
        print(f"[{now_ts()}] Connected to Chrome CDP: {args.cdp}")
        print(f"[{now_ts()}] Recorder started -> {out_path}")
        print("Now operate the webpage. Press Ctrl+C to stop.")

        try:
            while True:
                active_page = pick_best_page(context, hints)
                active_url = active_page.url or ""
                if active_url != last_active_url:
                    last_active_url = active_url
                    append_jsonl(
                        out_path,
                        {
                            "ts": now_ts(),
                            "type": "active_page_changed",
                            "active_page_url": active_url,
                            "active_page_title": safe_page_title(active_page),
                        },
                    )

                for pg in list(context.pages):
                    ensure_page_bound(pg)
                    for frame in pg.frames:
                        try:
                            install_dom_listeners(frame)
                        except Error:
                            continue

                        snap_key = f"{pg.url}|{frame.url}"
                        if snap_key not in snapped_frames:
                            try:
                                snap = snapshot_custom_elements(frame)
                                append_jsonl(
                                    out_path,
                                    {
                                        "ts": now_ts(),
                                        "type": "component_snapshot",
                                        "page_url": pg.url,
                                        **snap,
                                    },
                                )
                                snapped_frames.add(snap_key)
                            except Error:
                                pass

                        for ev in flush_dom_events(frame):
                            event_payload = {
                                "ts": now_ts(),
                                "type": "ui_event",
                                "page_url": pg.url,
                                "page_title": safe_page_title(pg),
                                "frame_url": frame.url,
                                **ev,
                            }
                            append_jsonl(out_path, event_payload)

                            tag = str(ev.get("tag") or "").strip().lower()
                            tags = [tag] if tag else []
                            for t in ev.get("custom_tags") or []:
                                if isinstance(t, str) and t.strip():
                                    tags.append(t.strip().lower())

                            for comp in tags:
                                if "-" not in comp or comp in discovered_components:
                                    continue
                                discovered_components.add(comp)
                                append_jsonl(
                                    out_path,
                                    {
                                        "ts": now_ts(),
                                        "type": "component_discovered",
                                        "component_tag": comp,
                                        "event_kind": ev.get("kind", ""),
                                        "page_url": pg.url,
                                        "frame_url": frame.url,
                                        "path_deep": ev.get("path_deep", ""),
                                        "text": ev.get("text", ""),
                                    },
                                )

                time.sleep(max(args.poll_ms, 100) / 1000.0)
        except KeyboardInterrupt:
            pass

        append_jsonl(
            out_path,
            {
                "ts": now_ts(),
                "type": "session_end",
                "active_page_url": active_page.url,
            },
        )
        print(f"[{now_ts()}] Recorder stopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
