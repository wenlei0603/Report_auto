import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { LsegAccountConfig, LsegConfig } from "../config.js";

export interface ParallelAccountSpec extends LsegAccountConfig {
  profile_dir?: string;
}

export interface ParallelPreflightResult {
  accounts: ParallelAccountSpec[];
  issues: string[];
  passwordKeysIgnored: string[];
}

export interface AccountFilterConfigurationState {
  state: string;
}

type EnvMap = Record<string, string | undefined>;

export function parseDotEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export async function loadDotEnv(path = ".env"): Promise<Record<string, string>> {
  if (!existsSync(path)) {
    return {};
  }
  return parseDotEnv(await readFile(path, "utf8"));
}

export function mergedLocalEnv(dotEnv: Record<string, string>, processEnv: NodeJS.ProcessEnv = process.env): EnvMap {
  return { ...dotEnv, ...processEnv };
}

export function applyEnvAccounts(config: LsegConfig, env: EnvMap): LsegConfig {
  const specs = buildParallelAccountSpecs(env);
  if (!specs.length) {
    return config;
  }
  return {
    ...config,
    accounts: specs.map(({ profile_dir: _profileDir, ...account }) => account)
  };
}

export function buildParallelAccountSpecs(env: EnvMap): ParallelAccountSpec[] {
  const specs: ParallelAccountSpec[] = [];
  for (const index of parallelAccountIndexes(env)) {
    const prefix = `LSEG_ACCOUNT_${index}_`;
    const id = env[`${prefix}ID`]?.trim() || `account_${index}`;
    const cdpEndpoint = requiredEnv(env, `${prefix}CDP_ENDPOINT`);
    const downloadDir = requiredEnv(env, `${prefix}DOWNLOAD_DIR`);
    const dailyLimit = parsePositiveInteger(env[`${prefix}DAILY_PAGE_LIMIT`] ?? "700", `${prefix}DAILY_PAGE_LIMIT`);
    const profileDir = env[`${prefix}PROFILE_DIR`]?.trim();
    const inheritUntaggedUsage = parseOptionalBoolean(env[`${prefix}INHERIT_UNTAGGED_USAGE`], `${prefix}INHERIT_UNTAGGED_USAGE`);
    specs.push({
      id,
      cdp_endpoint: cdpEndpoint,
      daily_page_limit: dailyLimit,
      download_dir: downloadDir,
      ...(profileDir ? { profile_dir: profileDir } : {}),
      ...(inheritUntaggedUsage ? { inherit_untagged_usage: true } : {})
    });
  }
  assertUniqueSpecs(specs);
  return specs;
}

export function accountReadyForFilterConfiguration(state: AccountFilterConfigurationState | undefined): boolean {
  return state?.state === "query";
}

export async function buildParallelPreflightResult(config: LsegConfig, env: EnvMap): Promise<ParallelPreflightResult> {
  const accounts = buildParallelAccountSpecs(env);
  const effectiveAccounts = accounts.length ? accounts : config.accounts ?? [];
  const issues: string[] = [];
  if (effectiveAccounts.length < 2) {
    issues.push("Configure at least two accounts for a parallel run.");
  }
  for (const account of effectiveAccounts) {
    const endpointIssue = await checkCdpEndpoint(account.cdp_endpoint);
    if (endpointIssue) {
      issues.push(`${account.id}: ${endpointIssue}`);
    }
  }
  const passwordKeysIgnored = Object.keys(env).filter((key) => /PASSWORD|PASSCODE|SECRET|TOKEN/i.test(key));
  return { accounts: effectiveAccounts, issues, passwordKeysIgnored };
}

async function checkCdpEndpoint(endpoint: string): Promise<string | undefined> {
  try {
    const response = await fetch(new URL("/json/version", endpoint), { signal: AbortSignal.timeout(3000) });
    if (!response.ok) {
      return `CDP endpoint returned HTTP ${response.status}`;
    }
    return undefined;
  } catch (error) {
    return `CDP endpoint is not reachable (${String(error)})`;
  }
}

function parallelAccountIndexes(env: EnvMap): number[] {
  const indexes = new Set<number>();
  for (const key of Object.keys(env)) {
    const match = /^LSEG_ACCOUNT_(\d+)_(ID|CDP_ENDPOINT|DOWNLOAD_DIR|DAILY_PAGE_LIMIT|PROFILE_DIR|INHERIT_UNTAGGED_USAGE)$/.exec(key);
    if (match) {
      indexes.add(Number(match[1]));
    }
  }
  return [...indexes].sort((a, b) => a - b);
}

function requiredEnv(env: EnvMap, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required ${key}`);
  }
  return value;
}

function parsePositiveInteger(value: string, key: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer for ${key}, got ${value}`);
  }
  return parsed;
}

function parseOptionalBoolean(value: string | undefined, key: string): boolean {
  if (value === undefined || value.trim() === "") {
    return false;
  }
  if (/^(true|1|yes)$/i.test(value.trim())) {
    return true;
  }
  if (/^(false|0|no)$/i.test(value.trim())) {
    return false;
  }
  throw new Error(`Expected boolean for ${key}, got ${value}`);
}

function assertUniqueSpecs(specs: ParallelAccountSpec[]): void {
  assertUnique(specs.map((spec) => spec.id), "account id");
  assertUnique(specs.map((spec) => spec.cdp_endpoint), "account cdp_endpoint");
  assertUnique(
    specs.map((spec) => spec.profile_dir).filter((profileDir): profileDir is string => Boolean(profileDir)),
    "account profile_dir"
  );
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`Duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}
