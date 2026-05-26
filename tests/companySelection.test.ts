import { describe, expect, it } from "vitest";
import {
  chooseCompanyCandidate,
  chooseContributorCandidate,
  chooseCountryCandidate,
  isContributorSuggestionSnapshotReady,
  isContributorSelectionApplied,
  isSuggestionSnapshotReady
} from "../src/browser/filters.js";

describe("company candidate selection", () => {
  it("prefers exact ticker matches over suffix matches", () => {
    const selected = chooseCompanyCandidate(
      [
        { label: "3M Co", value: "MMM.N" },
        { label: "3M Co", value: "MMM" },
        { label: "Minco Capital Corp", value: "MMM.V" }
      ],
      "3M Co",
      "MMM"
    );

    expect(selected).toMatchObject({
      label: "3M Co",
      value: "MMM",
      matchType: "exact_ticker"
    });
  });

  it("falls back to ticker suffix matches when exact ticker is absent", () => {
    const selected = chooseCompanyCandidate(
      [
        { label: "VNET Group Inc", value: "VNET.O" },
        { label: "Vianet Group PLC", value: "VNET.L" }
      ],
      "21Vianet Group Inc",
      "VNET"
    );

    expect(selected).toMatchObject({
      label: "VNET Group Inc",
      value: "VNET.O",
      matchType: "ticker_suffix"
    });
  });

  it("rejects ticker suffix candidates when label does not support ticker", () => {
    const selected = chooseCompanyCandidate(
      [{ label: "Transports Deplacements Services SA", value: "TDSS.UNL" }],
      "3D Systems Corp",
      "TDSS"
    );

    expect(selected).toBeNull();
  });
});

describe("company suggestion readiness", () => {
  it("waits for stable and query-reflected suggestions", () => {
    expect(
      isSuggestionSnapshotReady(
        {
          filtered: [{ label: "3M Co", value: "MMM" }],
          signature: "3M Co::MMM",
          componentQuery: "MMM",
          inputValue: "MMM"
        },
        "mmm",
        "Transports Deplacements Services SA::TDSS.UNL",
        2
      )
    ).toBe(true);
  });

  it("rejects snapshots before they become stable", () => {
    expect(
      isSuggestionSnapshotReady(
        {
          filtered: [{ label: "3M Co", value: "MMM" }],
          signature: "3M Co::MMM",
          componentQuery: "MMM",
          inputValue: "MMM"
        },
        "mmm",
        "",
        1
      )
    ).toBe(false);
  });
});

describe("contributor candidate selection", () => {
  it("prefers the exact contributor label over related research groups", () => {
    const selected = chooseContributorCandidate(
      [
        { label: "Morgan Stanley Fixed Income Research", value: "112604678849" },
        { label: "Morgan Stanley", value: "112604678803" }
      ],
      "Morgan Stanley"
    );

    expect(selected).toEqual({ label: "Morgan Stanley", value: "112604678803", matchType: "exact_label" });
  });

  it("rejects stale suggestions from a previous contributor query", () => {
    const selected = chooseContributorCandidate(
      [
        { label: "Morningstar, Inc.", value: "100" },
        { label: "Morningstar, Inc.", value: "101" }
      ],
      "Morgan Stanley"
    );

    expect(selected).toBeNull();
  });
});

describe("contributor selection state", () => {
  it("accepts an already materialized contributor selection", () => {
    expect(
      isContributorSelectionApplied(
        {
          selectedLabels: ["Morgan Stanley"],
          values: ["112604678803"]
        },
        "Morgan Stanley"
      )
    ).toBe(true);
  });
});

describe("contributor suggestion readiness", () => {
  it("accepts stable exact-match suggestions even when the query was already reflected before polling", () => {
    expect(
      isContributorSuggestionSnapshotReady(
        {
          filtered: [{ label: "Morgan Stanley", value: "112604678803" }],
          signature: "Morgan Stanley::112604678803",
          componentQuery: "Morgan Stanley",
          inputValue: "Morgan Stanley"
        },
        "Morgan Stanley",
        "Morgan Stanley::112604678803",
        2
      )
    ).toBe(true);
  });

  it("rejects stable stale suggestions that do not include the requested contributor", () => {
    expect(
      isContributorSuggestionSnapshotReady(
        {
          filtered: [{ label: "Morningstar, Inc.", value: "100" }],
          signature: "Morningstar, Inc.::100",
          componentQuery: "Morgan Stanley",
          inputValue: "Morgan Stanley"
        },
        "Morgan Stanley",
        "Morningstar, Inc.::100",
        2
      )
    ).toBe(false);
  });
});

describe("country candidate selection", () => {
  it("accepts United States of America for USA config", () => {
    const selected = chooseCountryCandidate(
      [
        { label: "Canada", value: "CAN" },
        { label: "United States of America", value: "USA" }
      ],
      "USA"
    );

    expect(selected).toEqual({ label: "United States of America", value: "USA", matchType: "usa_alias" });
  });

  it("rejects unrelated stale country suggestions", () => {
    expect(chooseCountryCandidate([{ label: "United Kingdom", value: "GBR" }], "USA")).toBeNull();
  });
});
