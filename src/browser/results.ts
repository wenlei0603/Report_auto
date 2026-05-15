import { addDaysIso, compareIsoDates, differenceInDaysIso, parseDateToIso } from "../domain/dates.js";
import type { LsegConfig } from "../config.js";
import type { AutomationScope } from "./types.js";

export interface ResultRowSnapshot {
  rowIndex: number;
  dateText: string;
  availableText: string;
  companyName: string;
  companyExtraCount: number;
  tickerText: string;
  tickerExtraCount: number;
  titleText: string;
  pagesText: string;
  contributorText: string;
}

export interface ResultReviewTask {
  company: string;
  ticker: string;
  ccDate?: string;
  dateFrom: string;
  dateTo: string;
  contributor: string;
  maxPages: number;
}

export interface ResultRowReview {
  eligible: boolean;
  needsHumanReview: boolean;
  autoSelect: boolean;
  downloadCategory: "ticker_matched" | "ticker_mismatch" | "none";
  reasons: string[];
}

export interface ResultRowsReview {
  inspectableRows: number;
  autoSelectRowIndexes: number[];
  tickerMatchedRowIndexes: number[];
  tickerMismatchRowIndexes: number[];
  humanReviewRowIndexes: number[];
  rejectedRowIndexes: number[];
  reviews: Array<ResultRowSnapshot & { review: ResultRowReview }>;
}

const GENERIC_COMPANY_WORDS = new Set(["co", "inc", "corp", "ltd", "company", "plc", "nv", "sa", "ag", "se"]);
const MAX_AUTO_SELECT_ROWS = 2;

function dateTextIso(dateText: string): string {
  const head = dateText.split(",")[0]!.trim();
  return parseDateToIso(head);
}

function isTitleCompanySpecific(companyName: string, titleText: string): boolean {
  const lower = titleText.toLowerCase();
  const words = companyName.split(/\s+/).filter((w) => w.length > 0);
  for (const word of words) {
    const lw = word.toLowerCase();
    if (GENERIC_COMPANY_WORDS.has(lw)) {
      continue;
    }
    if (lower.includes(lw)) {
      return true;
    }
  }
  return false;
}

function isAmbiguousTicker(tickerText: string, tickerExtraCount: number): boolean {
  if (tickerExtraCount > 0) {
    return true;
  }
  const t = tickerText.trim();
  return /^n\/?a$/i.test(t);
}

function companyTokens(company: string): string[] {
  return company
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !GENERIC_COMPANY_WORDS.has(token));
}

function companyMatches(rowCompany: string, taskCompany: string): boolean {
  const rowText = rowCompany.toLowerCase();
  const tokens = companyTokens(taskCompany);
  return tokens.length > 0 && tokens.some((token) => rowText.includes(token));
}

function tickerMatches(rowTicker: string, taskTicker: string): boolean {
  const tickerNorm = taskTicker.trim();
  if (!tickerNorm) {
    return true;
  }
  const pattern = new RegExp(`\\b${escapeRegExp(tickerNorm)}(?:[\\.\\^][a-z0-9]+)?\\b`, "i");
  return pattern.test(rowTicker);
}

function targetTickerInTitle(titleText: string, taskTicker: string): boolean {
  const tickerNorm = taskTicker.trim();
  if (!tickerNorm) {
    return false;
  }
  const pattern = new RegExp(`\\b${escapeRegExp(tickerNorm)}\\b`, "i");
  return pattern.test(titleText);
}

export function evaluateResultRow(
  row: ResultRowSnapshot,
  task: ResultReviewTask
): ResultRowReview {
  const reasons: string[] = [];
  const hardReasons: string[] = [];

  let rowDateIso = "";
  try {
    rowDateIso = dateTextIso(row.dateText);
  } catch {
    hardReasons.push("date_unparseable");
  }
  if (rowDateIso) {
    const eventWindow = eventWindowForTask(task);
    if (compareIsoDates(rowDateIso, task.dateFrom) < 0 || compareIsoDates(rowDateIso, task.dateTo) > 0) {
      hardReasons.push("date_out_of_range");
    }
    if (task.ccDate && compareIsoDates(rowDateIso, task.ccDate) === 0) {
      hardReasons.push("date_is_cc_date");
    }
    if (compareIsoDates(rowDateIso, eventWindow.from) < 0 || compareIsoDates(rowDateIso, eventWindow.to) > 0) {
      hardReasons.push("date_out_of_event_window");
    }
  }

  let availableIso = "";
  try {
    availableIso = dateTextIso(row.availableText);
  } catch {
    hardReasons.push("available_unparseable");
  }
  if (availableIso && (compareIsoDates(availableIso, task.dateFrom) < 0 || compareIsoDates(availableIso, task.dateTo) > 0)) {
    hardReasons.push("available_out_of_range");
  }

  const norm = (s: string) => s.trim().toLowerCase();
  if (norm(row.contributorText) !== norm(task.contributor)) {
    hardReasons.push("contributor_mismatch");
  }

  const pages = Number.parseInt(row.pagesText, 10);
  if (Number.isFinite(pages) && pages > task.maxPages) {
    hardReasons.push("pages_exceed_limit");
  }
  if (!Number.isFinite(pages)) {
    hardReasons.push("pages_unparseable");
  }

  if (!companyMatches(row.companyName, task.company)) {
    hardReasons.push("company_mismatch");
  }
  const hasAmbiguousTicker = isAmbiguousTicker(row.tickerText, row.tickerExtraCount);
  const strictTickerMatch = tickerMatches(row.tickerText, task.ticker) && row.tickerExtraCount === 0 && row.companyExtraCount === 0;
  const visibleTickerMatches = tickerMatches(row.tickerText, task.ticker) || targetTickerInTitle(row.titleText, task.ticker);
  if (!visibleTickerMatches) {
    reasons.push("ticker_mismatch");
  }

  const eligible = hardReasons.length === 0;

  if (row.companyExtraCount > 0) {
    reasons.push("multi_company_row");
  }
  if (hasAmbiguousTicker) {
    reasons.push("ambiguous_ticker");
  }
  if (!isTitleCompanySpecific(task.company, row.titleText) && !targetTickerInTitle(row.titleText, task.ticker)) {
    reasons.push("title_not_company_specific");
  }

  const reviewFlags = ["multi_company_row", "ambiguous_ticker", "title_not_company_specific"] as const;
  const needsHumanReview = reviewFlags.some((k) => reasons.includes(k));
  const downloadCategory = !eligible ? "none" : strictTickerMatch ? "ticker_matched" : "ticker_mismatch";

  return {
    eligible,
    needsHumanReview,
    autoSelect: downloadCategory !== "none",
    downloadCategory,
    reasons: [...hardReasons, ...reasons]
  };
}

export function reviewResultRows(rows: ResultRowSnapshot[], task: ResultReviewTask): ResultRowsReview {
  const reviews = rows.map((row) => ({ ...row, review: evaluateResultRow(row, task) }));
  const selectedRowIndexes = new Set(
    reviews
      .filter((row) => row.review.autoSelect)
      .sort((a, b) => compareAutoSelectPriority(a, b, task))
      .slice(0, MAX_AUTO_SELECT_ROWS)
      .map((row) => row.rowIndex)
  );
  const limitedReviews = reviews.map((row) => {
    if (!row.review.autoSelect || selectedRowIndexes.has(row.rowIndex)) {
      return row;
    }
    return {
      ...row,
      review: {
        ...row.review,
        autoSelect: false,
        reasons: [...row.review.reasons, "selection_rank_exceeded"]
      }
    };
  });
  return {
    inspectableRows: rows.length,
    autoSelectRowIndexes: limitedReviews.filter((row) => row.review.autoSelect).map((row) => row.rowIndex),
    tickerMatchedRowIndexes: limitedReviews
      .filter((row) => row.review.autoSelect && row.review.downloadCategory === "ticker_matched")
      .map((row) => row.rowIndex),
    tickerMismatchRowIndexes: limitedReviews
      .filter((row) => row.review.autoSelect && row.review.downloadCategory === "ticker_mismatch")
      .map((row) => row.rowIndex),
    humanReviewRowIndexes: limitedReviews.filter((row) => row.review.eligible && row.review.needsHumanReview).map((row) => row.rowIndex),
    rejectedRowIndexes: limitedReviews.filter((row) => !row.review.eligible).map((row) => row.rowIndex),
    reviews: limitedReviews
  };
}

function compareAutoSelectPriority(
  a: ResultRowsReview["reviews"][number],
  b: ResultRowsReview["reviews"][number],
  task: ResultReviewTask
): number {
  const distanceDelta = autoSelectDistance(a, task) - autoSelectDistance(b, task);
  if (distanceDelta !== 0) {
    return distanceDelta;
  }

  const categoryDelta = autoSelectCategoryRank(a.review.downloadCategory) - autoSelectCategoryRank(b.review.downloadCategory);
  if (categoryDelta !== 0) {
    return categoryDelta;
  }

  const rowDateDelta = compareRowDates(a, b);
  if (rowDateDelta !== 0) {
    return rowDateDelta;
  }

  return a.rowIndex - b.rowIndex;
}

function autoSelectDistance(row: ResultRowsReview["reviews"][number], task: ResultReviewTask): number {
  if (!task.ccDate) {
    return Number.POSITIVE_INFINITY;
  }
  try {
    return Math.abs(differenceInDaysIso(dateTextIso(row.dateText), task.ccDate));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function autoSelectCategoryRank(category: ResultRowReview["downloadCategory"]): number {
  return category === "ticker_matched" ? 0 : category === "ticker_mismatch" ? 1 : 2;
}

function compareRowDates(a: ResultRowsReview["reviews"][number], b: ResultRowsReview["reviews"][number]): number {
  try {
    return compareIsoDates(dateTextIso(a.dateText), dateTextIso(b.dateText));
  } catch {
    return 0;
  }
}

export function eventWindowForTask(task: Pick<ResultReviewTask, "ccDate" | "dateFrom" | "dateTo">): { from: string; to: string } {
  if (!task.ccDate) {
    return { from: task.dateFrom, to: task.dateTo };
  }
  return { from: task.ccDate, to: addDaysIso(task.ccDate, 7) };
}

export async function extractVisibleResultRows(scope: AutomationScope): Promise<ResultRowSnapshot[]> {
  return scope
    .evaluate(async () => {
      const clean = (el: Element | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
      const stripExtraCount = (text: string) => text.replace(/\+\d+\s*$/, "").trim();
      const extraCount = (text: string) => {
        const match = text.match(/\+(\d+)\s*$/);
        return match ? Number.parseInt(match[1]!, 10) : 0;
      };
      const countNumericCells = (values: string[]) =>
        values.filter((value) => /^\d{1,3}$/.test(value.trim())).length;
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      const collectRows = (
        root: ShadowRoot
      ): { rows: ResultRowSnapshot[]; rowCount: number } | null => {
        const headers = [...root.querySelectorAll(".tr-lg.title .grid-pane.columns .column")].map((el) =>
          clean(el).toLowerCase()
        );
        const columns = [...root.querySelectorAll(".tr-vlg.content .grid-pane.columns .column")];
        const indexes = {
          date: headers.findIndex((header) => header === "date" || /^date\b/.test(header)),
          available: headers.findIndex((header) => header.includes("available")),
          company: headers.findIndex((header) => header.includes("company")),
          ticker: headers.findIndex((header) => header.includes("ticker")),
          title: headers.findIndex((header) => header.includes("title")),
          pages: headers.findIndex((header) => header === "pages" || /^pages\b/.test(header)),
          contributor: headers.findIndex((header) => header.includes("contributor"))
        };
        if (indexes.date < 0 || indexes.company < 0 || indexes.title < 0 || indexes.pages < 0 || indexes.contributor < 0) {
          return null;
        }

        const valuesByColumn = columns.map((column) =>
          [...column.children]
            .filter((child) => child.classList.contains("cell"))
            .map((cell) => clean(cell))
        );
        const sampledRows = Math.min(30, Math.max(0, ...valuesByColumn.map((values) => values.length)));
        const pageHeaderIdx = indexes.pages;
        if (pageHeaderIdx >= 0) {
          const headerValues = valuesByColumn[pageHeaderIdx]?.slice(0, sampledRows) ?? [];
          const headerNumeric = countNumericCells(headerValues);
          if (headerNumeric === 0 && sampledRows > 0) {
            let bestIdx = pageHeaderIdx;
            let bestNumeric = 0;
            for (let i = 0; i < valuesByColumn.length; i += 1) {
              const numeric = countNumericCells((valuesByColumn[i] ?? []).slice(0, sampledRows));
              if (numeric > bestNumeric) {
                bestNumeric = numeric;
                bestIdx = i;
              }
            }
            if (bestNumeric > 0) {
              indexes.pages = bestIdx;
            }
          }
        }

        const rowCount = Math.max(0, ...valuesByColumn.map((values) => values.length));
        const rows: ResultRowSnapshot[] = [];
        for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
          const companyText = valuesByColumn[indexes.company]?.[rowIndex] ?? "";
          const tickerText = indexes.ticker >= 0 ? valuesByColumn[indexes.ticker]?.[rowIndex] ?? "" : "";
          const row: ResultRowSnapshot = {
            rowIndex,
            dateText: valuesByColumn[indexes.date]?.[rowIndex] ?? "",
            availableText: indexes.available >= 0 ? valuesByColumn[indexes.available]?.[rowIndex] ?? "" : "",
            companyName: stripExtraCount(companyText),
            companyExtraCount: extraCount(companyText),
            tickerText: stripExtraCount(tickerText),
            tickerExtraCount: extraCount(tickerText),
            titleText: valuesByColumn[indexes.title]?.[rowIndex] ?? "",
            pagesText: valuesByColumn[indexes.pages]?.[rowIndex] ?? "",
            contributorText: valuesByColumn[indexes.contributor]?.[rowIndex] ?? ""
          };
          if (
            row.dateText ||
            row.titleText ||
            row.companyName ||
            row.pagesText ||
            row.contributorText ||
            row.tickerText
          ) {
            rows.push(row);
          }
        }
        return { rows, rowCount };
      };

      const scrollHorizontally = (root: ShadowRoot, toRight: boolean) => {
        const scrollers = [
          ...root.querySelectorAll<HTMLElement>(".tr-vlg.content .grid-pane, .tr-vlg.content .grid-pane.columns")
        ].filter((el) => el.scrollWidth > el.clientWidth + 10);
        for (const el of scrollers) {
          el.scrollLeft = toRight ? el.scrollWidth : 0;
        }
      };

      for (const grid of [...document.querySelectorAll("app-main-grid emerald-grid, emerald-grid")]) {
        const root = grid.shadowRoot;
        if (!root) {
          continue;
        }

        const left = collectRows(root);
        if (!left || left.rows.length === 0) {
          continue;
        }

        let mergedRows = left.rows;
        const leftPages = mergedRows.filter((row) => /^\d{1,3}$/.test(row.pagesText.trim())).length;
        const leftContrib = mergedRows.filter((row) => row.contributorText.trim().length > 0).length;
        if ((leftPages === 0 || leftContrib === 0) && left.rowCount > 0) {
          scrollHorizontally(root, true);
          await wait(120);
          const right = collectRows(root);
          if (right && right.rows.length > 0) {
            const rightByIndex = new Map(right.rows.map((row) => [row.rowIndex, row]));
            mergedRows = mergedRows.map((row) => {
              const fallback = rightByIndex.get(row.rowIndex);
              if (!fallback) {
                return row;
              }
              return {
                ...row,
                pagesText: row.pagesText || fallback.pagesText,
                contributorText: row.contributorText || fallback.contributorText
              };
            });
          }
          scrollHorizontally(root, false);
          await wait(60);
        }

        if (mergedRows.length > 0) {
          return mergedRows;
        }
      }
      return [];
    })
    .catch(() => []);
}

export async function selectResultRowsByIndex(
  scope: AutomationScope,
  rowIndexes: number[]
): Promise<{ requested: number; selected: number; inspectableRows: number }> {
  return scope
    .evaluate(async (requestedRows) => {
      const requested = new Set(requestedRows);
      for (const grid of [...document.querySelectorAll("app-main-grid emerald-grid, emerald-grid")]) {
        const root = grid.shadowRoot;
        if (!root) {
          continue;
        }
        const checkboxes = [...root.querySelectorAll<HTMLElement>("coral-checkbox.selected-doc-checkbox")];
        if (checkboxes.length === 0) {
          continue;
        }
        for (let rowIndex = 0; rowIndex < checkboxes.length; rowIndex += 1) {
          const checkbox = checkboxes[rowIndex];
          if (!checkbox) {
            continue;
          }
          const shouldBeChecked = requested.has(rowIndex);
          const checked = isChecked(checkbox);
          if (shouldBeChecked !== checked) {
            clickCheckbox(checkbox);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
        const selected = requestedRows.filter((rowIndex) => isChecked(checkboxes[rowIndex])).length;
        return { requested: requestedRows.length, selected, inspectableRows: checkboxes.length };
      }
      return { requested: requestedRows.length, selected: 0, inspectableRows: 0 };

      function isChecked(checkbox: Element | undefined | null): boolean {
        if (!checkbox) {
          return false;
        }
        return (
          checkbox.hasAttribute("checked") ||
          (checkbox as HTMLInputElement).checked === true ||
          checkbox.getAttribute("aria-checked") === "true"
        );
      }
      function clickCheckbox(checkbox: HTMLElement): void {
        const shadowTarget =
          checkbox.shadowRoot?.querySelector<HTMLElement>("[part='check']") ??
          checkbox.shadowRoot?.querySelector<HTMLElement>("[part='container']") ??
          checkbox.shadowRoot?.querySelector<HTMLElement>("div");
        (shadowTarget ?? checkbox).click();
      }
    }, rowIndexes)
    .catch(() => ({ requested: rowIndexes.length, selected: 0, inspectableRows: 0 }));
}

export interface CompanyListReview {
  ok: boolean;
  needsHumanReview: boolean;
  reason: string;
  matchedRows: number;
  unrelatedRows: number;
  sampledRows: string[];
}

export async function reviewResultCompanyList(
  scope: AutomationScope,
  config: LsegConfig,
  company: string,
  ticker: string
): Promise<CompanyListReview> {
  const tableRows = await scope.evaluate(() => {
    const visible = (el: Element) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 2 && rect.height > 2;
    };

    for (const table of [...document.querySelectorAll("table")]) {
      if (!visible(table)) {
        continue;
      }
      const headers = [...table.querySelectorAll("th, [role='columnheader']")].map((el) =>
        (el.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase()
      );
      const companyIndex = headers.findIndex((h) => h.includes("company"));
      const tickerIndex = headers.findIndex((h) => h.includes("ticker"));
      if (companyIndex < 0) {
        continue;
      }

      const out: string[] = [];
      const rows = [...table.querySelectorAll("tbody tr, [role='rowgroup'] [role='row']")].filter(visible);
      for (const row of rows.slice(0, 30)) {
        const cells = [...row.querySelectorAll("td, [role='cell']")];
        const companyText = (cells[companyIndex]?.textContent ?? "").replace(/\s+/g, " ").trim();
        const tickerText = tickerIndex >= 0 ? (cells[tickerIndex]?.textContent ?? "").replace(/\s+/g, " ").trim() : "";
        if (!companyText && !tickerText) {
          continue;
        }
        out.push(`${companyText} ${tickerText}`.trim());
      }
      if (out.length > 0) {
        return out;
      }
    }

    const emeraldRows = extractEmeraldGridRows();
    if (emeraldRows.length > 0) {
      return emeraldRows;
    }

    return [];

    function extractEmeraldGridRows(): string[] {
      const root = document.querySelector("app-main-grid emerald-grid")?.shadowRoot;
      if (!root) {
        return [];
      }

      const clean = (el: Element | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
      const headers = [...root.querySelectorAll(".tr-lg.title .grid-pane.columns .column")].map((el) =>
        clean(el).toLowerCase()
      );
      const columns = [...root.querySelectorAll(".tr-vlg.content .grid-pane.columns .column")];
      const companyIndex = headers.findIndex((header) => header.includes("company"));
      const tickerIndex = headers.findIndex((header) => header.includes("ticker"));
      const titleIndex = headers.findIndex((header) => header.includes("title"));
      const dateIndex = headers.findIndex((header) => header === "date" || /^date\b/.test(header));
      if (companyIndex < 0 && tickerIndex < 0) {
        return [];
      }

      const valuesByColumn = columns.map((column) =>
        [...column.children]
          .filter((child) => child.classList.contains("cell"))
          .map((cell) => clean(cell))
      );
      const rowCount = Math.max(0, ...valuesByColumn.map((values) => values.length));
      const rows: string[] = [];
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const parts = [dateIndex, companyIndex, tickerIndex, titleIndex]
          .filter((index) => index >= 0)
          .map((index) => valuesByColumn[index]?.[rowIndex] ?? "")
          .filter(Boolean);
        if (parts.length > 0) {
          rows.push(parts.join(" "));
        }
      }
      return rows;
    }
  });

  if (tableRows.length > 0) {
    return evaluateCompanyRows(tableRows, company, ticker);
  }

  const rows: string[] = [];
  for (const selector of config.selectors.result_rows) {
    const locator = scope.locator(selector);
    let count = 0;
    try {
      count = Math.min(await locator.count(), 30);
    } catch {
      continue;
    }
    for (let i = 0; i < count; i += 1) {
      try {
        const text = (await locator.nth(i).innerText({ timeout: 500 })).replace(/\s+/g, " ").trim();
        if (looksLikeResultRow(text)) {
          rows.push(text);
        }
      } catch {
        continue;
      }
    }
    if (rows.length > 0) {
      break;
    }
  }

  return evaluateCompanyRows(rows, company, ticker);
}

export function evaluateCompanyRows(rows: string[], company: string, ticker: string): CompanyListReview {
  const tokens = company
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !GENERIC_COMPANY_WORDS.has(token));
  const tickerNorm = ticker.trim().toLowerCase();
  const tickerPattern = tickerNorm ? new RegExp(`\\b${escapeRegExp(tickerNorm)}(?:[\\.\\^][a-z0-9]+)?\\b`, "i") : null;

  let matchedRows = 0;
  let unrelatedRows = 0;
  for (const row of rows) {
    const text = row.toLowerCase();
    const byCompany = tokens.some((token) => text.includes(token));
    const byTicker = tickerPattern ? tickerPattern.test(text) : false;
    if (byCompany || byTicker) {
      matchedRows += 1;
    } else {
      unrelatedRows += 1;
    }
  }

  if (rows.length === 0) {
    return {
      ok: false,
      needsHumanReview: true,
      reason: "no_rows_sampled_for_company_review",
      matchedRows,
      unrelatedRows,
      sampledRows: []
    };
  }
  if (matchedRows === 0) {
    return {
      ok: false,
      needsHumanReview: true,
      reason: "no_target_company_in_results",
      matchedRows,
      unrelatedRows,
      sampledRows: rows.slice(0, 8)
    };
  }
  if (unrelatedRows > matchedRows) {
    return {
      ok: false,
      needsHumanReview: true,
      reason: "results_mostly_unrelated_companies",
      matchedRows,
      unrelatedRows,
      sampledRows: rows.slice(0, 8)
    };
  }

  return {
    ok: true,
    needsHumanReview: false,
    reason: "result_company_list_validated",
    matchedRows,
    unrelatedRows,
    sampledRows: rows.slice(0, 8)
  };
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikeResultRow(text: string): boolean {
  const hasDate = /\b\d{1,2}-[A-Za-z]{3}-\d{4}\b/.test(text);
  const hasTickerOrNA = /\b[A-Z]{1,6}(?:\.[A-Z0-9]+)+\b/.test(text) || /\bN\/A\b/i.test(text);
  return hasDate && hasTickerOrNA;
}
