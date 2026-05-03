import { describe, expect, it } from "vitest";
import { classifyUrl } from "../src/browser/state.js";
import { isQueryModeReady } from "../src/browser/filters.js";

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
