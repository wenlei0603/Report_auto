import { describe, expect, it } from "vitest";
import { evaluateResultRow, reviewResultRows } from "../src/browser/results.js";
import type { ResultReviewTask, ResultRowSnapshot } from "../src/browser/results.js";

function makeTask(overrides: Partial<ResultReviewTask> = {}): ResultReviewTask {
  return {
    company: "3M Co",
    ticker: "MMM",
    ccDate: "2017-07-25",
    dateFrom: "2017-07-25",
    dateTo: "2017-08-08",
    contributor: "Morgan Stanley",
    maxPages: 23,
    ...overrides
  };
}

function makeRow(overrides: Partial<ResultRowSnapshot> = {}): ResultRowSnapshot {
  return {
    rowIndex: 0,
    dateText: "26-Jul-2017",
    availableText: "01-Aug-2017, 12:20",
    companyName: "3M Co",
    companyExtraCount: 0,
    tickerText: "MMM.N",
    tickerExtraCount: 0,
    titleText: "3M Co.: Comments Ahead of the Call",
    pagesText: "10",
    contributorText: "Morgan Stanley",
    ...overrides
  };
}

describe("result row review", () => {
  it("auto-selects strict company rows and exposes a score breakdown", () => {
    const review = evaluateResultRow(makeRow(), makeTask());

    expect(review.eligible).toBe(true);
    expect(review.needsHumanReview).toBe(false);
    expect(review.autoSelect).toBe(true);
    expect(review.downloadCategory).toBe("ticker_matched");
    expect(review.scoreTotal).toBe(100);
    expect(review.scoreBreakdown).toEqual({
      tickerScore: 40,
      titleScore: 35,
      dateScore: 25,
      penalties: 0,
      industryPenaltyApplied: false
    });
  });

  it("rejects same-day rows even when they otherwise match", () => {
    const review = evaluateResultRow(
      makeRow({
        dateText: "25-Jul-2017"
      }),
      makeTask()
    );

    expect(review.eligible).toBe(false);
    expect(review.autoSelect).toBe(false);
    expect(review.downloadCategory).toBe("none");
    expect(review.reasons).toContain("date_is_cc_date");
  });

  it("heavily penalizes industry-style rows without hard-excluding them", () => {
    const review = evaluateResultRow(
      makeRow({
        rowIndex: 1,
        dateText: "31-Jul-2017",
        companyExtraCount: 24,
        tickerText: "N/A",
        tickerExtraCount: 24,
        titleText: "US Capital Goods: Where is Sentiment?",
        pagesText: "8"
      }),
      makeTask()
    );

    expect(review.eligible).toBe(true);
    expect(review.needsHumanReview).toBe(true);
    expect(review.autoSelect).toBe(true);
    expect(review.downloadCategory).toBe("ticker_mismatch");
    expect(review.scoreTotal).toBe(0);
    expect(review.reasons).toContain("industry_title_match");
    expect(review.reasons).not.toContain("score_non_positive");
  });

  it("allows ambiguous rows with strong company titles to remain selectable", () => {
    const review = evaluateResultRow(
      makeRow({
        rowIndex: 1,
        dateText: "23-Apr-2015",
        availableText: "30-Apr-2015, 11:02",
        companyName: "Abbott Laboratories",
        companyExtraCount: 4,
        tickerText: "ABT.N",
        tickerExtraCount: 4,
        titleText: "Abbott Laboratories: Patience Is a Virtue"
      }),
      makeTask({
        company: "Abbott Laboratories",
        ticker: "ABT",
        ccDate: "2015-04-22",
        dateFrom: "2015-04-22",
        dateTo: "2015-05-06"
      })
    );

    expect(review.eligible).toBe(true);
    expect(review.needsHumanReview).toBe(true);
    expect(review.autoSelect).toBe(true);
    expect(review.downloadCategory).toBe("ticker_mismatch");
    expect(review.scoreTotal).toBeGreaterThan(0);
    expect(review.reasons).toContain("multi_company_row");
    expect(review.reasons).toContain("ambiguous_ticker");
    expect(review.reasons).not.toContain("title_not_company_specific");
  });

  it("rejects rows outside the allowed contributor or page rules", () => {
    const review = evaluateResultRow(
      makeRow({
        rowIndex: 1,
        dateText: "09-Aug-2017",
        availableText: "09-Aug-2017, 09:30",
        pagesText: "28",
        contributorText: "Goldman Sachs",
        titleText: "3M Co. update"
      }),
      makeTask()
    );

    expect(review.eligible).toBe(false);
    expect(review.autoSelect).toBe(false);
    expect(review.downloadCategory).toBe("none");
    expect(review.reasons).toContain("date_out_of_range");
    expect(review.reasons).toContain("contributor_mismatch");
    expect(review.reasons).toContain("pages_exceed_limit");
  });

  it("rejects rows outside the cc-date plus seven day event window using row Date", () => {
    const review = evaluateResultRow(
      makeRow({
        rowIndex: 3,
        dateText: "10-Aug-2017",
        availableText: "01-Aug-2017, 09:30",
        titleText: "3M Co. update",
        pagesText: "8"
      }),
      makeTask({
        dateTo: "2017-08-15"
      })
    );

    expect(review.eligible).toBe(false);
    expect(review.autoSelect).toBe(false);
    expect(review.downloadCategory).toBe("none");
    expect(review.reasons).toContain("date_out_of_event_window");
  });

  it("ignores Available when Date is valid and scoreable", () => {
    const review = evaluateResultRow(
      makeRow({
        availableText: "09-Aug-2017, 12:20"
      }),
      makeTask()
    );

    expect(review.eligible).toBe(true);
    expect(review.autoSelect).toBe(true);
    expect(review.downloadCategory).toBe("ticker_matched");
    expect(review.reasons).not.toContain("available_out_of_range");
    expect(review.scoreBreakdown.dateScore).toBe(25);
  });

  it("rejects rows for unrelated company", () => {
    const review = evaluateResultRow(
      makeRow({
        rowIndex: 5,
        companyName: "Waters Corp",
        tickerText: "WAT.N",
        titleText: "Waters Corp: Comments Ahead"
      }),
      makeTask()
    );

    expect(review.eligible).toBe(false);
    expect(review.reasons).toContain("company_mismatch");
    expect(review.reasons).toContain("ticker_mismatch");
    expect(review.downloadCategory).toBe("none");
  });

  it("prefers higher-scoring strict company rows over industry-style rows", () => {
    const summary = reviewResultRows(
      [
        makeRow({
          rowIndex: 0,
          dateText: "31-Jul-2017",
          companyExtraCount: 24,
          tickerText: "N/A",
          tickerExtraCount: 24,
          titleText: "US Capital Goods: Where is Sentiment?",
          pagesText: "8"
        }),
        makeRow({
          rowIndex: 2
        })
      ],
      makeTask()
    );

    expect(summary.autoSelectRowIndexes).toEqual([0, 2]);
    expect(summary.tickerMatchedRowIndexes).toEqual([2]);
    expect(summary.tickerMismatchRowIndexes).toEqual([0]);
    expect(summary.humanReviewRowIndexes).toEqual([0]);
    expect(summary.reviews.find((row) => row.rowIndex === 0)?.review.reasons).not.toContain("score_non_positive");
  });

  it("limits auto-selection to the two highest-scoring rows", () => {
    const summary = reviewResultRows(
      [
        makeRow({ rowIndex: 0, dateText: "26-Jul-2017", titleText: "3M Co. first follow-up" }),
        makeRow({ rowIndex: 1, dateText: "27-Jul-2017", titleText: "3M Co. second follow-up" }),
        makeRow({ rowIndex: 2, dateText: "29-Jul-2017", titleText: "3M Co. later follow-up" })
      ],
      makeTask()
    );

    expect(summary.autoSelectRowIndexes).toEqual([0, 1]);
    expect(summary.tickerMatchedRowIndexes).toEqual([0, 1]);
    expect(summary.reviews.find((row) => row.rowIndex === 2)?.review.reasons).toContain("selection_rank_exceeded");
  });

  it("lets a ticker-mismatch but company-specific title beat penalized industry rows", () => {
    const summary = reviewResultRows(
      [
        makeRow({
          rowIndex: 0,
          tickerText: "N/A",
          tickerExtraCount: 0,
          titleText: "3M Co. (MMM): Margin Setup Improves",
          dateText: "26-Jul-2017"
        }),
        makeRow({
          rowIndex: 1,
          tickerText: "N/A",
          tickerExtraCount: 24,
          companyExtraCount: 24,
          titleText: "Multi-Industry Weekly Takeaways",
          dateText: "26-Jul-2017"
        }),
        makeRow({
          rowIndex: 2,
          tickerText: "N/A",
          tickerExtraCount: 24,
          companyExtraCount: 24,
          titleText: "Investment Perspectives U.S. and the Americas",
          dateText: "27-Jul-2017"
        })
      ],
      makeTask()
    );

    expect(summary.autoSelectRowIndexes).toEqual([0, 1]);
    expect(summary.tickerMismatchRowIndexes).toEqual([0, 1]);
    expect(summary.reviews.find((row) => row.rowIndex === 0)?.review.scoreTotal).toBeGreaterThan(0);
    expect(summary.reviews.find((row) => row.rowIndex === 1)?.review.scoreTotal).toBe(0);
    expect(summary.reviews.find((row) => row.rowIndex === 2)?.review.scoreTotal).toBe(0);
    expect(summary.reviews.find((row) => row.rowIndex === 2)?.review.reasons).toContain("selection_rank_exceeded");
  });

  it("demotes observed bad-selection patterns behind a company-specific report", () => {
    const summary = reviewResultRows(
      [
        makeRow({
          rowIndex: 0,
          companyName: "Amazon.com Inc",
          tickerText: "AMZN.OQ",
          titleText: "Amazon.com Inc: Alexa, What Do You Call 1Q16?",
          dateText: "29-Apr-2016"
        }),
        makeRow({
          rowIndex: 1,
          companyName: "Amazon.com Inc",
          tickerText: "N/A",
          tickerExtraCount: 24,
          companyExtraCount: 24,
          titleText: "Investment Perspectives U.S. and the Americas, May 5, 2016",
          dateText: "05-May-2016"
        }),
        makeRow({
          rowIndex: 2,
          companyName: "Amazon.com Inc",
          tickerText: "N/A",
          tickerExtraCount: 24,
          companyExtraCount: 24,
          titleText: "Video Bricks v Clicks For Every Yin, There's a Yang",
          dateText: "04-May-2016"
        }),
        makeRow({
          rowIndex: 3,
          companyName: "Amazon.com Inc",
          tickerText: "N/A",
          tickerExtraCount: 24,
          companyExtraCount: 24,
          titleText: "Multi-Industry CAPMI Shows Coordinated Global Deterioration",
          dateText: "29-Apr-2016"
        })
      ],
      makeTask({
        company: "Amazon.com Inc",
        ticker: "AMZN",
        ccDate: "2016-04-28",
        dateFrom: "2016-04-28",
        dateTo: "2016-05-12"
      })
    );

    expect(summary.autoSelectRowIndexes).toEqual([0, 3]);
    expect(summary.tickerMatchedRowIndexes).toEqual([0]);
    expect(summary.reviews.filter((row) => row.rowIndex !== 0).every((row) => row.review.scoreTotal <= 0)).toBe(true);
    expect(summary.tickerMismatchRowIndexes).toEqual([3]);
    expect(summary.reviews.find((row) => row.rowIndex === 1)?.review.reasons).toContain("selection_rank_exceeded");
    expect(summary.reviews.find((row) => row.rowIndex === 2)?.review.reasons).toContain("selection_rank_exceeded");
  });
});
