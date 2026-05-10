import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { resolveProjectPath } from "./utils/paths.js";

const SelectorsSchema = z.object({
  company_input: z.array(z.string()),
  company_option_items: z.array(z.string()),
  apply_buttons: z.array(z.string()),
  modify_query_buttons: z.array(z.string()),
  result_rows: z.array(z.string()),
  no_results_text: z.array(z.string()),
  next_page_buttons: z.array(z.string()),
  download_buttons: z.array(z.string()),
  select_all_checkboxes: z.array(z.string()),
  save_to_pc_buttons: z.array(z.string()),
  pages_text: z.array(z.string()),
  report_title: z.array(z.string()),
  report_date: z.array(z.string())
});

const AccountSchema = z.object({
  id: z.string().min(1),
  cdp_endpoint: z.string().min(1),
  daily_page_limit: z.number().int().positive(),
  download_dir: z.string().min(1)
});

const ConfigSchema = z.object({
  workspace_url: z.string().url(),
  input_file: z.string(),
  download_dir: z.string(),
  mapping_csv: z.string(),
  status_log_jsonl: z.string(),
  progress_csv: z.string(),
  run_log_jsonl: z.string(),
  daily_page_limit: z.number().int().positive(),
  max_downloads: z.number().int().min(0),
  cdp_endpoint: z.string(),
  accounts: z.array(AccountSchema).optional(),
  browser: z.object({
    headless: z.boolean(),
    slow_mo_ms: z.number().int().min(0),
    fallback_channel: z.string(),
    user_data_dir: z.string()
  }),
  filters: z.object({
    contributor: z.string(),
    country: z.string(),
    industry: z.string(),
    max_pages: z.number().int().positive()
  }),
  timeouts: z.object({
    default_ms: z.number().int().positive(),
    download_ms: z.number().int().positive(),
    login_wait_seconds: z.number().int().positive()
  }),
  behavior: z.object({
    apply_global_filters_once: z.boolean(),
    app_restart_attempts: z.number().int().min(0),
    recover_from_batchsaveprint: z.boolean(),
    require_download_artifacts: z.boolean(),
    debug_max_tasks: z.number().int().min(0)
  }),
  selectors: SelectorsSchema
});

export type LsegConfig = z.infer<typeof ConfigSchema>;
export type LsegAccountConfig = z.infer<typeof AccountSchema>;

export async function loadConfig(configPath: string, projectRoot = process.cwd()): Promise<LsegConfig> {
  const resolved = resolveProjectPath(configPath, projectRoot);
  const raw = parseYaml(await readFile(resolved, "utf8")) as unknown;
  const parsed = ConfigSchema.parse(raw);
  return resolveConfigPaths(parsed, projectRoot);
}

function resolveConfigPaths(config: LsegConfig, projectRoot: string): LsegConfig {
  return {
    ...config,
    input_file: resolveProjectPath(config.input_file, projectRoot),
    download_dir: resolveProjectPath(config.download_dir, projectRoot),
    mapping_csv: resolveProjectPath(config.mapping_csv, projectRoot),
    status_log_jsonl: resolveProjectPath(config.status_log_jsonl, projectRoot),
    progress_csv: resolveProjectPath(config.progress_csv, projectRoot),
    run_log_jsonl: resolveProjectPath(config.run_log_jsonl, projectRoot),
    accounts: config.accounts?.map((account) => ({
      ...account,
      download_dir: resolveProjectPath(account.download_dir, projectRoot)
    }))
  };
}

export function normalizeAccounts(config: LsegConfig): LsegAccountConfig[] {
  const accounts = config.accounts?.length
    ? config.accounts
    : [
        {
          id: "default",
          cdp_endpoint: config.cdp_endpoint,
          daily_page_limit: config.daily_page_limit,
          download_dir: config.download_dir
        }
      ];
  assertUniqueAccounts(accounts);
  return accounts;
}

export function configForAccount(config: LsegConfig, account: LsegAccountConfig): LsegConfig {
  return {
    ...config,
    cdp_endpoint: account.cdp_endpoint,
    daily_page_limit: account.daily_page_limit,
    download_dir: account.download_dir
  };
}

function assertUniqueAccounts(accounts: LsegAccountConfig[]): void {
  const ids = new Set<string>();
  const endpoints = new Set<string>();
  for (const account of accounts) {
    if (ids.has(account.id)) {
      throw new Error(`Duplicate account id: ${account.id}`);
    }
    ids.add(account.id);
    if (endpoints.has(account.cdp_endpoint)) {
      throw new Error(`Duplicate account cdp_endpoint: ${account.cdp_endpoint}`);
    }
    endpoints.add(account.cdp_endpoint);
  }
}
