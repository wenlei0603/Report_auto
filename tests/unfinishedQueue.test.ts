import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildUnfinishedQueue } from "../src/io/unfinishedQueue.js";
import { parseTasks } from "../src/domain/tasks.js";

describe("unfinished queue builder", () => {
  it("builds a portable task_id queue from non-empty by_task folders", async () => {
    const root = path.join(tmpdir(), `lseg-unfinished-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const taskFile = path.join(root, "tasks.txt");
    const byTaskRoot = path.join(root, "output", "downloads", "by_task");
    const outputFile = path.join(root, "queues", "unfinished.tsv");
    const auditFile = path.join(root, "queues", "unfinished.audit.csv");

    await mkdir(path.join(byTaskRoot, "T0003"), { recursive: true });
    await mkdir(path.join(byTaskRoot, "T0004"), { recursive: true });
    await writeFile(path.join(byTaskRoot, "T0003", "report.pdf"), "pdf", "utf8");
    await writeFile(
      taskFile,
      [
        "permno\tcompanyname\ttickers\tcc_date\twindow_start\twindow_end",
        "1\tCompany One\tC1\t2016-01-01\t2016-01-01\t2016-01-15",
        "2\tCompany Two\tC2\t2016-02-01\t2016-02-01\t2016-02-15",
        "3\tCompany Three\tC3\t2016-03-01\t2016-03-01\t2016-03-15",
        "4\tCompany Four\tC4\t2016-04-01\t2016-04-01\t2016-04-15"
      ].join("\n") + "\n",
      "utf8"
    );

    const summary = await buildUnfinishedQueue({ taskFile, byTaskRoot, outputFile, auditFile, fromTask: "T0002" });
    const queueText = await readFile(outputFile, "utf8");
    const parsed = parseTasks(queueText.split(/\r?\n/));

    expect(summary).toMatchObject({
      totalSourceTasks: 4,
      completedNonEmptyFolders: 1,
      emptyTaskFolders: 1,
      selectedTasks: 3,
      firstSelectedTask: "T0002",
      lastSelectedTask: "T0005"
    });
    expect(parsed.map((task) => task.taskId)).toEqual(["T0002", "T0004", "T0005"]);
    expect(await readFile(auditFile, "utf8")).toContain("no_non_empty_task_folder_under_output_downloads_by_task");
  });
});
