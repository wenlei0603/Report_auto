import { describe, expect, it } from "vitest";
import { selectPendingTasks, shouldStopRunAfterStatus } from "../src/automation/engine.js";
import type { RequestTask } from "../src/domain/types.js";

describe("automation task queue selection", () => {
  it("skips tasks with terminal status by default", () => {
    const selected = selectPendingTasks(taskFixtures, new Set(["T0001", "T0002"]), { dryRun: true, startFromTask: "T0001" });

    expect(selected.map((task) => task.taskId)).toEqual(["T0003"]);
  });

  it("can rerun from a completed task when includeDone is enabled", () => {
    const selected = selectPendingTasks(taskFixtures, new Set(["T0001", "T0002"]), {
      dryRun: true,
      startFromTask: "T0001",
      includeDone: true
    });

    expect(selected.map((task) => task.taskId)).toEqual(["T0001", "T0002", "T0003"]);
  });
});

describe("automation run stop conditions", () => {
  it("stops the run when the page guard reaches the daily limit", () => {
    expect(shouldStopRunAfterStatus("page_limit")).toBe(true);
    expect(shouldStopRunAfterStatus("no_rows")).toBe(false);
  });
});

const taskFixtures: RequestTask[] = ["T0001", "T0002", "T0003"].map((taskId, index) => ({
  taskId,
  rowNumber: index + 1,
  permno: String(index + 1),
  company: `Company ${index + 1}`,
  ticker: `C${index + 1}`,
  ccDate: "2015-01-01",
  dateFrom: "2015-01-01",
  dateTo: "2015-01-15",
  rawLine: ""
}));
