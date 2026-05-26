import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LsegConfig } from "../src/config.js";
import type { DownloadRowSelection } from "../src/browser/download.js";

const mocks = vi.hoisted(() => {
  const fakePage = {
    isClosed: vi.fn(() => false),
    url: vi.fn(() => "https://workspace.refinitiv.example/search")
  };
  const fakeBrowser = {
    isConnected: vi.fn(() => true),
    close: vi.fn(async () => undefined)
  };
  const fakeScope = {
    url: vi.fn(() => "https://workspace.refinitiv.example/search")
  };
  const store = {
    initialize: vi.fn(async () => undefined),
    doneTaskIds: vi.fn(async () => new Set<string>()),
    dailyPages: vi.fn(async () => 641),
    writeStatus: vi.fn(async () => undefined),
    appendMapping: vi.fn(async () => undefined)
  };
  return {
    executeBulkDownload: vi.fn(),
    fakePage,
    fakeBrowser,
    fakeScope,
    store,
    loggerEvent: vi.fn(async () => undefined)
  };
});

vi.mock("../src/browser/download.js", () => ({
  executeBulkDownload: mocks.executeBulkDownload
}));

vi.mock("../src/browser/filters.js", () => ({
  applyGlobalFilters: vi.fn(async () => ({ ok: true, details: {} })),
  applyTaskFilters: vi.fn(async () => ({
    okCompany: true,
    okFrom: true,
    okTo: true,
    closedBlankTabs: 0,
    companyDetails: {}
  })),
  ensureQueryMode: vi.fn(async () => true)
}));

vi.mock("../src/browser/results.js", () => ({
  reviewResultCompanyList: vi.fn(async () => ({ ok: true, needsHumanReview: false, reason: "" }))
}));

vi.mock("../src/browser/session.js", () => ({
  openBrowserSession: vi.fn(async () => ({ page: mocks.fakePage, browser: mocks.fakeBrowser }))
}));

vi.mock("../src/browser/scope.js", () => ({
  getResearchScope: vi.fn(() => mocks.fakeScope),
  waitForResearchScope: vi.fn(async () => mocks.fakeScope)
}));

vi.mock("../src/browser/state.js", () => ({
  classifyAppState: vi.fn(async () => ({
    state: "research",
    pageUrl: "https://workspace.refinitiv.example/search",
    reason: "mocked"
  })),
  classifyResults: vi.fn(async () => ({
    status: "results",
    rowCount: 4,
    estimatedPages: 70,
    reason: "record_count_visible"
  }))
}));

vi.mock("../src/browser/viewport.js", () => ({
  ensureUsableViewport: vi.fn(async () => undefined)
}));

vi.mock("../src/domain/tasks.js", () => ({
  loadTasks: vi.fn(async () => [
    {
      taskId: "T2580",
      rowNumber: 2580,
      permno: "12345",
      company: "NVIDIA Corp",
      ticker: "NVDA",
      ccDate: "2017-08-10",
      dateFrom: "2017-08-10",
      dateTo: "2017-08-17",
      rawLine: ""
    }
  ])
}));

vi.mock("../src/io/records.js", () => ({
  RecordStore: vi.fn(function () {
    return mocks.store;
  })
}));

vi.mock("../src/io/runLogger.js", () => ({
  RunLogger: vi.fn(function () {
    return { event: mocks.loggerEvent };
  })
}));

const selectedRows: DownloadRowSelection = {
  inspectableRows: 4,
  requested: 2,
  selected: 2,
  tickerMatched: 2,
  tickerMismatch: 0,
  selectedRows: [
    {
      rowIndex: 0,
      category: "ticker_matched",
      date: "23-Aug-2017",
      available: "",
      company: "NVIDIA Corp",
      ticker: "NVDA.OQ",
      title: "NVIDIA Corp.: First note",
      pages: "8",
      contributor: "Morgan Stanley",
      scoreTotal: 100,
      scoreBreakdown: { tickerScore: 40, titleScore: 35, dateScore: 25, penalties: 0, industryPenaltyApplied: false },
      reasons: []
    },
    {
      rowIndex: 3,
      category: "ticker_matched",
      date: "11-Aug-2017",
      available: "",
      company: "NVIDIA Corp",
      ticker: "NVDA.OQ",
      title: "NVIDIA Corp.: Another strong quarter",
      pages: "8",
      contributor: "Morgan Stanley",
      scoreTotal: 100,
      scoreBreakdown: { tickerScore: 40, titleScore: 35, dateScore: 25, penalties: 0, industryPenaltyApplied: false },
      reasons: []
    }
  ],
  rejectedRows: [
    {
      rowIndex: 1,
      category: "none",
      date: "21-Aug-2017",
      available: "",
      company: "NVIDIA Corp",
      ticker: "NVDA.OQ",
      title: "NVIDIA Corp.: Long note",
      pages: "28",
      contributor: "Morgan Stanley",
      scoreTotal: 0,
      scoreBreakdown: { tickerScore: 0, titleScore: 0, dateScore: 0, penalties: 0, industryPenaltyApplied: false },
      reasons: ["pages_exceed_limit"]
    }
  ]
};

function makeConfig(): LsegConfig {
  return {
    workspace_url: "https://workspace.refinitiv.example",
    input_file: "tasks.txt",
    download_dir: "downloads",
    mapping_csv: "mapping.csv",
    status_log_jsonl: "status.jsonl",
    progress_csv: "progress.csv",
    run_log_jsonl: "run.jsonl",
    daily_page_limit: 700,
    max_downloads: 0,
    cdp_endpoint: "http://127.0.0.1:9222",
    browser: {
      headless: false,
      slow_mo_ms: 0,
      fallback_channel: "chrome",
      user_data_dir: ".browser"
    },
    filters: {
      contributor: "Morgan Stanley",
      country: "United States of America",
      industry: "",
      max_pages: 23
    },
    timeouts: {
      default_ms: 1000,
      download_ms: 1000,
      login_wait_seconds: 1
    },
    behavior: {
      apply_global_filters_once: true,
      app_restart_attempts: 0,
      recover_from_batchsaveprint: true,
      require_download_artifacts: true,
      debug_max_tasks: 0,
      stop_on_page_limit: true
    },
    selectors: {
      company_input: [],
      company_option_items: [],
      apply_buttons: [],
      modify_query_buttons: [],
      result_rows: [],
      no_results_text: [],
      next_page_buttons: [],
      download_buttons: [],
      select_all_checkboxes: [],
      save_to_pc_buttons: [],
      pages_text: [],
      report_title: [],
      report_date: []
    }
  };
}

describe("page budget policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fakePage.isClosed.mockReturnValue(false);
    mocks.fakeBrowser.isConnected.mockReturnValue(true);
    mocks.store.dailyPages.mockResolvedValue(641);
    mocks.store.doneTaskIds.mockResolvedValue(new Set<string>());
    mocks.executeBulkDownload.mockImplementation(async (input) => {
      const reserved = await input.reserveSelectedPages?.(selectedRows, 16);
      expect(reserved).toEqual({ ok: true, error: "" });
      await input.commitSelectedPages?.(selectedRows, 16);
      return {
        ok: true,
        status: "downloaded",
        pages: 16,
        artifacts: [
          {
            path: "C:\\tmp\\T2580.pdf",
            suggestedFilename: "T2580.pdf",
            sha256: "abc",
            bytes: 1024,
            pages: 16
          }
        ],
        mappingRecords: [],
        error: "",
        rowSelection: selectedRows
      };
    });
  });

  it("does not stop before row selection when the visible-row estimate exceeds the remaining budget", async () => {
    const { runAutomation } = await import("../src/automation/engine.js");

    await runAutomation(makeConfig(), { dryRun: false, maxDownloads: 0, includeDone: true });

    expect(mocks.executeBulkDownload).toHaveBeenCalledTimes(1);
    expect(mocks.store.writeStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "download_started",
        pages: 16,
        note: expect.stringContaining("selected_pages_reserved:selected=16")
      })
    );
    expect(mocks.store.writeStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({
        status: "page_limit",
        note: expect.stringContaining("estimated_pages=70")
      })
    );
  });
});
