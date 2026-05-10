import { describe, expect, test } from "vitest";
import { shouldWorkerContinueAfterStatus } from "../src/automation/parallelEngine.js";

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
