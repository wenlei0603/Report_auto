import type { Page } from "playwright";
import type { LsegConfig } from "../config.js";
import { anyVisible, countFirst } from "./locators.js";
import { getResearchScope, owningPage, scopeUrl } from "./scope.js";
import type { AppState, AutomationScope, ResultClassification, StateEvidence } from "./types.js";

export function classifyUrl(url: string): AppState | null {
  if (/BatchSavePrint/i.test(url)) {
    return "batch_save_print";
  }
  if (/login|signin|auth|saml|oauth/i.test(url)) {
    return "auth";
  }
  return null;
}

export async function classifyAppState(page: Page, config: LsegConfig): Promise<StateEvidence> {
  const pageState = classifyUrl(page.url());
  const scope = getResearchScope(page);
  if (pageState) {
    return { state: pageState, pageUrl: page.url(), scopeUrl: scopeUrl(scope), reason: "url" };
  }

  const textState = classifyText(await safeBodyText(scope));
  if (textState) {
    return { state: textState, pageUrl: page.url(), scopeUrl: scopeUrl(scope), reason: "body_text" };
  }

  if (await anyVisible(scope, config.selectors.company_input)) {
    return { state: "query", pageUrl: page.url(), scopeUrl: scopeUrl(scope), reason: "company_input_visible" };
  }

  if ((await countFirst(scope, config.selectors.result_rows)) > 0) {
    return { state: "results", pageUrl: page.url(), scopeUrl: scopeUrl(scope), reason: "result_rows_visible" };
  }

  return { state: "unknown", pageUrl: page.url(), scopeUrl: scopeUrl(scope), reason: "no_marker" };
}

export async function classifyResults(scope: AutomationScope, config: LsegConfig): Promise<ResultClassification> {
  const deadline = Date.now() + Math.min(Math.max(config.timeouts.default_ms, 4000), 12000);
  let lastReason = "no_result_rows";

  while (Date.now() < deadline) {
    const textState = classifyText(await safeBodyText(scope));
    if (textState === "document_info") {
      return { status: "document_info", rowCount: 0, estimatedPages: 0, reason: "document_info_text" };
    }
    const hasNoResultsText = await anyVisible(scope, config.selectors.no_results_text);
    if (hasNoResultsText) {
      return { status: "no_results", rowCount: 0, estimatedPages: 0, reason: "no_results_text" };
    }

    const rowCount = await countLikelyResultRows(scope, config.selectors.result_rows);
    if (rowCount > 0) {
      const estimatedPages = await estimatePagesFromRows(scope, config);
      return { status: "results", rowCount, estimatedPages, reason: "rows_visible" };
    }

    const fallbackSignals = await countResultLikeSignals(scope);
    const interpreted = interpretResultVisibilitySignals({
      hasNoResultsText,
      rowCount,
      rowHints: fallbackSignals.rowHints,
      recordTotal: fallbackSignals.recordTotal
    });
    if (interpreted.status === "results") {
      const estimatedPages = await estimatePagesFromRows(scope, config);
      return {
        status: "results",
        rowCount: interpreted.rowCount,
        estimatedPages,
        reason: interpreted.reason
      };
    }

    lastReason = textState === "loading" ? "results_still_loading" : "no_result_rows";
    await waitOnScope(scope, 350);
  }

  return { status: "no_rows", rowCount: 0, estimatedPages: 0, reason: `${lastReason}_timeout` };
}

export function interpretResultVisibilitySignals(input: {
  hasNoResultsText: boolean;
  rowCount: number;
  rowHints: number;
  recordTotal: number;
}): { status: "results" | "no_results" | "no_rows"; rowCount: number; reason: string } {
  if (input.hasNoResultsText) {
    return { status: "no_results", rowCount: 0, reason: "no_results_text" };
  }
  if (input.rowCount > 0) {
    return { status: "results", rowCount: input.rowCount, reason: "rows_visible" };
  }
  if (input.recordTotal > 0) {
    return { status: "results", rowCount: input.recordTotal, reason: "record_count_visible" };
  }
  if (input.rowHints > 0) {
    return { status: "results", rowCount: input.rowHints, reason: "result_like_signal_visible" };
  }
  return { status: "no_rows", rowCount: 0, reason: "no_result_rows" };
}

function classifyText(text: string): AppState | null {
  if (/document information|save documents to pc|save to my pc/i.test(text)) {
    return "document_info";
  }
  if (/sign in|signed in to another device|log in/i.test(text) || classifySessionFailureText(text)) {
    return "auth";
  }
  if (/loading|please wait/i.test(text)) {
    return "loading";
  }
  return null;
}

export function classifySessionFailureText(text: string): boolean {
  return /\byour\s+session\s+(?:is\s+)?expired\b/i.test(text) || /\bsession\s+(?:has\s+)?expired\b/i.test(text);
}

async function estimatePagesFromRows(scope: AutomationScope, _config: LsegConfig): Promise<number> {
  const text = await safeBodyText(scope);
  const matches = [...text.matchAll(/\b(\d+)\s*pages?\b/gi)];
  if (matches.length === 0) {
    return 1;
  }
  return matches.reduce((sum, match) => sum + Number(match[1]), 0);
}

async function safeBodyText(scope: AutomationScope): Promise<string> {
  try {
    return await scope.evaluate(() => document.body?.innerText ?? "");
  } catch {
    return "";
  }
}

async function countLikelyResultRows(scope: AutomationScope, selectors: string[]): Promise<number> {
  let total = 0;
  for (const selector of selectors) {
    const locator = scope.locator(selector);
    let count = 0;
    try {
      count = Math.min(await locator.count(), 40);
    } catch {
      continue;
    }
    for (let i = 0; i < count; i += 1) {
      try {
        const text = (await locator.nth(i).innerText({ timeout: 300 })).replace(/\s+/g, " ").trim();
        if (looksLikeResultRow(text)) {
          total += 1;
        }
      } catch {
        continue;
      }
    }
    if (total > 0) {
      return total;
    }
  }
  return total;
}

function looksLikeResultRow(text: string): boolean {
  if (!text) {
    return false;
  }
  const hasAvailableTimestamp = /\b\d{1,2}-[A-Za-z]{3}-\d{4},\s*\d{1,2}:\d{2}\b/.test(text);
  if (hasAvailableTimestamp) {
    return true;
  }
  const hasDate = /\b\d{1,2}-[A-Za-z]{3}-\d{4}\b/.test(text);
  const hasTickerOrNA = /\b[A-Z]{1,6}(?:\.[A-Z0-9]+)+\b/.test(text) || /\bN\/A\b/i.test(text);
  return hasDate && hasTickerOrNA;
}

async function waitOnScope(scope: AutomationScope, ms: number): Promise<void> {
  await owningPage(scope).waitForTimeout(ms).catch(() => undefined);
}

async function countResultLikeSignals(
  scope: AutomationScope
): Promise<{
  rowHints: number;
  recordTotal: number;
}> {
  return scope
    .evaluate(() => {
      const text = document.body?.innerText ?? "";
      const rowHints = (text.match(/\b\d{1,2}-[A-Za-z]{3}-\d{4},\s*\d{1,2}:\d{2}\b/g) ?? []).length;
      const recordMatch = text.match(/\b(\d+)\s*-\s*(\d+)\s+of\s+(\d+)\s+records\b/i);
      const recordTotal = recordMatch ? Number.parseInt(recordMatch[3] ?? "0", 10) : 0;
      return { rowHints, recordTotal: Number.isFinite(recordTotal) ? recordTotal : 0 };
    })
    .catch(() => ({ rowHints: 0, recordTotal: 0 }));
}
