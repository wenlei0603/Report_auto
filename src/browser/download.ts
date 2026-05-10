import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import type { LsegConfig } from "../config.js";
import { timestampIso } from "../domain/dates.js";
import type { DownloadArtifact, MappingRecord, RequestTask } from "../domain/types.js";
import { inspectPdf } from "../io/pdf.js";
import { sanitizeFilename } from "../utils/filename.js";
import { sha256File } from "../utils/hash.js";
import { clickFirst } from "./locators.js";
import { extractVisibleResultRows, reviewResultRows, selectResultRowsByIndex } from "./results.js";
import type { ResultRowsReview } from "./results.js";
import type { AutomationScope } from "./types.js";

export interface BulkDownloadResult {
  ok: boolean;
  status: "downloaded" | "no_downloadable_report" | "task_failed" | "special_company_case" | "page_limit";
  pages: number;
  artifacts: DownloadArtifact[];
  mappingRecords: MappingRecord[];
  error: string;
  rowSelection?: DownloadRowSelection | undefined;
}

interface RowSelectionResult {
  ok: boolean;
  status: "no_downloadable_report" | "special_company_case" | "page_limit";
  error: string;
  rowSelection?: DownloadRowSelection | undefined;
}

interface PdfLandingBaseline {
  capturedAtMs: number;
  pdfMtimes: Map<string, number>;
}

interface PdfLandingResult {
  complete: boolean;
  paths: string[];
  expected: number;
  activeDownloads: number;
}

export interface DownloadRowSelection {
  inspectableRows: number;
  requested: number;
  selected: number;
  tickerMatched: number;
  tickerMismatch: number;
  selectedRows: DownloadRowSelectionItem[];
  rejectedRows: DownloadRowSelectionItem[];
}

export interface DownloadRowSelectionItem {
  rowIndex: number;
  category: "ticker_matched" | "ticker_mismatch" | "none";
  date: string;
  available: string;
  company: string;
  ticker: string;
  title: string;
  pages: string;
  contributor: string;
  reasons: string[];
}

export async function executeBulkDownload(input: {
  page: Page;
  scope: AutomationScope;
  config: LsegConfig;
  task: RequestTask;
  accountId?: string | undefined;
  estimatedPages: number;
  reserveSelectedPages?: (rowSelection: DownloadRowSelection, selectedPages: number) => Promise<{ ok: boolean; error: string }>;
}): Promise<BulkDownloadResult> {
  const { page, scope, config, task, estimatedPages } = input;
  await disconnectInteractionLink(scope, page);

  const selected = await ensureEligibleRowsSelected(scope, config, page, task, input.reserveSelectedPages, estimatedPages);
  if (!selected.ok) {
    return failed(selected.status, selected.error, selected.rowSelection, selectedRowPages(selected.rowSelection));
  }
  await page.waitForTimeout(250);

  try {
    // Keep this promise rejection-handled in all branches, otherwise
    // early returns can leave an unhandled rejection when the page closes.
    const downloadPromise = page
      .waitForEvent("download", { timeout: config.timeouts.download_ms })
      .catch(() => null);
    await disconnectInteractionLink(scope, page);
    const clickedDownload = await clickFirst(scope, config.selectors.download_buttons);
    if (!clickedDownload) {
      return failed("no_downloadable_report", "download_button_not_found");
    }

    const pdfBaseline = await snapshotPdfCandidates(config, task.taskId);
    const clickedSave = await waitAndClickSave(scope, config, page);
    const detachedResult = await detachOnBatchSavePrint(page, config, task, input.accountId, estimatedPages, pdfBaseline, selected.rowSelection);
    if (detachedResult) {
      return detachedResult;
    }

    const download = await downloadPromise;
    if (!download) {
      return failed(
        "task_failed",
        clickedSave ? "download_event_missing_or_page_closed" : "save_to_pc_button_not_found_or_download_event_missing"
      );
    }
    const suggestedFilename = sanitizeFilename(download.suggestedFilename() || `${task.taskId}_bulk.pdf`, 180);
    const finalName = suggestedFilename.toLowerCase().endsWith(".pdf") ? suggestedFilename : `${suggestedFilename}.pdf`;
    const taskDir = path.resolve(config.download_dir, "by_task", task.taskId);
    await mkdir(taskDir, { recursive: true });
    const targetPath = await uniquePath(path.resolve(taskDir, finalName));
    await download.saveAs(targetPath);

    const info = await stat(targetPath);
    const pdf = await inspectPdf(targetPath);
    if (!pdf.isPdf) {
      return failed("task_failed", `downloaded_file_is_not_pdf:${targetPath}`);
    }

    const pages = pdf.pages || estimatedPages || 1;
    const artifact: DownloadArtifact = {
      path: targetPath,
      suggestedFilename: finalName,
      sha256: await sha256File(targetPath),
      bytes: info.size,
      pages
    };
    const mapping: MappingRecord = {
      ...(input.accountId ? { accountId: input.accountId } : {}),
      timestamp: timestampIso(),
      taskId: task.taskId,
      company: task.company,
      dateFrom: task.dateFrom,
      dateTo: task.dateTo,
      reportTitle: bulkReportTitle(selected.rowSelection),
      reportDate: "",
      pages,
      filePath: targetPath,
      status: "downloaded",
      error: "",
      sourceUrl: page.url()
    };

    return {
      ok: true,
      status: "downloaded",
      pages,
      artifacts: [artifact],
      mappingRecords: [mapping],
      error: "",
      rowSelection: selected.rowSelection
    };
  } catch (error) {
    return failed("task_failed", String(error), selected.rowSelection);
  }
}

export function shouldWaitBeforeReconnect(error: string): boolean {
  return error === "cdp_detached_after_batchsaveprint_manual_download_expected";
}

export function isPdfLandingHandoff(error: string): boolean {
  return error === "human_review_required:pdf_landing_timeout_after_batchsaveprint";
}

export function isBatchSavePrintAppUrl(url: string): boolean {
  return /\/Apps\/BatchSavePrint(?:\/|\?|$)/i.test(url);
}

async function detachOnBatchSavePrint(
  page: Page,
  config: LsegConfig,
  task: RequestTask,
  accountId: string | undefined,
  estimatedPages: number,
  baseline: PdfLandingBaseline,
  rowSelection: DownloadRowSelection | undefined
): Promise<BulkDownloadResult | null> {
  // User-observed behavior: once BatchSavePrint opens under CDP attachment,
  // direct download reliability drops. Detach immediately to let native browser
  // finish the save flow.
  if (!config.cdp_endpoint.trim()) {
    return null;
  }
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const urls = page.context().pages().map((p) => p.url());
    if (urls.some(isBatchSavePrintAppUrl)) {
      await page.context().browser()?.close().catch(() => undefined);
      const expectedPdfCount = expectedNativePdfCount(rowSelection);
      const landed = await waitForLandedPdfs(
        config,
        task.taskId,
        baseline,
        nativePdfWaitTimeoutMs(expectedPdfCount),
        expectedPdfCount
      );
      if (!landed.complete) {
        return failed(
          "special_company_case",
          `human_review_required:pdf_landing_incomplete_after_batchsaveprint:expected=${landed.expected};landed=${landed.paths.length};active=${landed.activeDownloads}`,
          rowSelection
        );
      }
      return buildNativeLandingResult(config, task, accountId, landed.paths, estimatedPages, rowSelection);
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function ensureEligibleRowsSelected(
  scope: AutomationScope,
  config: LsegConfig,
  page: Page,
  task: RequestTask,
  reserveSelectedPages: ((rowSelection: DownloadRowSelection, selectedPages: number) => Promise<{ ok: boolean; error: string }>) | undefined,
  estimatedPages: number
): Promise<RowSelectionResult> {
  const rows = await extractVisibleResultRows(scope);
  if (rows.length > 0) {
    const review = reviewResultRows(rows, {
      company: task.company,
      ticker: task.ticker,
      ccDate: task.ccDate,
      dateFrom: task.dateFrom,
      dateTo: task.dateTo,
      contributor: config.filters.contributor,
      maxPages: config.filters.max_pages
    });

    if (review.autoSelectRowIndexes.length === 0) {
      const status = review.humanReviewRowIndexes.length > 0 ? "special_company_case" : "no_downloadable_report";
      const prefix = status === "special_company_case" ? "human_review_required" : "no_auto_selectable_rows";
      return {
        ok: false,
        status,
        error: `${prefix}:${compactResultReviewReason(review)}`,
        rowSelection: buildRowSelection(review, 0)
      };
    }

    const candidateSelection = buildRowSelection(review, 0);
    const pagesToReserve = Math.max(1, selectedRowPages(candidateSelection) || estimatedPages);
    if (reserveSelectedPages) {
      const reservation = await reserveSelectedPages(candidateSelection, pagesToReserve);
      if (!reservation.ok) {
        return {
          ok: false,
          status: "page_limit",
          error: reservation.error,
          rowSelection: candidateSelection
        };
      }
    }

    const selected = await selectResultRowsByIndex(scope, review.autoSelectRowIndexes);
    if (selected.selected > 0) {
      return { ok: true, status: "no_downloadable_report", error: "", rowSelection: buildRowSelection(review, selected.selected) };
    }
    return {
      ok: false,
      status: "no_downloadable_report",
      error: `row_checkbox_selection_not_confirmed:requested=${selected.requested};selected=${selected.selected};inspectable=${selected.inspectableRows}`,
      rowSelection: buildRowSelection(review, selected.selected)
    };
  }

  const fallbackSelected = await ensureRowsSelected(scope, config, page);
  return fallbackSelected
    ? { ok: true, status: "no_downloadable_report", error: "" }
    : { ok: false, status: "no_downloadable_report", error: "select_all_fallback_failed_no_rows_selected" };
}

function buildRowSelection(review: ResultRowsReview, selected: number): DownloadRowSelection {
  const selectedRows = review.reviews.filter((row) => row.review.autoSelect).map(rowSelectionItem);
  const rejectedRows = review.reviews.filter((row) => !row.review.autoSelect).map(rowSelectionItem);
  return {
    inspectableRows: review.inspectableRows,
    requested: selectedRows.length,
    selected,
    tickerMatched: selectedRows.filter((row) => row.category === "ticker_matched").length,
    tickerMismatch: selectedRows.filter((row) => row.category === "ticker_mismatch").length,
    selectedRows,
    rejectedRows
  };
}

function rowSelectionItem(row: ResultRowsReview["reviews"][number]): DownloadRowSelectionItem {
  return {
    rowIndex: row.rowIndex,
    category: row.review.downloadCategory,
    date: row.dateText,
    available: row.availableText,
    company: row.companyName,
    ticker: row.tickerText,
    title: row.titleText,
    pages: row.pagesText,
    contributor: row.contributorText,
    reasons: row.review.reasons
  };
}

function bulkReportTitle(rowSelection: DownloadRowSelection | undefined): string {
  if (!rowSelection) {
    return "(bulk_selected_results)";
  }
  return `(bulk_selected_results;ticker_matched=${rowSelection.tickerMatched};ticker_mismatch=${rowSelection.tickerMismatch};selected=${rowSelection.selected})`;
}

function compactResultReviewReason(review: ReturnType<typeof reviewResultRows>): string {
  const reasonCounts = new Map<string, number>();
  for (const row of review.reviews) {
    for (const reason of row.review.reasons) {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
  }
  const reasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason}=${count}`)
    .join(",");
  return `inspectable=${review.inspectableRows};auto=${review.autoSelectRowIndexes.length};human=${review.humanReviewRowIndexes.length};rejected=${review.rejectedRowIndexes.length};reasons=${reasons}`;
}

async function snapshotPdfCandidates(config: LsegConfig, taskId: string): Promise<PdfLandingBaseline> {
  const capturedAtMs = Date.now();
  const files = await listPdfCandidates(config, taskId);
  return {
    capturedAtMs,
    pdfMtimes: new Map(files.map((file) => [file.path, file.mtimeMs]))
  };
}

async function waitForLandedPdfs(
  config: LsegConfig,
  taskId: string,
  baseline: PdfLandingBaseline,
  timeoutMs: number,
  expectedPdfCount: number
): Promise<PdfLandingResult> {
  const expected = Math.max(1, expectedPdfCount);
  const deadline = Date.now() + timeoutMs;
  let latest: PdfLandingResult = { complete: false, paths: [], expected, activeDownloads: 0 };
  while (Date.now() < deadline) {
    const candidates = await listPdfCandidates(config, taskId);
    const fresh = candidates.filter((file) => !baseline.pdfMtimes.has(file.path) || file.mtimeMs > (baseline.pdfMtimes.get(file.path) ?? 0));
    const stable: string[] = [];
    for (const file of fresh) {
      const before = await stat(file.path).catch(() => null);
      if (!before || before.size <= 0) {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const after = await stat(file.path).catch(() => null);
      if (after && after.size === before.size && after.mtimeMs === before.mtimeMs) {
        stable.push(file.path);
      }
    }
    const activeDownloads = await listActiveDownloadTempCandidates(config, taskId, baseline.capturedAtMs);
    latest = {
      complete: stable.length >= expected && activeDownloads.length === 0,
      paths: stable,
      expected,
      activeDownloads: activeDownloads.length
    };
    if (latest.complete) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return latest;
}

export function nativePdfWaitTimeoutMs(expectedPdfCount: number): number {
  return Math.max(150_000, Math.min(900_000, Math.max(1, expectedPdfCount) * 90_000));
}

export function expectedNativePdfCount(rowSelection: DownloadRowSelection | undefined): number {
  return Math.max(1, rowSelection?.selected ?? rowSelection?.requested ?? 1);
}

export function selectedRowPages(rowSelection: DownloadRowSelection | undefined): number {
  return (rowSelection?.selectedRows ?? []).reduce((sum, row) => sum + parsePageCount(row.pages), 0);
}

function parsePageCount(value: string): number {
  const match = String(value ?? "").match(/\b(\d+)\b/);
  return match ? Math.max(0, Number.parseInt(match[1] ?? "0", 10)) : 0;
}

export function isActiveDownloadTempFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.endsWith(".crdownload") || lower.endsWith(".download") || lower.endsWith(".tmp");
}

async function listPdfCandidates(config: LsegConfig, taskId: string): Promise<Array<{ path: string; mtimeMs: number }>> {
  const directories = candidateDownloadDirectories(config, taskId);
  const files: Array<{ path: string; mtimeMs: number }> = [];
  for (const directory of directories) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".pdf")) {
        continue;
      }
      const filePath = path.resolve(directory, entry.name);
      const info = await stat(filePath).catch(() => null);
      if (info?.isFile()) {
        files.push({ path: filePath, mtimeMs: info.mtimeMs });
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function listActiveDownloadTempCandidates(
  config: LsegConfig,
  taskId: string,
  capturedAtMs: number
): Promise<Array<{ path: string; mtimeMs: number }>> {
  const directories = candidateDownloadDirectories(config, taskId);
  const files: Array<{ path: string; mtimeMs: number }> = [];
  for (const directory of directories) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !isActiveDownloadTempFileName(entry.name)) {
        continue;
      }
      const filePath = path.resolve(directory, entry.name);
      const info = await stat(filePath).catch(() => null);
      if (info?.isFile() && info.mtimeMs >= capturedAtMs - 5000) {
        files.push({ path: filePath, mtimeMs: info.mtimeMs });
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function candidateDownloadDirectories(config: LsegConfig, taskId: string): string[] {
  const userDownloads = process.env.USERPROFILE ? path.resolve(process.env.USERPROFILE, "Downloads") : "";
  return Array.from(
    new Set(
      [
        path.resolve(config.download_dir),
        path.resolve(config.download_dir, "by_task", taskId),
        userDownloads,
        config.browser.user_data_dir ? path.resolve(config.browser.user_data_dir, "Downloads") : "",
        config.browser.user_data_dir ? path.resolve(config.browser.user_data_dir, "Default", "Downloads") : ""
      ].filter(Boolean)
    )
  );
}

async function buildNativeLandingResult(
  config: LsegConfig,
  task: RequestTask,
  accountId: string | undefined,
  landedPaths: string[],
  estimatedPages: number,
  rowSelection: DownloadRowSelection | undefined
): Promise<BulkDownloadResult> {
  const taskDir = path.resolve(config.download_dir, "by_task", task.taskId);
  await mkdir(taskDir, { recursive: true });
  const artifacts: DownloadArtifact[] = [];
  const mappingRecords: MappingRecord[] = [];
  for (const sourcePath of landedPaths) {
    const sourceName = sanitizeFilename(path.basename(sourcePath), 180);
    const targetPath = await uniquePath(path.resolve(taskDir, sourceName.toLowerCase().endsWith(".pdf") ? sourceName : `${sourceName}.pdf`));
    await copyFile(sourcePath, targetPath).catch(async () => {
      if (sourcePath !== targetPath) {
        throw new Error(`Failed to archive native PDF: ${sourcePath}`);
      }
    });
    const info = await stat(targetPath);
    const pdf = await inspectPdf(targetPath);
    if (!pdf.isPdf) {
      continue;
    }
    const pages = pdf.pages || estimatedPages || 1;
    artifacts.push({
      path: targetPath,
      suggestedFilename: path.basename(targetPath),
      sha256: await sha256File(targetPath),
      bytes: info.size,
      pages
    });
    mappingRecords.push({
      ...(accountId ? { accountId } : {}),
      timestamp: timestampIso(),
      taskId: task.taskId,
      company: task.company,
      dateFrom: task.dateFrom,
      dateTo: task.dateTo,
      reportTitle: bulkReportTitle(rowSelection),
      reportDate: "",
      pages,
      filePath: targetPath,
      status: "downloaded",
      error: "",
      sourceUrl: "BatchSavePrint native download"
    });
  }
  if (artifacts.length === 0) {
    return failed("special_company_case", "human_review_required:native_pdf_landed_but_not_verifiable");
  }
  return {
    ok: true,
    status: "downloaded",
    pages: artifacts.reduce((sum, artifact) => sum + artifact.pages, 0),
    artifacts,
    mappingRecords,
    error: "",
    rowSelection
  };
}

async function disconnectInteractionLink(scope: AutomationScope, page: Page): Promise<void> {
  try {
    await scope.evaluate(() => {
      const companyEl = document.querySelector<any>("app-companies-filter emerald-multi-select");
      if (companyEl) {
        companyEl.opened = false;
        companyEl.query = "";
      }

      const companyInput = document.querySelector(
        "app-companies-filter emerald-multi-select input[placeholder*='Search by company' i]"
      ) as HTMLInputElement | null;
      companyInput?.blur();

      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body) {
        active.blur();
      }

      const popups = [...document.querySelectorAll("coral-popup-panel.popup-dialog")] as HTMLElement[];
      for (const popup of popups) {
        const buttons = [...popup.querySelectorAll("coral-button")] as HTMLElement[];
        const closeButton =
          buttons.find((button) => (button.textContent ?? "").trim().toLowerCase() === "cancel") ??
          (popup.querySelector("coral-button[icon='cross']") as HTMLElement | null);
        closeButton?.click();
      }
    });
  } catch {
    // Best-effort UI stabilization step.
  }

  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(150);
}

async function ensureRowsSelected(scope: AutomationScope, config: LsegConfig, page: Page): Promise<boolean> {
  const attempts = 4;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await disconnectInteractionLink(scope, page);
    const before = await selectedCount(scope);
    if (before > 0) {
      return true;
    }

    const clicked = await clickFirst(scope, config.selectors.select_all_checkboxes);
    if (!clicked) {
      return false;
    }

    await page.waitForTimeout(250);
    const afterClick = await selectedCount(scope);
    if (afterClick > 0) {
      return true;
    }

    await disconnectInteractionLink(scope, page);
    const shadowClicked = await clickSelectAllShadowCheck(scope);
    if (shadowClicked) {
      await page.waitForTimeout(250);
      const afterShadow = await selectedCount(scope);
      if (afterShadow > 0) {
        return true;
      }
    }
  }
  return false;
}

async function selectedCount(scope: AutomationScope): Promise<number> {
  try {
    const count = await scope
      .locator("coral-checkbox.select-doc-checkbox")
      .first()
      .evaluate((el) => {
        const tooltip = el.getAttribute("tooltip") ?? "";
        const match = tooltip.match(/(\d+)\s*Checked/i);
        return match ? Number.parseInt(match[1] ?? "0", 10) : 0;
      });
    return Number.isFinite(count) ? count : 0;
  } catch {
    return 0;
  }
}

async function clickSelectAllShadowCheck(scope: AutomationScope): Promise<boolean> {
  try {
    return await scope
      .locator("coral-checkbox.select-doc-checkbox")
      .first()
      .evaluate((el) => {
        const shadow = el.shadowRoot;
        const target =
          shadow?.querySelector<HTMLElement>("[part='check']") ??
          shadow?.querySelector<HTMLElement>("[part='container']") ??
          shadow?.querySelector<HTMLElement>("div");
        if (!target) {
          return false;
        }
        target.click();
        return true;
      });
  } catch {
    return false;
  }
}

async function waitAndClickSave(scope: AutomationScope, config: LsegConfig, page: Page): Promise<boolean> {
  const deadline = Date.now() + config.timeouts.download_ms;
  while (Date.now() < deadline) {
    if (await clickFirst(scope, config.selectors.save_to_pc_buttons, 700)) {
      return true;
    }
    await page.waitForTimeout(350);
  }
  return false;
}

async function uniquePath(filePath: string): Promise<string> {
  try {
    await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return filePath;
    }
    throw error;
  }

  const parsed = path.parse(filePath);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.resolve(parsed.dir, `${parsed.name} (${i})${parsed.ext}`);
    try {
      await stat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return candidate;
      }
      throw error;
    }
  }
  throw new Error(`Could not allocate unique path for ${filePath}`);
}

function failed(
  status: "no_downloadable_report" | "task_failed" | "special_company_case" | "page_limit",
  error: string,
  rowSelection?: DownloadRowSelection,
  pages = 0
): BulkDownloadResult {
  return {
    ok: false,
    status,
    pages,
    artifacts: [],
    mappingRecords: [],
    error,
    rowSelection
  };
}
