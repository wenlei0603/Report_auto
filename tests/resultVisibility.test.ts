import { describe, expect, it } from "vitest";
import { interpretResultVisibilitySignals } from "../src/browser/state.js";

describe("result visibility classification", () => {
  it("classifies explicit no-results text as no_results", () => {
    expect(
      interpretResultVisibilitySignals({
        hasNoResultsText: true,
        rowCount: 0,
        rowHints: 0,
        recordTotal: 0
      })
    ).toEqual({ status: "no_results", rowCount: 0, reason: "no_results_text" });
  });

  it("keeps records-without-visible-rows separate from no_rows", () => {
    expect(
      interpretResultVisibilitySignals({
        hasNoResultsText: false,
        rowCount: 0,
        rowHints: 0,
        recordTotal: 8
      })
    ).toEqual({ status: "results", rowCount: 8, reason: "record_count_visible" });
  });

  it("classifies only missing rows and missing record count as no_rows", () => {
    expect(
      interpretResultVisibilitySignals({
        hasNoResultsText: false,
        rowCount: 0,
        rowHints: 0,
        recordTotal: 0
      })
    ).toEqual({ status: "no_rows", rowCount: 0, reason: "no_result_rows" });
  });
});
