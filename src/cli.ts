#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { inspectCurrentBrowser, runAutomation } from "./automation/engine.js";
import { runParallelAutomation } from "./automation/parallelEngine.js";
import { applyEnvAccounts, buildParallelPreflightResult, loadDotEnv, mergedLocalEnv } from "./runtime/parallelEnv.js";
import { openBrowserSession } from "./browser/session.js";
import { waitForResearchScope } from "./browser/scope.js";
import { classifyAppState } from "./browser/state.js";
import { configForAccount, normalizeAccounts, type LsegConfig } from "./config.js";
import { RunLogger } from "./io/runLogger.js";

const program = new Command();

program
  .name("lseg-rn")
  .description("LSEG Research Next full automation runner")
  .option("-c, --config <path>", "config file", "config/lseg.yaml");

program
  .command("run")
  .description("Run the full automation loop against a manually logged-in browser")
  .option("--dry-run", "parse and print pending tasks without browser actions", false)
  .option("--max-tasks <count>", "maximum tasks to process", parsePositiveInt)
  .option("--max-downloads <count>", "maximum successful downloads", parseNonNegativeInt)
  .option("--start-from-task <taskId>", "start from a specific task id, for example T0100")
  .option("--include-done", "include tasks that already have terminal status records", false)
  .action(async (options) => {
    const rootOptions = program.opts<{ config: string }>();
    const config = await loadConfig(rootOptions.config);
    await runAutomation(config, {
      dryRun: Boolean(options.dryRun),
      maxTasks: options.maxTasks,
      maxDownloads: options.maxDownloads,
      startFromTask: options.startFromTask,
      includeDone: Boolean(options.includeDone)
    });
  });

program
  .command("run-parallel")
  .description("Run parallel automation across configured LSEG accounts")
  .option("--dry-run", "parse and print pending tasks without browser actions", false)
  .option("--max-tasks <count>", "maximum tasks to process across all accounts", parsePositiveInt)
  .option("--max-downloads <count>", "maximum successful downloads across all accounts", parseNonNegativeInt)
  .option("--start-from-task <taskId>", "start from a specific task id, for example T0100")
  .option("--include-done", "include tasks that already have terminal status records", false)
  .action(async (options) => {
    const rootOptions = program.opts<{ config: string }>();
    const config = await loadConfigWithLocalEnv(rootOptions.config);
    await runParallelAutomation(config, {
      dryRun: Boolean(options.dryRun),
      maxTasks: options.maxTasks,
      maxDownloads: options.maxDownloads,
      startFromTask: options.startFromTask,
      includeDone: Boolean(options.includeDone)
    });
  });

program
  .command("preflight-parallel")
  .description("Check local parallel account profile and CDP configuration")
  .action(async () => {
    const rootOptions = program.opts<{ config: string }>();
    const dotEnv = await loadDotEnv();
    const env = mergedLocalEnv(dotEnv);
    const config = applyEnvAccounts(await loadConfig(rootOptions.config), env);
    const result = await buildParallelPreflightResult(config, env);
    const accountStates = await inspectParallelAccountStates(config);
    process.stdout.write(`Parallel preflight accounts=${result.accounts.length}\n`);
    for (const account of result.accounts) {
      const profile = "profile_dir" in account && account.profile_dir ? "profile configured" : "profile not configured";
      const state = accountStates.get(account.id);
      process.stdout.write(`- ${account.id}: ${account.cdp_endpoint}; ${profile}; state=${state?.state ?? "unavailable"}; reason=${state?.reason ?? ""}\n`);
    }
    if (result.passwordKeysIgnored.length) {
      process.stdout.write(`Ignored secret-like env keys: ${result.passwordKeysIgnored.length}\n`);
    }
    if (result.issues.length) {
      for (const issue of result.issues) {
        process.stderr.write(`ERROR ${issue}\n`);
      }
      process.exitCode = 1;
    }
    for (const account of result.accounts) {
      const state = accountStates.get(account.id);
      if (state?.state !== "query") {
        process.stderr.write(`ERROR ${account.id}: Research Next is not in query mode; current state=${state?.state ?? "unavailable"}\n`);
        process.exitCode = 1;
      }
    }
  });

program
  .command("inspect")
  .description("Attach to the current browser and print detected LSEG app state")
  .action(async () => {
    const rootOptions = program.opts<{ config: string }>();
    const config = await loadConfig(rootOptions.config);
    const state = await inspectCurrentBrowser(config);
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  });

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});

async function loadConfigWithLocalEnv(configPath: string) {
  const dotEnv = await loadDotEnv();
  return applyEnvAccounts(await loadConfig(configPath), mergedLocalEnv(dotEnv));
}

async function inspectParallelAccountStates(config: LsegConfig): Promise<Map<string, { state: string; reason: string }>> {
  const states = new Map<string, { state: string; reason: string }>();
  for (const account of normalizeAccounts(config)) {
    const accountConfig = configForAccount(config, account);
    const logger = new RunLogger(accountConfig.run_log_jsonl);
    try {
      const session = await openBrowserSession(accountConfig, logger);
      try {
        await waitForResearchScope(session.page, accountConfig, logger);
        const state = await classifyAppState(session.page, accountConfig);
        states.set(account.id, { state: state.state, reason: state.reason });
      } finally {
        await session.browser.close().catch(() => undefined);
      }
    } catch (error) {
      states.set(account.id, { state: "unavailable", reason: String(error) });
    }
  }
  return states;
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, got ${value}`);
  }
  return parsed;
}

function parseNonNegativeInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected non-negative integer, got ${value}`);
  }
  return parsed;
}
