import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyArchiveRepairPlan, buildArchiveRepairPlan, splitPathList } from "../src/io/archiveRepair.js";

const tempDirs: string[] = [];

describe("archive repair", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("plans a clean copy from raw Downloads when the task archive contains another task's PDF", async () => {
    const root = await tempRoot();
    const rawDownloads = path.join(root, "Downloads");
    const archiveRoot = path.join(root, "by_task");
    const runLog = path.join(root, "run_log.jsonl");
    const statusLog = path.join(root, "task_status.jsonl");

    const correctPdf = path.join(
      rawDownloads,
      "2016-08-09-NUAN.OQ^C22-Morgan Stanley-Nuance Communications Inc. 3Q16 Results Revenue Growth Timeline Pushed Out...-75449742.pdf"
    );
    await writeText(correctPdf, "correct");
    await writeText(
      path.join(archiveRoot, "T2753", "2016-05-06-SSNC.OQ-Morgan Stanley-SSC Technologies Holdings, Inc. Looking Forward To Second ...-74415118.pdf"),
      "wrong"
    );
    await writeText(runLog, `${JSON.stringify(downloadRowSelectionLog("T2753"))}\n`);
    await writeText(statusLog, `${JSON.stringify({ taskId: "T2753", status: "download_started" })}\n`);

    const plan = await buildArchiveRepairPlan({
      runLogPaths: [runLog],
      statusLogPaths: [statusLog],
      rawDownloadsDir: rawDownloads,
      existingArchiveRoot: archiveRoot
    });

    expect(plan.rawPdfCount).toBe(1);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]).toMatchObject({
      taskId: "T2753",
      status: "existing_polluted",
      expected: 1,
      matchedCount: 1,
      existingPdfCount: 1,
      extraExistingCount: 1,
      missingMatchedCount: 1
    });
    expect(plan.tasks[0]?.matchedPaths).toEqual([correctPdf]);
  });

  it("copies matched raw PDFs into a repair target without deleting the current archive", async () => {
    const root = await tempRoot();
    const rawDownloads = path.join(root, "Downloads");
    const archiveRoot = path.join(root, "by_task");
    const repairRoot = path.join(root, "by_task_repaired");
    const runLog = path.join(root, "run_log.jsonl");
    const statusLog = path.join(root, "task_status.jsonl");
    const sourcePdf = path.join(
      rawDownloads,
      "2016-08-09-NUAN.OQ^C22-Morgan Stanley-Nuance Communications Inc. 3Q16 Results Revenue Growth Timeline Pushed Out...-75449742.pdf"
    );
    const pollutedPdf = path.join(archiveRoot, "T2753", "wrong.pdf");

    await writeText(sourcePdf, "correct");
    await writeText(pollutedPdf, "wrong");
    await writeText(runLog, `${JSON.stringify(downloadRowSelectionLog("T2753"))}\n`);
    await writeText(statusLog, `${JSON.stringify({ taskId: "T2753", status: "downloaded" })}\n`);

    const plan = await buildArchiveRepairPlan({
      runLogPaths: [runLog],
      statusLogPaths: [statusLog],
      rawDownloadsDir: rawDownloads,
      existingArchiveRoot: archiveRoot
    });
    const applied = await applyArchiveRepairPlan(plan, repairRoot);

    expect(applied.copied).toBe(1);
    expect(applied.skippedExisting).toBe(0);
    expect(applied.targetRoot).toBe(repairRoot);
    expect(applied.copiedPaths[0]).toBe(path.join(repairRoot, "T2753", path.basename(sourcePdf)));
    expect(plan.tasks[0]?.extraExistingPaths).toEqual([pollutedPdf]);
  });

  it("skips selected rows that were never submitted unless requested", async () => {
    const root = await tempRoot();
    const rawDownloads = path.join(root, "Downloads");
    const runLog = path.join(root, "run_log.jsonl");
    const statusLog = path.join(root, "task_status.jsonl");
    await writeText(
      path.join(
        rawDownloads,
        "2016-08-09-NUAN.OQ^C22-Morgan Stanley-Nuance Communications Inc. 3Q16 Results Revenue Growth Timeline Pushed Out...-75449742.pdf"
      ),
      "correct"
    );
    await writeText(runLog, `${JSON.stringify(downloadRowSelectionLog("T2753"))}\n`);
    await writeText(statusLog, `${JSON.stringify({ taskId: "T2753", status: "no_downloadable_report" })}\n`);

    const filtered = await buildArchiveRepairPlan({
      runLogPaths: [runLog],
      statusLogPaths: [statusLog],
      rawDownloadsDir: rawDownloads,
      existingArchiveRoot: path.join(root, "by_task")
    });
    const included = await buildArchiveRepairPlan({
      runLogPaths: [runLog],
      statusLogPaths: [statusLog],
      rawDownloadsDir: rawDownloads,
      existingArchiveRoot: path.join(root, "by_task"),
      includeUnsubmitted: true
    });

    expect(filtered.tasks).toHaveLength(0);
    expect(included.tasks).toHaveLength(1);
  });

  it("splits comma and semicolon separated path lists", () => {
    expect(splitPathList("a.jsonl, b.jsonl; c.jsonl")).toEqual(["a.jsonl", "b.jsonl", "c.jsonl"]);
  });
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lseg-archive-repair-"));
  tempDirs.push(dir);
  return dir;
}

async function writeText(filePath: string, value: string): Promise<void> {
  await writeFile(filePath, value, { encoding: "utf8", flag: "w" }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
    await import("node:fs/promises").then(async ({ mkdir }) => mkdir(path.dirname(filePath), { recursive: true }));
    await writeFile(filePath, value, "utf8");
  });
}

function downloadRowSelectionLog(taskId: string): Record<string, unknown> {
  return {
    ts: "2026-05-26T08:00:00.000Z",
    level: "INFO",
    message: "Download row selection",
    taskId,
    inspectableRows: 1,
    requested: 1,
    selected: 1,
    tickerMatched: 1,
    tickerMismatch: 0,
    selectedRows: [
      {
        rowIndex: 0,
        category: "ticker_matched",
        date: "09-Aug-2016",
        available: "16-Aug-2016",
        company: "Nuance Communications Inc",
        ticker: "NUAN.OQ^C22",
        title: "RequestNuance Communications Inc.: 3Q16 Results: Revenue Growth Timeline Pushed Out by Shift to Subscription",
        pages: "14",
        contributor: "Morgan Stanley",
        scoreTotal: 100,
        scoreBreakdown: {
          tickerScore: 40,
          titleScore: 35,
          dateScore: 25,
          penalties: 0,
          industryPenaltyApplied: false
        },
        reasons: []
      }
    ],
    rejectedRows: []
  };
}
