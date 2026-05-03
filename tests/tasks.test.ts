import { describe, expect, it } from "vitest";
import { parseTasks } from "../src/domain/tasks.js";

describe("task parser", () => {
  it("parses TSV task rows with task id based on original row number", () => {
    const rows = [
      "# comment",
      "22592\t3M Co\tMMM\t22-Oct-2015 00:00\t22-Oct-2015 00:00\t05-Nov-2015 00:00"
    ];
    const tasks = parseTasks(rows);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      taskId: "T0002",
      permno: "22592",
      company: "3M Co",
      ticker: "MMM",
      ccDate: "2015-10-22",
      dateFrom: "2015-10-22",
      dateTo: "2015-11-05"
    });
  });

  it("parses fallback free-text rows with two dates", () => {
    const tasks = parseTasks(["Example Co 2015-01-01 2015-01-08"]);
    expect(tasks[0]).toMatchObject({
      taskId: "T0001",
      company: "Example Co",
      dateFrom: "2015-01-01",
      dateTo: "2015-01-08"
    });
  });
});
