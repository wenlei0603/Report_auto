import { describe, expect, it } from "vitest";
import { evaluateResultRow, reviewResultRows } from "../src/browser/results.js";

describe("result row review", () => {
  it("auto-selects rows that fully match company, time, contributor, and page rules", () => {
    const review = evaluateResultRow(
      {
        rowIndex: 2,
        dateText: "25-Jul-2017",
        availableText: "01-Aug-2017, 12:20",
        companyName: "3M Co",
        companyExtraCount: 0,
        tickerText: "MMM.N",
        tickerExtraCount: 0,
        titleText: "3M Co.: Comments Ahead of the Call",
        pagesText: "10",
        contributorText: "Morgan Stanley"
      },
      {
        company: "3M Co",
        ticker: "MMM",
        ccDate: "2017-07-25",
        dateFrom: "2017-07-25",
        dateTo: "2017-08-08",
        contributor: "Morgan Stanley",
        maxPages: 23
      }
    );

    expect(review.eligible).toBe(true);
    expect(review.needsHumanReview).toBe(false);
    expect(review.autoSelect).toBe(true);
    expect(review.downloadCategory).toBe("ticker_matched");
  });

  it("classifies broad basket rows as ticker-mismatch downloads when company and dates pass", () => {
    const review = evaluateResultRow(
      {
        rowIndex: 0,
        dateText: "31-Jul-2017",
        availableText: "01-Aug-2017, 12:21",
        companyName: "3M Co",
        companyExtraCount: 24,
        tickerText: "N/A",
        tickerExtraCount: 24,
        titleText: "US Capital Goods: Where is Sentiment?",
        pagesText: "8",
        contributorText: "Morgan Stanley"
      },
      {
        company: "3M Co",
        ticker: "MMM",
        ccDate: "2017-07-25",
        dateFrom: "2017-07-25",
        dateTo: "2017-08-08",
        contributor: "Morgan Stanley",
        maxPages: 23
      }
    );

    expect(review.eligible).toBe(true);
    expect(review.needsHumanReview).toBe(true);
    expect(review.autoSelect).toBe(true);
    expect(review.downloadCategory).toBe("ticker_mismatch");
    expect(review.reasons).toContain("multi_company_row");
    expect(review.reasons).toContain("ambiguous_ticker");
    expect(review.reasons).toContain("title_not_company_specific");
  });

  it("auto-selects multi-link rows when the visible ticker and title still identify the target company", () => {
    const review = evaluateResultRow(
      {
        rowIndex: 1,
        dateText: "23-Apr-2015",
        availableText: "30-Apr-2015, 11:02",
        companyName: "Abbott Laboratories",
        companyExtraCount: 4,
        tickerText: "ABT.N",
        tickerExtraCount: 4,
        titleText: "Abbott Laboratories: Patience Is a Virtue",
        pagesText: "12",
        contributorText: "Morgan Stanley"
      },
      {
        company: "Abbott Laboratories",
        ticker: "ABT",
        ccDate: "2015-04-22",
        dateFrom: "2015-04-22",
        dateTo: "2015-05-06",
        contributor: "Morgan Stanley",
        maxPages: 23
      }
    );

    expect(review.eligible).toBe(true);
    expect(review.needsHumanReview).toBe(true);
    expect(review.autoSelect).toBe(true);
    expect(review.downloadCategory).toBe("ticker_mismatch");
    expect(review.reasons).toContain("multi_company_row");
    expect(review.reasons).toContain("ambiguous_ticker");
    expect(review.reasons).not.toContain("title_not_company_specific");
  });

  it("rejects rows outside the allowed contributor or page rules", () => {
    const review = evaluateResultRow(
      {
        rowIndex: 1,
        dateText: "09-Aug-2017",
        availableText: "09-Aug-2017, 09:30",
        companyName: "3M Co",
        companyExtraCount: 0,
        tickerText: "MMM.N",
        tickerExtraCount: 0,
        titleText: "3M Co. update",
        pagesText: "28",
        contributorText: "Goldman Sachs"
      },
      {
        company: "3M Co",
        ticker: "MMM",
        ccDate: "2017-07-25",
        dateFrom: "2017-07-25",
        dateTo: "2017-08-08",
        contributor: "Morgan Stanley",
        maxPages: 23
      }
    );

    expect(review.eligible).toBe(false);
    expect(review.autoSelect).toBe(false);
    expect(review.downloadCategory).toBe("none");
    expect(review.reasons).toContain("date_out_of_range");
    expect(review.reasons).toContain("contributor_mismatch");
    expect(review.reasons).toContain("pages_exceed_limit");
  });

  it("rejects rows outside the cc-date plus seven day event window using the report Date field", () => {
    const review = evaluateResultRow(
      {
        rowIndex: 3,
        dateText: "10-Aug-2017",
        availableText: "01-Aug-2017, 09:30",
        companyName: "3M Co",
        companyExtraCount: 0,
        tickerText: "MMM.N",
        tickerExtraCount: 0,
        titleText: "3M Co. update",
        pagesText: "8",
        contributorText: "Morgan Stanley"
      },
      {
        company: "3M Co",
        ticker: "MMM",
        ccDate: "2017-07-25",
        dateFrom: "2017-07-25",
        dateTo: "2017-08-15",
        contributor: "Morgan Stanley",
        maxPages: 23
      }
    );

    expect(review.eligible).toBe(false);
    expect(review.autoSelect).toBe(false);
    expect(review.downloadCategory).toBe("none");
    expect(review.reasons).toContain("date_out_of_event_window");
    expect(review.reasons).not.toContain("available_out_of_event_window");
  });

  it("rejects rows whose available date is outside the searched task window", () => {
    const review = evaluateResultRow(
      {
        rowIndex: 2,
        dateText: "25-Jul-2017",
        availableText: "09-Aug-2017, 12:20",
        companyName: "3M Co",
        companyExtraCount: 0,
        tickerText: "MMM.N",
        tickerExtraCount: 0,
        titleText: "3M Co.: Comments Ahead of the Call",
        pagesText: "10",
        contributorText: "Morgan Stanley"
      },
      {
        company: "3M Co",
        ticker: "MMM",
        ccDate: "2017-07-25",
        dateFrom: "2017-07-25",
        dateTo: "2017-08-08",
        contributor: "Morgan Stanley",
        maxPages: 23
      }
    );

    expect(review.eligible).toBe(false);
    expect(review.autoSelect).toBe(false);
    expect(review.downloadCategory).toBe("none");
    expect(review.reasons).toContain("available_out_of_range");
  });

  it("rejects rows for unrelated company", () => {
    const review = evaluateResultRow(
      {
        rowIndex: 5,
        dateText: "25-Jul-2017",
        availableText: "01-Aug-2017, 12:20",
        companyName: "Waters Corp",
        companyExtraCount: 0,
        tickerText: "WAT.N",
        tickerExtraCount: 0,
        titleText: "Waters Corp: Comments Ahead",
        pagesText: "10",
        contributorText: "Morgan Stanley"
      },
      {
        company: "3M Co",
        ticker: "MMM",
        ccDate: "2017-07-25",
        dateFrom: "2017-07-25",
        dateTo: "2017-08-08",
        contributor: "Morgan Stanley",
        maxPages: 23
      }
    );

    expect(review.eligible).toBe(false);
    expect(review.reasons).toContain("company_mismatch");
    expect(review.reasons).toContain("ticker_mismatch");
    expect(review.downloadCategory).toBe("none");
  });

  it("summarizes auto-selectable row indexes and human-review rows separately", () => {
    const summary = reviewResultRows(
      [
        {
          rowIndex: 0,
          dateText: "31-Jul-2017",
          availableText: "07-Aug-2017, 12:21",
          companyName: "3M Co",
          companyExtraCount: 24,
          tickerText: "N/A",
          tickerExtraCount: 24,
          titleText: "US Capital Goods: Where is Sentiment?",
          pagesText: "8",
          contributorText: "Morgan Stanley"
        },
        {
          rowIndex: 2,
          dateText: "25-Jul-2017",
          availableText: "01-Aug-2017, 12:20",
          companyName: "3M Co",
          companyExtraCount: 0,
          tickerText: "MMM.N",
          tickerExtraCount: 0,
          titleText: "3M Co.: Comments Ahead of the Call",
          pagesText: "10",
          contributorText: "Morgan Stanley"
        }
      ],
      {
        company: "3M Co",
        ticker: "MMM",
        ccDate: "2017-07-25",
        dateFrom: "2017-07-25",
        dateTo: "2017-08-08",
        contributor: "Morgan Stanley",
        maxPages: 23
      }
    );

    expect(summary.autoSelectRowIndexes).toEqual([0, 2]);
    expect(summary.tickerMatchedRowIndexes).toEqual([2]);
    expect(summary.tickerMismatchRowIndexes).toEqual([0]);
    expect(summary.humanReviewRowIndexes).toEqual([0]);
    expect(summary.rejectedRowIndexes).toEqual([]);
  });

  it("prioritizes ticker-mismatch category for T0065-style rows while retaining strict rows separately", () => {
    const summary = reviewResultRows(
      [
        {
          rowIndex: 0,
          dateText: "24-Apr-2015",
          availableText: "01-May-2015, 12:22",
          companyName: "Abbott Laboratories",
          companyExtraCount: 5,
          tickerText: "BCR.N^L17",
          tickerExtraCount: 5,
          titleText: "C.R. Bard: Lutonix & the Balance Sheet to Drive 2015",
          pagesText: "14",
          contributorText: "Morgan Stanley"
        },
        {
          rowIndex: 5,
          dateText: "22-Apr-2015",
          availableText: "29-Apr-2015, 12:22",
          companyName: "Abbott Laboratories",
          companyExtraCount: 0,
          tickerText: "ABT.N",
          tickerExtraCount: 0,
          titleText: "Abbott Laboratories: Strong Quarter as Growth and Margins Deliver",
          pagesText: "8",
          contributorText: "Morgan Stanley"
        }
      ],
      {
        company: "Abbott Laboratories",
        ticker: "ABT",
        ccDate: "2015-04-22",
        dateFrom: "2015-04-22",
        dateTo: "2015-05-06",
        contributor: "Morgan Stanley",
        maxPages: 23
      }
    );

    expect(summary.tickerMismatchRowIndexes).toEqual([0]);
    expect(summary.tickerMatchedRowIndexes).toEqual([5]);
  });
});
