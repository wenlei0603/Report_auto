import { describe, expect, test } from "vitest";
import { nextSessionFailureAction, shouldWorkerContinueAfterStatus } from "../src/automation/parallelEngine.js";
import { TaskQueue } from "../src/automation/taskQueue.js";
import type { RequestTask } from "../src/domain/types.js";

describe("parallel worker stop semantics", () => {
  test("page_limit stops only the current worker", () => {
    expect(shouldWorkerContinueAfterStatus("page_limit")).toBe(false);
  });

  test("downloaded allows the worker to keep leasing tasks", () => {
    expect(shouldWorkerContinueAfterStatus("downloaded")).toBe(true);
  });

  test("filter_not_applied allows later tasks to continue", () => {
    expect(shouldWorkerContinueAfterStatus("filter_not_applied")).toBe(true);
  });
});

describe("parallel session failure recovery policy", () => {
  test("reconnects and retries the task on first session-like task failure", () => {
    expect(nextSessionFailureAction(0)).toBe("retry_session");
  });

  test("hands the account to human review after the second session-like task failure", () => {
    expect(nextSessionFailureAction(1)).toBe("human_review");
  });
});

test("leased task completion allows another account to continue after one worker stops", () => {
  const queue = new TaskQueue([task("T0001"), task("T0002")]);

  const first = queue.leaseNext("account_a")!;
  queue.complete(first.taskId);
  expect(shouldWorkerContinueAfterStatus("page_limit")).toBe(false);

  const second = queue.leaseNext("account_b")!;
  expect(second.taskId).toBe("T0002");
});

function task(taskId: string): RequestTask {
  return {
    taskId,
    rowNumber: Number(taskId.replace(/\D/g, "")),
    permno: taskId,
    company: `Company ${taskId}`,
    ticker: taskId,
    ccDate: "01-Jan-2016",
    dateFrom: "01-Jan-2016",
    dateTo: "08-Jan-2016",
    rawLine: ""
  };
}
