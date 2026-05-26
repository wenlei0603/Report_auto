import { describe, expect, it } from "vitest";
import { classifyUrl, estimatePagesFromPageTexts } from "../src/browser/state.js";
import { isQueryModeReady } from "../src/browser/filters.js";
import { researchScopeBlocker } from "../src/browser/scope.js";
import { workspacePageRank } from "../src/browser/session.js";
import { needsViewportExpansion, targetViewportSize } from "../src/browser/viewport.js";

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

describe("page estimation", () => {
  it("sums only parsed page-column values instead of scanning whole-page text", () => {
    expect(estimatePagesFromPageTexts(["3", "2"])).toBe(5);
  });

  it("falls back to 1 when row page values are unavailable", () => {
    expect(estimatePagesFromPageTexts(["", "N/A"])).toBe(1);
  });

  it("parses page values that still include the pages label", () => {
    expect(estimatePagesFromPageTexts(["10 pages", "17 pages"])).toBe(27);
  });
});

describe("research scope readiness blockers", () => {
  it("recognizes expired or displaced login sessions before waiting for Research Next", () => {
    expect(researchScopeBlocker("https://example.com/oauth/login", "")).toMatchObject({ kind: "auth" });
    expect(researchScopeBlocker("https://workspace.refinitiv.com", "Session is expired. Sign in again")).toMatchObject({
      kind: "auth"
    });
    expect(researchScopeBlocker("https://workspace.refinitiv.com", "You are signed in to another device")).toMatchObject({
      kind: "auth"
    });
  });
});

describe("viewport guard", () => {
  it("expands small windows to a stable desktop layout target", () => {
    expect(needsViewportExpansion({ width: 900, height: 700 })).toBe(true);
    expect(targetViewportSize({ width: 900, height: 700 })).toEqual({ width: 1600, height: 1000 });
  });

  it("leaves already-large windows unchanged", () => {
    expect(needsViewportExpansion({ width: 1800, height: 1100 })).toBe(false);
    expect(targetViewportSize({ width: 1800, height: 1100 })).toEqual({ width: 1800, height: 1100 });
  });
});
