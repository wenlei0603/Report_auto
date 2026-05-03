import { describe, expect, it } from "vitest";
import { isBatchSavePrintAppUrl, isPdfLandingHandoff, shouldWaitBeforeReconnect } from "../src/browser/download.js";

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
});
