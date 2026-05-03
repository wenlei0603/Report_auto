import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { todayIso, timestampIso } from "../domain/dates.js";
import type { DownloadArtifact, FinalTaskStatus, MappingRecord, RequestTask, TaskStatusRecord } from "../domain/types.js";
import { appendCsvRow, ensureCsvHeader } from "./csv.js";
import { appendJsonl, readJsonl } from "./jsonl.js";

const MAPPING_HEADERS = [
  "timestamp",
  "task_id",
  "company",
  "date_from",
  "date_to",
  "report_title",
  "report_date",
  "pages",
  "file_path",
  "status",
  "error",
  "source_url"
];

const PROGRESS_HEADERS = [
  "timestamp",
  "run_date",
  "task_id",
  "company",
  "date_from",
  "date_to",
  "status",
  "pages",
  "daily_total_pages",
  "day_page_limit",
  "note",
  "page_url"
];

const TERMINAL_STATUSES = new Set<FinalTaskStatus>([
  "downloaded",
  "no_results",
  "no_rows",
  "no_downloadable_report",
  "page_limit",
  "max_downloads",
  "special_company_case"
]);

export class RecordStore {
  constructor(
    private readonly mappingCsv: string,
    private readonly statusJsonl: string,
    private readonly progressCsv: string,
    private readonly dayPageLimit: number
  ) {}

  async initialize(): Promise<void> {
    await Promise.all([
      ensureCsvHeader(this.mappingCsv, MAPPING_HEADERS),
      ensureCsvHeader(this.progressCsv, PROGRESS_HEADERS),
      mkdir(path.dirname(this.statusJsonl), { recursive: true })
    ]);
  }

  async doneTaskIds(): Promise<Set<string>> {
    const records = await readJsonl<TaskStatusRecord>(this.statusJsonl);
    return new Set(records.filter((record) => TERMINAL_STATUSES.has(record.status)).map((record) => record.taskId));
  }

  async dailyPages(runDate = todayIso()): Promise<number> {
    const records = await readJsonl<TaskStatusRecord>(this.statusJsonl);
    return records
      .filter((record) => record.runDate === runDate)
      .filter((record) => record.status === "downloaded")
      .reduce((sum, record) => sum + Math.max(0, record.pages || 0), 0);
  }

  async writeStatus(input: {
    task: RequestTask;
    status: FinalTaskStatus;
    pages: number;
    note: string;
    pageUrl: string;
    artifacts?: DownloadArtifact[];
  }): Promise<TaskStatusRecord> {
    const runDate = todayIso();
    const dailyTotalPages = (await this.dailyPages(runDate)) + (input.status === "downloaded" ? input.pages : 0);
    const now = timestampIso();
    const record: TaskStatusRecord = {
      ts: now,
      timestamp: now,
      runDate,
      taskId: input.task.taskId,
      company: input.task.company,
      dateFrom: input.task.dateFrom,
      dateTo: input.task.dateTo,
      status: input.status,
      pages: input.pages,
      dailyTotalPages,
      dayPageLimit: this.dayPageLimit,
      note: input.note,
      pageUrl: input.pageUrl,
      artifacts: input.artifacts ?? []
    };
    await appendJsonl(this.statusJsonl, record);
    await appendCsvRow(this.progressCsv, [
      record.timestamp,
      record.runDate,
      record.taskId,
      record.company,
      record.dateFrom,
      record.dateTo,
      record.status,
      record.pages,
      record.dailyTotalPages,
      record.dayPageLimit,
      record.note,
      record.pageUrl
    ]);
    return record;
  }

  async appendMapping(record: MappingRecord): Promise<void> {
    await ensureCsvHeader(this.mappingCsv, MAPPING_HEADERS);
    await appendCsvRow(this.mappingCsv, [
      record.timestamp,
      record.taskId,
      record.company,
      record.dateFrom,
      record.dateTo,
      record.reportTitle,
      record.reportDate,
      record.pages,
      record.filePath,
      record.status,
      record.error,
      record.sourceUrl
    ]);
  }

  async fileExists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }
}
