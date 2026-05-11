import { describe, expect, it } from "vitest";
import {
  dateSummaryMatchesRange,
  chooseCompanyCandidate,
  chooseContributorCandidate,
  evaluateSearchFilterInitialization,
  isContributorSuggestionSnapshotReady,
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

describe("search filter initialization validation", () => {
  it("accepts the required initial Research Next filters", () => {
    expect(
      evaluateSearchFilterInitialization({
        contributorLabels: ["Morgan Stanley"],
        preferredContributorChecked: false,
        dateRangeMode: "Custom",
        industryLabels: [],
        countryLabels: ["United States of America"]
      })
    ).toEqual({ ok: true, reasons: [] });
  });

  it("rejects preferred contributor and non-custom date mode", () => {
    expect(
      evaluateSearchFilterInitialization({
        contributorLabels: ["Morgan Stanley"],
        preferredContributorChecked: true,
        dateRangeMode: "Last 90 Days",
        industryLabels: [],
        countryLabels: ["United States of America"]
      })
    ).toEqual({
      ok: false,
      reasons: ["preferred_contributor_checked", "date_range_not_custom"]
    });
  });

  it("rejects full date menu text because it does not prove Custom is selected", () => {
    expect(
      evaluateSearchFilterInitialization({
        contributorLabels: ["Morgan Stanley"],
        preferredContributorChecked: false,
        dateRangeMode: "Date Range Today Last 90 Days Custom... OK Cancel",
        industryLabels: [],
        countryLabels: ["United States of America"]
      })
    ).toEqual({
      ok: false,
      reasons: ["date_range_not_custom"]
    });
  });

  it("rejects extra contributors and non-US region", () => {
    expect(
      evaluateSearchFilterInitialization({
        contributorLabels: ["Morgan Stanley", "Morningstar, Inc."],
        preferredContributorChecked: false,
        dateRangeMode: "Custom",
        industryLabels: ["Healthcare"],
        countryLabels: ["Canada"]
      })
    ).toEqual({
      ok: false,
      reasons: ["contributor_not_exact_morgan_stanley", "industry_not_any", "country_not_united_states"]
    });
  });
});

describe("date range summary validation", () => {
  it("accepts the exact custom date range summary emitted by Research Next", () => {
    expect(dateSummaryMatchesRange("25-Apr-2018 00:00 To 09-May-2018 00:00", "25-Apr-2018 00:00", "09-May-2018 00:00")).toBe(
      true
    );
  });

  it("rejects stale default ranges when task dates were not applied", () => {
    expect(dateSummaryMatchesRange("09-Feb-2026 00:00 To 10-May-2026 23:19", "25-Apr-2018 00:00", "09-May-2018 00:00")).toBe(
      false
    );
  });
});
