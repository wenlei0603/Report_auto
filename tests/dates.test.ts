import { describe, expect, it } from "vitest";
import { formatPickerDate, orderIsoDates, parseDateToIso } from "../src/domain/dates.js";

describe("date parsing", () => {
  it("parses LSEG task date strings", () => {
    expect(parseDateToIso("22-Oct-2015 00:00")).toBe("2015-10-22");
    expect(parseDateToIso("2015-10-22")).toBe("2015-10-22");
    expect(parseDateToIso("10/22/2015")).toBe("2015-10-22");
  });

  it("orders ISO dates", () => {
    expect(orderIsoDates("2018-01-05", "2017-12-31")).toEqual(["2017-12-31", "2018-01-05"]);
  });

  it("formats the Research Next picker value", () => {
    expect(formatPickerDate("2015-10-22")).toBe("22-Oct-2015 00:00");
  });
});
