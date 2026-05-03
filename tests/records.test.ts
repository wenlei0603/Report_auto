import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecordStore } from "../src/io/records.js";
import type { RequestTask } from "../src/domain/types.js";

let tmpDir = "";

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "lseg-records-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("record store", () => {
  it("writes status jsonl and progress csv", async () => {
    const store = new RecordStore(
      path.join(tmpDir, "mapping.csv"),
      path.join(tmpDir, "status.jsonl"),
      path.join(tmpDir, "progress.csv"),
      500
    );
    await store.initialize();
    await store.writeStatus({
      task: taskFixture,
      status: "downloaded",
      pages: 12,
      note: "ok",
      pageUrl: "https://workspace.refinitiv.com"
    });

    expect(await store.dailyPages()).toBe(12);
    expect(await store.doneTaskIds()).toEqual(new Set(["T0001"]));
    expect(await readFile(path.join(tmpDir, "progress.csv"), "utf8")).toContain("T0001");
  });

  it("uses the latest task status when deciding completed tasks and daily pages", async () => {
    const store = new RecordStore(
      path.join(tmpDir, "mapping.csv"),
      path.join(tmpDir, "status.jsonl"),
      path.join(tmpDir, "progress.csv"),
      500
    );
    await store.initialize();
    await store.writeStatus({
      task: taskFixture,
      status: "downloaded",
      pages: 12,
      note: "partial download",
      pageUrl: "https://workspace.refinitiv.com"
    });
    await store.writeStatus({
      task: taskFixture,
      status: "task_failed",
      pages: 0,
      note: "manual rerun requested",
      pageUrl: "https://workspace.refinitiv.com"
    });

    expect(await store.doneTaskIds()).toEqual(new Set());
    expect(await store.dailyPages()).toBe(0);
  });
});

const taskFixture: RequestTask = {
  taskId: "T0001",
  rowNumber: 1,
  permno: "1",
  company: "3M Co",
  ticker: "MMM",
  ccDate: "2015-10-22",
  dateFrom: "2015-10-22",
  dateTo: "2015-11-05",
  rawLine: ""
};
