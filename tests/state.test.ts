import { describe, expect, it } from "vitest";
import { classifySessionFailureText, classifyUrl } from "../src/browser/state.js";
import { isQueryModeReady } from "../src/browser/filters.js";
import { workspacePageRank } from "../src/browser/session.js";

describe("URL state classifier", () => {
  it("detects BatchSavePrint drift", () => {
    expect(classifyUrl("https://workspace.refinitiv.com/web/Apps/BatchSavePrint/?ws=true")).toBe("batch_save_print");
  });

  it("detects auth pages", () => {
    expect(classifyUrl("https://example.com/oauth/login")).toBe("auth");
  });

  it("returns null when URL alone is not enough", () => {
    expect(classifyUrl("https://workspace.refinitiv.com/Apps/research-next/2.22.3/#/")).toBeNull();
  });
});

describe("session failure text classifier", () => {
  it("detects the green session-expired toast text", () => {
    expect(classifySessionFailureText("Your session is expired. Please sign in again.")).toBe(true);
  });

  it("detects common expired-session variants", () => {
    expect(classifySessionFailureText("Your session has expired")).toBe(true);
    expect(classifySessionFailureText("session expired")).toBe(true);
  });

  it("does not treat normal loading text as session failure", () => {
    expect(classifySessionFailureText("Loading Research Next, please wait")).toBe(false);
  });
});

describe("workspace page selection", () => {
  it("prefers the real Research Next tab over BatchSavePrint feedback pages", () => {
    expect(workspacePageRank("https://workspace.refinitiv.com/web/Apps/BatchSavePrint/?ws=true")).toBe(0);
    expect(workspacePageRank("https://workspace.refinitiv.com/web/Apps/research-next/?st=OAPermID")).toBeGreaterThan(0);
    expect(
      workspacePageRank("https://workspace.refinitiv.com/web/Apps/research-next/?st=OAPermID", [
        "https://workspace.refinitiv.com/Apps/research-next/2.22.3/#/?st=OAPermID"
      ])
    ).toBeGreaterThan(workspacePageRank("https://workspace.refinitiv.com/web/Apps/research-next/?st=OAPermID"));
  });
});

describe("query mode readiness", () => {
  it("accepts visible company selector even when no native input is exposed yet", () => {
    expect(
      isQueryModeReady({
        hasVisibleCompanyInput: false,
        hasVisibleCompanySelector: true,
        hasExpandedFilterPanel: true
      })
    ).toBe(true);
  });

  it("rejects states with no visible company controls", () => {
    expect(
      isQueryModeReady({
        hasVisibleCompanyInput: false,
        hasVisibleCompanySelector: false,
        hasExpandedFilterPanel: false
      })
    ).toBe(false);
  });

  it("rejects collapsed summary state even when company selector shell remains visible", () => {
    expect(
      isQueryModeReady({
        hasVisibleCompanyInput: false,
        hasVisibleCompanySelector: true,
        hasExpandedFilterPanel: false
      })
    ).toBe(false);
  });

  it("rejects collapsed state even when a shadow-dom company input is technically visible", () => {
    expect(
      isQueryModeReady({
        hasVisibleCompanyInput: true,
        hasVisibleCompanySelector: true,
        hasExpandedFilterPanel: false
      })
    ).toBe(false);
  });
});
