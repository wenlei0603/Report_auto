import { describe, expect, test } from "vitest";
import { normalizeAccounts, type LsegConfig } from "../src/config.js";

function baseConfig(overrides: Partial<LsegConfig> = {}): LsegConfig {
  return {
    workspace_url: "https://workspace.refinitiv.com/web/Apps/research-next/?st=OAPermID#/?st=OAPermID",
    input_file: "input.txt",
    download_dir: "output/downloads",
    mapping_csv: "output/task_file_mapping.csv",
    status_log_jsonl: "logs/task_status.jsonl",
    progress_csv: "output/task_progress.csv",
    run_log_jsonl: "logs/run_log.jsonl",
    daily_page_limit: 700,
    max_downloads: 1,
    cdp_endpoint: "http://127.0.0.1:9222",
    browser: {
      headless: false,
      slow_mo_ms: 0,
      fallback_channel: "chrome",
      user_data_dir: "D:/chrome-rpa-profile"
    },
    filters: {
      contributor: "Morgan Stanley",
      country: "USA",
      industry: "none",
      max_pages: 23
    },
    timeouts: {
      default_ms: 20000,
      download_ms: 90000,
      login_wait_seconds: 600
    },
    behavior: {
      apply_global_filters_once: true,
      app_restart_attempts: 3,
      recover_from_batchsaveprint: true,
      require_download_artifacts: true,
      debug_max_tasks: 1
    },
    selectors: {
      company_input: [],
      company_option_items: [],
      apply_buttons: [],
      modify_query_buttons: [],
      result_rows: [],
      no_results_text: [],
      next_page_buttons: [],
      download_buttons: [],
      select_all_checkboxes: [],
      save_to_pc_buttons: [],
      pages_text: [],
      report_title: [],
      report_date: []
    },
    ...overrides
  };
}

describe("normalizeAccounts", () => {
  test("derives a default account from legacy single-account config", () => {
    const accounts = normalizeAccounts(baseConfig());

    expect(accounts).toEqual([
      {
        id: "default",
        cdp_endpoint: "http://127.0.0.1:9222",
        daily_page_limit: 700,
        download_dir: "output/downloads"
      }
    ]);
  });

  test("uses configured accounts when present", () => {
    const accounts = normalizeAccounts(
      baseConfig({
        accounts: [
          {
            id: "account_a",
            cdp_endpoint: "http://127.0.0.1:9222",
            daily_page_limit: 700,
            download_dir: "output/downloads/account_a"
          },
          {
            id: "account_b",
            cdp_endpoint: "http://127.0.0.1:9223",
            daily_page_limit: 700,
            download_dir: "output/downloads/account_b"
          }
        ]
      })
    );

    expect(accounts.map((account) => account.id)).toEqual(["account_a", "account_b"]);
  });

  test("rejects duplicate account ids", () => {
    expect(() =>
      normalizeAccounts(
        baseConfig({
          accounts: [
            { id: "dup", cdp_endpoint: "http://127.0.0.1:9222", daily_page_limit: 700, download_dir: "a" },
            { id: "dup", cdp_endpoint: "http://127.0.0.1:9223", daily_page_limit: 700, download_dir: "b" }
          ]
        })
      )
    ).toThrow(/Duplicate account id: dup/);
  });

  test("rejects duplicate account cdp endpoints", () => {
    expect(() =>
      normalizeAccounts(
        baseConfig({
          accounts: [
            { id: "a", cdp_endpoint: "http://127.0.0.1:9222", daily_page_limit: 700, download_dir: "a" },
            { id: "b", cdp_endpoint: "http://127.0.0.1:9222", daily_page_limit: 700, download_dir: "b" }
          ]
        })
      )
    ).toThrow(/Duplicate account cdp_endpoint: http:\/\/127.0.0.1:9222/);
  });
});
