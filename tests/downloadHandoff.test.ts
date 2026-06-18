import { describe, expect, it } from "vitest";
import {
  expectedNativePdfCount,
  isActiveDownloadTempFileName,
  isBatchSavePrintAppUrl,
  isPdfLandingHandoff,
  nativePdfWaitTimeoutMs,
  selectNativePdfCandidatesForRows,
  selectedRowPages,
  shouldWaitBeforeReconnect
} from "../src/browser/download.js";

describe("download handoff timing", () => {
  it("waits before reconnecting after BatchSavePrint CDP detach handoff", () => {
    expect(shouldWaitBeforeReconnect("cdp_detached_after_batchsaveprint_manual_download_expected")).toBe(true);
  });

  it("does not wait for ordinary download failures", () => {
    expect(shouldWaitBeforeReconnect("download_event_missing_or_page_closed")).toBe(false);
  });

  it("treats pdf landing timeout as a human review handoff condition", () => {
    expect(isPdfLandingHandoff("human_review_required:pdf_landing_timeout_after_batchsaveprint")).toBe(true);
  });

  it("detects the BatchSavePrint app URL explicitly", () => {
    expect(isBatchSavePrintAppUrl("https://workspace.refinitiv.com/web/Apps/BatchSavePrint/?ws=true")).toBe(true);
    expect(isBatchSavePrintAppUrl("https://workspace.refinitiv.com/Apps/BatchSavePrint/1.3.4/")).toBe(true);
    expect(isBatchSavePrintAppUrl("https://workspace.refinitiv.com/Apps/BatchSavePrintService/")).toBe(false);
  });

  it("waits longer for native downloads when multiple selected PDFs are expected", () => {
    expect(nativePdfWaitTimeoutMs(1)).toBe(150_000);
    expect(nativePdfWaitTimeoutMs(6)).toBe(540_000);
  });

  it("uses selected row count as the expected native PDF count", () => {
    expect(expectedNativePdfCount(undefined)).toBe(1);
    expect(expectedNativePdfCount({ selected: 6, requested: 6 } as never)).toBe(6);
  });

  it("detects active browser download temp files", () => {
    expect(isActiveDownloadTempFileName("report.pdf.crdownload")).toBe(true);
    expect(isActiveDownloadTempFileName("report.pdf")).toBe(false);
  });

  it("sums selected result row pages before entering the download flow", () => {
    expect(
      selectedRowPages({
        selected: 3,
        selectedRows: [{ pages: "14" }, { pages: "8 pgs" }, { pages: "N/A" }]
      } as never)
    ).toBe(22);
  });

  it("keeps only fresh native PDFs that match the selected result row", () => {
    const selected = selectNativePdfCandidatesForRows(
      [
        {
          path: "C:/Users/wl187/Downloads/2016-05-06-SSNC.OQ-Morgan Stanley-SSC Technologies Holdings, Inc. Looking Forward To Second ...-74415118.pdf",
          mtimeMs: 200
        },
        {
          path: "C:/Users/wl187/Downloads/2016-08-09-NUAN.OQ^C22-Morgan Stanley-Nuance Communications Inc. 3Q16 Results Revenue Growth Timeline Pushed Out...-75449742.pdf",
          mtimeMs: 100
        }
      ],
      {
        selected: 1,
        requested: 1,
        selectedRows: [
          {
            rowIndex: 0,
            date: "09-Aug-2016",
            company: "Nuance Communications Inc",
            ticker: "NUAN.OQ^C22",
            title: "RequestNuance Communications Inc.: 3Q16 Results: Revenue Growth Timeline Pushed Out by Shift to Subscription",
            pages: "14",
            contributor: "Morgan Stanley"
          }
        ]
      } as never,
      1
    );

    expect(selected.map((file) => file.path)).toEqual([
      "C:/Users/wl187/Downloads/2016-08-09-NUAN.OQ^C22-Morgan Stanley-Nuance Communications Inc. 3Q16 Results Revenue Growth Timeline Pushed Out...-75449742.pdf"
    ]);
  });

  it("matches native PDFs whose platform filenames truncate the selected row title", () => {
    const selected = selectNativePdfCandidatesForRows(
      [
        {
          path: "C:/Users/wl187/Downloads/2016-05-06-SSNC.OQ-Morgan Stanley-SSC Technologies Holdings, Inc. Looking Forward To Second ...-74415118.pdf",
          mtimeMs: 100
        }
      ],
      {
        selected: 1,
        requested: 1,
        selectedRows: [
          {
            rowIndex: 0,
            date: "06-May-2016",
            company: "SS&C Technologies Holdings Inc",
            ticker: "SSNC.OQ",
            title: "RequestSS&C Technologies Holdings, Inc.: Looking Forward To Second Half Growth",
            pages: "10",
            contributor: "Morgan Stanley"
          }
        ]
      } as never,
      1
    );

    expect(selected).toHaveLength(1);
  });
});
