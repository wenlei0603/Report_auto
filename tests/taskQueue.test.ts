import { describe, expect, test } from "vitest";
import { TaskQueue } from "../src/automation/taskQueue.js";
import type { RequestTask } from "../src/domain/types.js";

function task(id: string): RequestTask {
  return {
    taskId: id,
    rowNumber: Number(id.replace(/\D/g, "")),
    permno: id,
    company: `Company ${id}`,
    ticker: id,
    ccDate: "01-Jan-2016",
    dateFrom: "01-Jan-2016",
    dateTo: "08-Jan-2016",
    rawLine: ""
  };
}

describe("TaskQueue", () => {
  test("leases each task at most once while in flight", () => {
    const queue = new TaskQueue([task("T0001"), task("T0002")]);

    const first = queue.leaseNext("account_a");
    const second = queue.leaseNext("account_b");
    const third = queue.leaseNext("account_c");

    expect(first?.taskId).toBe("T0001");
    expect(second?.taskId).toBe("T0002");
    expect(third).toBeUndefined();
    expect(queue.inFlightCount).toBe(2);
  });

  test("complete removes a leased task from in-flight accounting", () => {
    const queue = new TaskQueue([task("T0001")]);
    const leased = queue.leaseNext("account_a");

    queue.complete(leased!.taskId);

    expect(queue.inFlightCount).toBe(0);
    expect(queue.remainingCount).toBe(0);
  });

  test("release returns a task to the front of the queue", () => {
    const queue = new TaskQueue([task("T0001"), task("T0002")]);
    const leased = queue.leaseNext("account_a");

    queue.release(leased!.taskId);

    expect(queue.leaseNext("account_b")?.taskId).toBe("T0001");
  });
});
