import { describe, expect, it } from "vitest";
import { evaluateCompanyRows } from "../src/browser/results.js";

describe("result company review", () => {
  it("passes when most rows match target company/ticker", () => {
    const review = evaluateCompanyRows(
      [
        "29-Apr-2015 06-May-2015 12:22 3M Co MMM.N 3M Co: Comments Ahead",
        "29-Apr-2015 06-May-2015 12:22 3M Co MMM 3M Co: Update",
        "29-Apr-2015 06-May-2015 12:22 3M Co MMM.N 3M Co: Preview"
      ],
      "3M Co",
      "MMM"
    );
    expect(review.ok).toBe(true);
    expect(review.needsHumanReview).toBe(false);
  });

  it("requires human review when no rows match target", () => {
    const review = evaluateCompanyRows(
      [
        "29-Apr-2015 06-May-2015 12:22 Waters Corp WAT.N Waters Corp: Note",
        "29-Apr-2015 06-May-2015 12:22 GoPro Inc GPRO.OQ GoPro: Note"
      ],
      "3M Co",
      "MMM"
    );
    expect(review.ok).toBe(false);
    expect(review.needsHumanReview).toBe(true);
    expect(review.reason).toBe("no_target_company_in_results");
  });
});
