export interface RequestTask {
  taskId: string;
  rowNumber: number;
  permno: string;
  company: string;
  ticker: string;
  ccDate: string;
  dateFrom: string;
  dateTo: string;
  rawLine: string;
}

export type FinalTaskStatus =
  | "downloaded"
  | "no_results"
  | "no_rows"
  | "no_downloadable_report"
  | "filter_not_applied"
  | "download_started"
  | "page_limit"
  | "max_downloads"
  | "task_failed"
  | "special_company_case";

export interface DownloadArtifact {
  path: string;
  suggestedFilename: string;
  sha256: string;
  bytes: number;
  pages: number;
}

export interface MappingRecord {
  accountId?: string;
  timestamp: string;
  taskId: string;
  company: string;
  dateFrom: string;
  dateTo: string;
  reportTitle: string;
  reportDate: string;
  pages: number;
  filePath: string;
  status: FinalTaskStatus;
  error: string;
  sourceUrl: string;
}

export interface TaskStatusRecord {
  accountId?: string;
  ts: string;
  timestamp: string;
  runDate: string;
  taskId: string;
  company: string;
  dateFrom: string;
  dateTo: string;
  status: FinalTaskStatus;
  pages: number;
  dailyTotalPages: number;
  dayPageLimit: number;
  note: string;
  pageUrl: string;
  artifacts: DownloadArtifact[];
}

export interface CompanyResolutionRecord {
  taskId: string;
  originalCompany: string;
  ticker: string;
  query: string;
  candidates: Array<{ label: string; value: string; score: number }>;
  selected?: { label: string; value: string; score: number };
  matchType: "exact_ticker" | "ticker_suffix" | "company_exact" | "company_contains" | "label_contains_ticker" | "none";
  confidence: number;
  note: string;
  timestamp: string;
}
