import type { Browser, BrowserContext, Frame, Page } from "playwright";

export type AutomationScope = Page | Frame;

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export type AppState =
  | "auth"
  | "batch_save_print"
  | "query"
  | "results"
  | "document_info"
  | "loading"
  | "unknown";

export interface StateEvidence {
  state: AppState;
  pageUrl: string;
  scopeUrl: string;
  reason: string;
}

export interface FilterResult {
  ok: boolean;
  reason: string;
  details: Record<string, unknown>;
}

export interface TaskFilterResult {
  okCompany: boolean;
  okFrom: boolean;
  okTo: boolean;
  companyDetails: Record<string, unknown>;
  closedBlankTabs: number;
}

export interface ResultClassification {
  status: "results" | "no_results" | "no_rows" | "document_info" | "unknown";
  rowCount: number;
  estimatedPages: number;
  reason: string;
}
