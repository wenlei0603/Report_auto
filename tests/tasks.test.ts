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

  it("preserves task ids from explicit portable TSV queues", () => {
    const tasks = parseTasks([
      "task_id\trow_number\tpermno\tcompany\tticker\tcc_date\tdate_from\tdate_to",
      "T3540\t3540\t12345\tSynchrony Financial\tSYF\t2016-01-01\t2016-01-01\t2016-01-15",
      "T3544\t3544\t67890\tSyndax Pharmaceuticals Inc\tSNDX\t2016-02-01\t2016-02-01\t2016-02-15"
    ]);

    expect(tasks.map((task) => task.taskId)).toEqual(["T3540", "T3544"]);
    expect(tasks[0]).toMatchObject({
      rowNumber: 3540,
      company: "Synchrony Financial",
      ticker: "SYF",
      dateFrom: "2016-01-01",
      dateTo: "2016-01-15"
    });
  });
});
