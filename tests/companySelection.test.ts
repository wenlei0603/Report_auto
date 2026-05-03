import { describe, expect, it } from "vitest";
import { chooseCompanyCandidate, isSuggestionSnapshotReady } from "../src/browser/filters.js";

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
