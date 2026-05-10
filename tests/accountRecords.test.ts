import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { RequestTask } from "../src/domain/types.js";
import { RecordStore } from "../src/io/records.js";

const task: RequestTask = {
  taskId: "T0001",
  rowNumber: 1,
  permno: "12345",
  company: "Example Corp",
  ticker: "EXM",
  ccDate: "01-Jan-2016",
  dateFrom: "01-Jan-2016",
  dateTo: "08-Jan-2016",
  rawLine: ""
};

async function storeInTemp(limit = 700): Promise<{ store: RecordStore; status: string; progress: string; mapping: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lseg-records-"));
  const mapping = path.join(dir, "mapping.csv");
  const status = path.join(dir, "status.jsonl");
  const progress = path.join(dir, "progress.csv");
  const store = new RecordStore(mapping, status, progress, limit);
  await store.initialize();
  return { store, status, progress, mapping };
}

describe("account-aware records", () => {
  test("dailyPagesForAccount counts only the selected account", async () => {
    const { store } = await storeInTemp();
    await store.writeStatus({ accountId: "account_a", task, status: "download_started", pages: 100, note: "a", pageUrl: "url" });
    await store.writeStatus({
      accountId: "account_b",
      task: { ...task, taskId: "T0002" },
      status: "download_started",
      pages: 200,
      note: "b",
      pageUrl: "url"
    });

    await expect(store.dailyPagesForAccount("account_a")).resolves.toBe(100);
    await expect(store.dailyPagesForAccount("account_b")).resolves.toBe(200);
  });

  test("legacy dailyPages still counts records without accountId", async () => {
    const { store } = await storeInTemp();
    await store.writeStatus({ task, status: "download_started", pages: 77, note: "legacy", pageUrl: "url" });

    await expect(store.dailyPages()).resolves.toBe(77);
  });

  test("progress and mapping CSVs include account_id", async () => {
    const { store, progress, mapping } = await storeInTemp();
    await store.writeStatus({ accountId: "account_a", task, status: "download_started", pages: 12, note: "started", pageUrl: "url" });
    await store.appendMapping({
      accountId: "account_a",
      timestamp: "2026-05-10T00:00:00.000Z",
      taskId: "T0001",
      company: "Example Corp",
      dateFrom: "01-Jan-2016",
      dateTo: "08-Jan-2016",
      reportTitle: "Report",
      reportDate: "01-Jan-2016",
      pages: 12,
      filePath: "file.pdf",
      status: "downloaded",
      error: "",
      sourceUrl: "url"
    });

    await expect(readFile(progress, "utf8")).resolves.toContain("account_id");
    await expect(readFile(mapping, "utf8")).resolves.toContain("account_id");
  });

  test("account status dailyTotalPages is scoped to that account", async () => {
    const { store, status } = await storeInTemp();
    await store.writeStatus({ accountId: "account_a", task, status: "download_started", pages: 100, note: "a", pageUrl: "url" });
    await store.writeStatus({
      accountId: "account_b",
      task: { ...task, taskId: "T0002" },
      status: "download_started",
      pages: 200,
      note: "b",
      pageUrl: "url"
    });

    const records = (await readFile(status, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { accountId: string; dailyTotalPages: number });

    expect(records[0]).toMatchObject({ accountId: "account_a", dailyTotalPages: 100 });
    expect(records[1]).toMatchObject({ accountId: "account_b", dailyTotalPages: 200 });
  });
});
