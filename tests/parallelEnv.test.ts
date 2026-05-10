import { describe, expect, test } from "vitest";
import { applyEnvAccounts, buildParallelAccountSpecs, parseDotEnv } from "../src/runtime/parallelEnv.js";
import type { LsegConfig } from "../src/config.js";

describe("parseDotEnv", () => {
  test("parses local key value pairs without requiring a dependency", () => {
    const env = parseDotEnv(`
      # local only
      LSEG_ACCOUNT_1_ID=account_a
      LSEG_ACCOUNT_1_PROFILE_DIR="D:/chrome profiles/account a"
    `);

    expect(env.LSEG_ACCOUNT_1_ID).toBe("account_a");
    expect(env.LSEG_ACCOUNT_1_PROFILE_DIR).toBe("D:/chrome profiles/account a");
  });
});

describe("parallel accounts from env", () => {
  test("builds any number of numbered accounts from .env-style variables", () => {
    const specs = buildParallelAccountSpecs({
      LSEG_ACCOUNT_1_ID: "account_a",
      LSEG_ACCOUNT_1_CDP_ENDPOINT: "http://127.0.0.1:9222",
      LSEG_ACCOUNT_1_DAILY_PAGE_LIMIT: "700",
      LSEG_ACCOUNT_1_DOWNLOAD_DIR: "output/downloads/account_a",
      LSEG_ACCOUNT_1_PROFILE_DIR: "D:/chrome-rpa-profile-account-a",
      LSEG_ACCOUNT_2_ID: "account_b",
      LSEG_ACCOUNT_2_CDP_ENDPOINT: "http://127.0.0.1:9223",
      LSEG_ACCOUNT_2_DAILY_PAGE_LIMIT: "700",
      LSEG_ACCOUNT_2_DOWNLOAD_DIR: "output/downloads/account_b",
      LSEG_ACCOUNT_2_PROFILE_DIR: "D:/chrome-rpa-profile-account-b",
      LSEG_ACCOUNT_3_ID: "account_c",
      LSEG_ACCOUNT_3_CDP_ENDPOINT: "http://127.0.0.1:9224",
      LSEG_ACCOUNT_3_DAILY_PAGE_LIMIT: "700",
      LSEG_ACCOUNT_3_DOWNLOAD_DIR: "output/downloads/account_c",
      LSEG_ACCOUNT_3_PROFILE_DIR: "D:/chrome-rpa-profile-account-c"
    });

    expect(specs.map((spec) => spec.id)).toEqual(["account_a", "account_b", "account_c"]);
  });

  test("rejects reused Chrome profile directories before a browser run", () => {
    expect(() =>
      buildParallelAccountSpecs({
        LSEG_ACCOUNT_1_ID: "account_a",
        LSEG_ACCOUNT_1_CDP_ENDPOINT: "http://127.0.0.1:9222",
        LSEG_ACCOUNT_1_DOWNLOAD_DIR: "output/downloads/account_a",
        LSEG_ACCOUNT_1_PROFILE_DIR: "D:/same-profile",
        LSEG_ACCOUNT_2_ID: "account_b",
        LSEG_ACCOUNT_2_CDP_ENDPOINT: "http://127.0.0.1:9223",
        LSEG_ACCOUNT_2_DOWNLOAD_DIR: "output/downloads/account_b",
        LSEG_ACCOUNT_2_PROFILE_DIR: "D:/same-profile"
      })
    ).toThrow(/Duplicate account profile_dir: D:\/same-profile/);
  });

  test("overlays config accounts from local env without modifying tracked yaml", () => {
    const config = baseConfig();

    const updated = applyEnvAccounts(config, {
      LSEG_ACCOUNT_1_ID: "account_a",
      LSEG_ACCOUNT_1_CDP_ENDPOINT: "http://127.0.0.1:9222",
      LSEG_ACCOUNT_1_DAILY_PAGE_LIMIT: "700",
      LSEG_ACCOUNT_1_DOWNLOAD_DIR: "output/downloads/account_a",
      LSEG_ACCOUNT_1_PROFILE_DIR: "D:/chrome-rpa-profile-account-a",
      LSEG_ACCOUNT_2_ID: "account_b",
      LSEG_ACCOUNT_2_CDP_ENDPOINT: "http://127.0.0.1:9223",
      LSEG_ACCOUNT_2_DAILY_PAGE_LIMIT: "700",
      LSEG_ACCOUNT_2_DOWNLOAD_DIR: "output/downloads/account_b",
      LSEG_ACCOUNT_2_PROFILE_DIR: "D:/chrome-rpa-profile-account-b"
    });

    expect(updated.accounts?.map((account) => account.id)).toEqual(["account_a", "account_b"]);
    expect(updated.accounts?.[1]?.download_dir).toBe("output/downloads/account_b");
  });
});

function baseConfig(): LsegConfig {
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
    }
  };
}
