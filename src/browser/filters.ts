import type { LsegConfig } from "../config.js";
import { formatPickerDate } from "../domain/dates.js";
import type { RequestTask } from "../domain/types.js";
import { clickFirst, firstVisible } from "./locators.js";
import { owningPage } from "./scope.js";
import type { AutomationScope, FilterResult, TaskFilterResult } from "./types.js";
import type { Page } from "playwright";

export interface QueryModeEvidence {
  hasVisibleCompanyInput: boolean;
  hasVisibleCompanySelector: boolean;
  hasExpandedFilterPanel: boolean;
}

export interface CompanyCandidate {
  label: string;
  value: string;
  score: number;
  matchType: string;
}

const COMPANY_SUFFIX_WORDS = new Set(["co", "inc", "corp", "corporation", "ltd", "limited", "plc", "group", "sa", "ag"]);

export interface SuggestionSnapshot {
  filtered: Array<{ label: string; value: string }>;
  signature: string;
  componentQuery: string;
  inputValue: string;
}

export function isQueryModeReady(evidence: QueryModeEvidence): boolean {
  return evidence.hasExpandedFilterPanel && (evidence.hasVisibleCompanyInput || evidence.hasVisibleCompanySelector);
}

export function chooseCompanyCandidate(
  items: Array<{ label?: string; value?: string }>,
  company: string,
  ticker: string
): CompanyCandidate | null {
  const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();
  const companyNorm = norm(company);
  const tickerNorm = norm(ticker);
  const labelSupportsTicker = (label: string) => {
    if (!tickerNorm) {
      return false;
    }
    return label.includes(tickerNorm);
  };

  const candidates = items
    .filter((item) => item?.value)
    .map((item) => {
      const label = norm(item.label);
      const value = norm(item.value);
      let score = 0;
      let matchType = "none";
      if (tickerNorm && value === tickerNorm) {
        score = 100;
        matchType = "exact_ticker";
      } else if (tickerNorm && value.startsWith(`${tickerNorm}.`)) {
        if (labelSupportsTicker(label)) {
          score = 85;
          matchType = "ticker_suffix";
        } else {
          score = 0;
          matchType = "ticker_suffix_without_label_support";
        }
      } else if (companyNorm && label === companyNorm) {
        score = 70;
        matchType = "company_exact";
      } else if (companyNorm && label.includes(companyNorm)) {
        score = 45;
        matchType = "company_contains";
      } else if (tickerNorm && label.includes(tickerNorm)) {
        score = 25;
        matchType = "label_contains_ticker";
      }

      return {
        label: String(item.label ?? ""),
        value: String(item.value ?? ""),
        score,
        matchType
      };
    })
    .sort((a, b) => b.score - a.score);

  return candidates.find((candidate) => candidate.score > 0) ?? null;
}

export async function closePopupDialogs(scope: AutomationScope): Promise<void> {
  try {
    await scope.evaluate(() => {
      const visible = (el: Element) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 2 && rect.height > 2;
      };
      const panels = [...document.querySelectorAll("coral-popup-panel.popup-dialog")].filter(visible);
      for (const panel of panels) {
        const buttons = [...panel.querySelectorAll("coral-button")];
        const cancel = buttons.find((button) => (button.textContent ?? "").trim().toLowerCase() === "cancel");
        if (cancel instanceof HTMLElement) {
          cancel.click();
          continue;
        }
        const close = panel.querySelector('coral-button[icon="cross"]');
        if (close instanceof HTMLElement) {
          close.click();
        }
      }
    });
  } catch {
    // Popups are opportunistic cleanup; failure should not hide the original action.
  }
}

export async function ensureQueryMode(scope: AutomationScope, config: LsegConfig): Promise<boolean> {
  await closePopupDialogs(scope);
  if (await waitForQueryMode(scope, config, 3500)) {
    return true;
  }
  if (await reopenSearchCriteriaPanel(scope, config)) {
    await owningPage(scope).waitForTimeout(900);
    await closePopupDialogs(scope);
    if (await waitForQueryMode(scope, config, 3500)) {
      return true;
    }
  }
  return false;
}

async function reopenSearchCriteriaPanel(scope: AutomationScope, config: LsegConfig): Promise<boolean> {
  const page = owningPage(scope);
  const targets: AutomationScope[] = [scope, page];
  for (const target of targets) {
    for (const selector of config.selectors.modify_query_buttons) {
      const locators = target.locator(selector);
      let count = 0;
      try {
        count = Math.min(await locators.count(), 25);
      } catch {
        continue;
      }

      for (let i = 0; i < count; i += 1) {
        const candidate = locators.nth(i);
        try {
          if (!(await candidate.isVisible({ timeout: 1200 }))) {
            continue;
          }
          await candidate.scrollIntoViewIfNeeded({ timeout: 1200 }).catch(() => undefined);
          await candidate.click({ timeout: 3000 });
          await page.waitForTimeout(500);
          if (await hasExpandedFilterPanelVisible(scope)) {
            return true;
          }
        } catch {
          continue;
        }
      }
    }
  }

  for (const target of targets) {
    const clickedFallback = await target.evaluate(() => {
      const selectors = [
        "app-filters-label app-icon.edit-icon",
        "app-filters-label .edit-icon",
        "app-filters-label coral-icon[icon='edit']",
        ".additional-label-content app-icon.edit-icon",
        ".additional-label-content .edit-icon",
        "app-icon.edit-icon",
        "app-icon.edit-icon[tooltip='Search options']",
        "app-button.edit-filters-button",
        "app-button[tooltip='Search options']",
        "app-button[pi-button-name='FilterIconClick']",
        "app-button.edit-filters-button coral-button[icon='filter']",
        "coral-icon[icon='edit']"
      ];

      const isVisible = (el: Element) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 2 && rect.height > 2;
      };

      for (const selector of selectors) {
        for (const el of [...document.querySelectorAll(selector)]) {
          if (!isVisible(el)) {
            continue;
          }
          const clickable = el.closest("app-button, app-icon, coral-button, button, [role='button'], .edit-icon") ?? el;
          if (clickable instanceof HTMLElement) {
            clickable.click();
            return true;
          }
        }
      }
      return false;
    });
    if (!clickedFallback) {
      continue;
    }
    await page.waitForTimeout(500);
    if (await hasExpandedFilterPanelVisible(scope)) {
      return true;
    }
  }

  return false;
}

async function waitForQueryMode(scope: AutomationScope, config: LsegConfig, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hasVisibleCompanyInput = (await firstVisible(scope, config.selectors.company_input, 700)) !== null;
    const hasVisibleCompanySelector = await hasVisibleCompanyFilter(scope);
    const hasExpandedFilterPanel = await hasExpandedFilterPanelVisible(scope);
    if (isQueryModeReady({ hasVisibleCompanyInput, hasVisibleCompanySelector, hasExpandedFilterPanel })) {
      return true;
    }
    await owningPage(scope).waitForTimeout(250);
  }
  return false;
}

async function hasVisibleCompanyFilter(scope: AutomationScope): Promise<boolean> {
  return scope.evaluate(() => {
    const visible = (el: Element) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 2 && rect.height > 2;
    };

    const selectors = [
      "app-companies-filter emerald-multi-select",
      "app-companies-filter app-multi-select",
      "app-companies-filter .atlas-autosuggest-wrapper"
    ];

    return selectors.some((selector) => [...document.querySelectorAll(selector)].some(visible));
  });
}

async function hasExpandedFilterPanelVisible(scope: AutomationScope): Promise<boolean> {
  return scope.evaluate(() => {
    const visible = (el: Element) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 2 && rect.height > 2;
    };

    return [...document.querySelectorAll(".top-filters-panel.active, coral-panel.filters-view .top-filters-panel.active")].some(visible);
  });
}

export async function applyGlobalFilters(scope: AutomationScope, config: LsegConfig): Promise<FilterResult> {
  await closePopupDialogs(scope);
  const details = await scope.evaluate(
    async ({ contributor, country, industry }) => {
      const setContributor = async (name: string) => {
        const el = document.querySelector<any>("app-contributors-filter emerald-multi-select");
        if (!el) return { ok: false, reason: "no_contributor_component" };

        const includeButton = document.querySelector<HTMLElement>("app-contributors-filter coral-radio-button");
        includeButton?.click();

        for (const cb of [...document.querySelectorAll<any>("app-contributors-filter coral-checkbox")]) {
          const label = String(cb.textContent ?? "").toLowerCase();
          const checked = cb.hasAttribute("checked") || cb.checked === true || cb.getAttribute("aria-checked") === "true";
          if (label.includes("preferred") && checked) cb.click();
        }

        el.values = [];
        el.value = "";
        el.query = name;
        el.opened = true;
        await new Promise((resolve) => setTimeout(resolve, 700));

        const pool = [...(el._resolvedData ?? []), ...(el._data ?? []), ...(el.data ?? [])];
        const chosen =
          pool.find((item: any) => String(item?.label ?? "").trim().toLowerCase() === name.trim().toLowerCase()) ??
          pool.find((item: any) => String(item?.label ?? "").trim().toLowerCase().includes(name.trim().toLowerCase()));
        if (!chosen?.value) {
          return { ok: false, reason: "contributor_not_found", labels: pool.slice(0, 8).map((item: any) => item?.label ?? "") };
        }

        el.values = [String(chosen.value)];
        el.value = String(chosen.value);
        el.opened = false;
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        el.dispatchEvent(new CustomEvent("confirm", { bubbles: true, composed: true }));
        return { ok: true, selectedLabels: el.selectedLabels ?? [], values: el.values ?? [] };
      };

      const setCountry = () => {
        const el = document.querySelector<any>("app-regions-filter emerald-multi-select");
        if (!el) return { ok: false, reason: "no_regions_component" };
        const walk = (items: any[]): any | null => {
          for (const item of items ?? []) {
            const label = String(item?.label ?? "").toLowerCase();
            if (label.includes("united states of america") || label === "usa" || label === "united states") return item;
            const child = walk(item?.items ?? item?.children ?? []);
            if (child) return child;
          }
          return null;
        };
        const data = [...(el._resolvedData ?? []), ...(el._data ?? []), ...(el.data ?? [])];
        const target = walk(data);
        if (!target?.value) return { ok: false, reason: "usa_not_found" };
        el.values = [String(target.value)];
        el.value = String(target.value);
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        el.dispatchEvent(new CustomEvent("confirm", { bubbles: true, composed: true }));
        return { ok: true, selectedLabels: el.selectedLabels ?? [], values: el.values ?? [], requested: country };
      };

      const clearIndustry = () => {
        const el = document.querySelector<any>("app-industry-filter emerald-multi-select");
        if (!el) return { ok: false, reason: "no_industry_component" };
        if (String(industry).toLowerCase() !== "none" && String(industry).trim() !== "") {
          return { ok: false, reason: "non_empty_industry_not_supported_in_v1", industry };
        }
        el.values = [];
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        el.dispatchEvent(new CustomEvent("confirm", { bubbles: true, composed: true }));
        return { ok: true, selectedLabels: el.selectedLabels ?? [], values: el.values ?? [] };
      };

      const contributorResult = await setContributor(contributor);
      const countryResult = setCountry();
      const industryResult = clearIndustry();
      const preferredStillChecked = [...document.querySelectorAll<any>("coral-checkbox")].filter((cb) => {
        const label = String(cb.textContent ?? "").toLowerCase();
        const checked = cb.hasAttribute("checked") || cb.checked === true || cb.getAttribute("aria-checked") === "true";
        return label.includes("preferred") && checked;
      }).length;

      return { contributorResult, countryResult, industryResult, preferredStillChecked };
    },
    config.filters
  );

  const ok =
    Boolean((details as any).contributorResult?.ok) &&
    Boolean((details as any).countryResult?.ok) &&
    Boolean((details as any).industryResult?.ok) &&
    Number((details as any).preferredStillChecked ?? 0) === 0;

  return { ok, reason: ok ? "global_filters_validated" : "global_filters_failed", details: details as Record<string, unknown> };
}

export async function applyTaskFilters(scope: AutomationScope, config: LsegConfig, task: RequestTask): Promise<TaskFilterResult> {
  await closePopupDialogs(scope);
  const companyDetails = await setCompany(scope, task.company, task.ticker);
  const [okFrom, okTo] = await setCustomDateRange(scope, task.dateFrom, task.dateTo);
  // Keep the company input detached before SEARCH so filter widgets do not
  // steal focus during the following result/download interactions.
  await disconnectCompanyInputLink(scope);
  const page = owningPage(scope);
  const beforeSearchPages = new Set(page.context().pages());
  await clickFirst(scope, config.selectors.apply_buttons);
  await page.waitForTimeout(500);
  const closedBlankTabs = await closeNewBlankPages(page, beforeSearchPages);
  await page.waitForTimeout(2400);
  return { okCompany: Boolean(companyDetails.ok), okFrom, okTo, companyDetails, closedBlankTabs };
}

async function setCompany(scope: AutomationScope, company: string, ticker: string): Promise<Record<string, unknown>> {
  const queries = buildCompanyQueries(company, ticker);
  const attempts: Record<string, unknown>[] = [];
  let uncertainSelection: Record<string, unknown> | null = null;
  for (const query of queries) {
    const result = (await setCompanyByQuery(scope, company, ticker, query)) as Record<string, unknown>;
    attempts.push({ query, ...result });
    if (result.ok && isTrustedCompanySelection(result, company, ticker)) {
      return { ...result, attempts };
    }
    if (result.ok) {
      uncertainSelection = { query, ...result };
    }
  }
  if (uncertainSelection) {
    return {
      ok: false,
      needsHumanReview: true,
      reason: "company_selection_needs_human_review",
      attempts,
      selected: uncertainSelection.selected ?? null,
      selectedLabels: uncertainSelection.selectedLabels ?? [],
      values: uncertainSelection.values ?? [],
      candidates: attempts.flatMap((attempt) => (attempt.candidates as unknown[]) ?? [])
    };
  }
  return { ok: false, reason: "no_company_match", attempts, candidates: attempts.flatMap((attempt) => (attempt.candidates as unknown[]) ?? []) };
}

async function setCompanyByQuery(scope: AutomationScope, company: string, ticker: string, query: string): Promise<Record<string, unknown>> {
  const page = owningPage(scope);
  const input = scope.locator("app-companies-filter emerald-multi-select input[placeholder*='Search by company' i]").first();
  const normalizedQuery = normalizeText(query);
  const beforeSignature = await scope.evaluate(() => {
    const el = document.querySelector<any>("app-companies-filter emerald-multi-select");
    if (!el) return "";
    const data = [...(el._resolvedData ?? []), ...(el._data ?? []), ...(el.data ?? [])];
    return data
      .filter((item: any) => item?.value)
      .slice(0, 10)
      .map((item: any) => `${String(item.label ?? "").trim()}::${String(item.value ?? "").trim()}`)
      .join("|");
  });
  try {
    await scope.evaluate(() => {
      const el = document.querySelector<any>("app-companies-filter emerald-multi-select");
      if (!el) return;
      el.values = [];
      el.value = "";
      el.opened = true;
    });
    await input.click({ timeout: 3000 });
    await input.press("Control+A", { timeout: 3000 }).catch(() => undefined);
    await input.press("Backspace", { timeout: 3000 }).catch(() => undefined);
    await input.type(query, { delay: 80, timeout: 5000 });
    await scope.evaluate((typedQuery) => {
      const el = document.querySelector<any>("app-companies-filter emerald-multi-select");
      if (!el) return;
      el.query = typedQuery;
      el.opened = true;
    }, query);
  } catch {
    return { ok: false, reason: "company_input_fill_failed", candidates: [] };
  }

  let pool: Array<{ label: string; value: string }> = [];
  let snapshot: SuggestionSnapshot = {
    filtered: [],
    signature: "",
    componentQuery: "",
    inputValue: ""
  };
  let lastSignature = "";
  let stableCycles = 0;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    snapshot = await scope.evaluate((typedQuery) => {
      const normalized = String(typedQuery ?? "").trim().toLowerCase();
      const el = document.querySelector<any>("app-companies-filter emerald-multi-select");
      if (!el) {
        return { filtered: [], signature: "", componentQuery: "", inputValue: "" };
      }
      const data = [...(el._resolvedData ?? []), ...(el._data ?? []), ...(el.data ?? [])];
      const filtered = data
        .filter((item: any) => item?.value)
        .map((item: any) => ({ label: String(item.label ?? ""), value: String(item.value ?? "") }))
        .filter((item: { label: string; value: string }) => {
          if (!normalized) {
            return true;
          }
          const label = item.label.toLowerCase();
          const value = item.value.toLowerCase();
          return label.includes(normalized) || value.includes(normalized);
        });
      const signature = filtered
        .slice(0, 10)
        .map((item: { label: string; value: string }) => `${item.label.trim()}::${item.value.trim()}`)
        .join("|");
      const inputEl = document.querySelector("app-companies-filter emerald-multi-select input[placeholder*='Search by company' i]") as
        | HTMLInputElement
        | null;
      return {
        filtered,
        signature,
        componentQuery: String(el.query ?? ""),
        inputValue: String(inputEl?.value ?? "")
      };
    }, query);

    pool = snapshot.filtered;
    if (snapshot.signature && snapshot.signature === lastSignature) {
      stableCycles += 1;
    } else if (snapshot.signature) {
      stableCycles = 1;
      lastSignature = snapshot.signature;
    } else {
      stableCycles = 0;
    }

    if (isSuggestionSnapshotReady(snapshot, normalizedQuery, beforeSignature, stableCycles)) {
      break;
    }
    await page.waitForTimeout(250);
  }

  const rankedCandidates = pool
    .map((item) => chooseCompanyCandidate([item], company, ticker))
    .filter((item): item is CompanyCandidate => item !== null)
    .sort((a, b) => b.score - a.score);
  const selected = rankedCandidates[0] ?? null;

  if (!selected) {
    return { ok: false, reason: "no_dropdown_match", candidates: pool.slice(0, 10) };
  }

  return (await applyCompanyValueWithVerification(scope, selected.value, selected.label).then((state) => ({
    ...state,
    selected,
    candidates: rankedCandidates.slice(0, 10)
  }))) as Record<string, unknown>;
}

export function isSuggestionSnapshotReady(
  snapshot: SuggestionSnapshot,
  normalizedQuery: string,
  beforeSignature: string,
  stableCycles: number
): boolean {
  if (snapshot.filtered.length === 0 || stableCycles < 2) {
    return false;
  }
  const querySeen =
    normalizeText(snapshot.componentQuery).includes(normalizedQuery) || normalizeText(snapshot.inputValue).includes(normalizedQuery);
  if (!querySeen) {
    return false;
  }
  if (!beforeSignature) {
    return true;
  }
  return snapshot.signature !== beforeSignature;
}

function buildCompanyQueries(company: string, ticker: string): string[] {
  const cleanedCompany = company.replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  const companyTokens = cleanedCompany.split(" ").filter(Boolean);
  const coreTokens = companyTokens.filter((token) => !COMPANY_SUFFIX_WORDS.has(token.toLowerCase()));
  const shortName = coreTokens.join(" ").trim();
  const digitLeadingAlias = coreTokens.find((token) => /^\d+[a-z]/i.test(token)) ?? "";

  return Array.from(
    new Set([ticker, company, cleanedCompany, shortName, digitLeadingAlias].map((value) => value.trim()).filter(Boolean))
  );
}

function companyTokens(company: string): string[] {
  return company
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !COMPANY_SUFFIX_WORDS.has(token));
}

function normalizeText(value: string): string {
  return String(value ?? "").trim().toLowerCase();
}

async function applyCompanyValueWithVerification(
  scope: AutomationScope,
  selectedValue: string,
  selectedLabel: string
): Promise<Record<string, unknown>> {
  const labelNorm = normalizeText(selectedLabel);
  const valueNorm = normalizeText(selectedValue);

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const state = await scope.evaluate(
      async ({ value, label }) => {
        const el = document.querySelector<any>("app-companies-filter emerald-multi-select");
        if (!el) return { ok: false, reason: "no_company_component", selectedLabels: [], values: [], applied: false };

        el.values = [String(value)];
        el.value = String(value);
        el.opened = false;
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        el.dispatchEvent(new CustomEvent("confirm", { bubbles: true, composed: true }));
        await new Promise((resolve) => setTimeout(resolve, 260));

        const values = Array.isArray(el.values) ? el.values.map((x: unknown) => String(x)) : [];
        const selectedLabels = Array.isArray(el.selectedLabels) ? el.selectedLabels.map((x: unknown) => String(x)) : [];
        const hasValue = values.some((item: string) => String(item).trim().toLowerCase() === String(value).trim().toLowerCase());
        const hasLabel = selectedLabels.some((item: string) =>
          String(item).trim().toLowerCase().includes(String(label).trim().toLowerCase())
        );
        const applied = hasValue || hasLabel;
        return {
          ok: applied,
          selectedLabels,
          values,
          applied
        };
      },
      { value: selectedValue, label: selectedLabel }
    );

    const values = ((state.values as string[] | undefined) ?? []).map((item) => normalizeText(item));
    const labels = ((state.selectedLabels as string[] | undefined) ?? []).map((item) => normalizeText(item));
    const hasValue = values.includes(valueNorm);
    const hasLabel = labelNorm ? labels.some((item) => item.includes(labelNorm)) : false;
    if (hasValue || hasLabel) {
      return { ...state, ok: true, applied: true, applyAttempt: attempt };
    }
    await owningPage(scope).waitForTimeout(220);
  }

  return {
    ok: false,
    applied: false,
    reason: "selection_not_materialized",
    selectedLabels: [],
    values: []
  };
}

async function disconnectCompanyInputLink(scope: AutomationScope): Promise<void> {
  try {
    await scope.evaluate(() => {
      const el = document.querySelector<any>("app-companies-filter emerald-multi-select");
      if (el) {
        el.opened = false;
        el.query = "";
      }
      const input = document.querySelector("app-companies-filter emerald-multi-select input[placeholder*='Search by company' i]") as
        | HTMLInputElement
        | null;
      if (input) {
        input.blur();
      }
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body) {
        active.blur();
      }
    });
  } catch {
    // Best-effort UI stabilization step.
  }
}

async function closeNewBlankPages(page: Page, beforeSearchPages: Set<Page>): Promise<number> {
  let closed = 0;
  for (const candidate of page.context().pages()) {
    if (candidate === page || beforeSearchPages.has(candidate)) {
      continue;
    }
    if (!isBlankOrNewTab(candidate.url())) {
      continue;
    }
    try {
      await candidate.close();
      closed += 1;
    } catch {
      continue;
    }
  }
  await page.bringToFront().catch(() => undefined);
  return closed;
}

function isBlankOrNewTab(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return normalized === "" || normalized === "about:blank" || normalized.startsWith("edge://newtab") || normalized.startsWith("chrome://newtab");
}

function isTrustedCompanySelection(selection: Record<string, unknown>, company: string, ticker: string): boolean {
  if (selection.applied !== true) {
    return false;
  }
  const selected = (selection.selected ?? {}) as Record<string, unknown>;
  const selectedLabelRaw =
    String((selected.label as string | undefined) ?? (selection.selectedLabels as string[] | undefined)?.[0] ?? "").trim();
  const selectedValueRaw =
    String((selected.value as string | undefined) ?? (selection.values as string[] | undefined)?.[0] ?? "").trim();

  const selectedLabel = selectedLabelRaw.toLowerCase();
  const selectedValue = selectedValueRaw.toLowerCase();
  const tickerNorm = ticker.trim().toLowerCase();

  const tokens = companyTokens(company);
  const labelSupportsCompany = tokens.some((token) => selectedLabel.includes(token));
  if (labelSupportsCompany) {
    return true;
  }

  if (!tickerNorm) {
    return false;
  }
  const tickerMatch = selectedValue === tickerNorm || selectedValue.startsWith(`${tickerNorm}.`);
  const labelSupportsTicker = selectedLabel.includes(tickerNorm);
  return tickerMatch && labelSupportsTicker;
}

async function setCustomDateRange(scope: AutomationScope, dateFrom: string, dateTo: string): Promise<[boolean, boolean]> {
  const page = owningPage(scope);
  const fromText = formatPickerDate(dateFrom);
  const toText = formatPickerDate(dateTo);

  const opened = await scope.evaluate(() => {
    const root = document.querySelector("app-date-range-filter");
    if (!root) return false;
    (root.querySelector("coral-select") as HTMLElement | null)?.click();
    const custom = [...root.querySelectorAll("coral-item")].find((item) => /custom/i.test((item.textContent ?? "").trim()));
    if (custom instanceof HTMLElement) {
      custom.click();
      return true;
    }
    return false;
  });
  if (!opened) {
    return [false, false];
  }
  await page.waitForTimeout(350);

  const focused = await scope.evaluate(() => {
    const picker = document.querySelector("app-date-range-filter emerald-datetime-picker") as any;
    const input = picker?.shadowRoot?.querySelector("#input") as HTMLElement | null;
    input?.focus();
    return Boolean(input);
  });
  if (!focused) {
    return [false, false];
  }

  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(fromText, { delay: 12 });
  await page.keyboard.press("Tab");
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(toText, { delay: 12 });

  await scope.evaluate(() => {
    const panel = document.querySelector("app-date-range-filter app-date-picker-popup coral-popup-panel.popup-dialog");
    const ok = [...(panel?.querySelectorAll("coral-button") ?? [])].find((button) => (button.textContent ?? "").trim() === "OK");
    if (ok instanceof HTMLElement) ok.click();
  });
  await page.waitForTimeout(400);

  const summary = await scope.evaluate(
    () => (document.querySelector("app-date-range-filter .date-range-filter__date-summary")?.textContent ?? "").trim()
  );
  const ok = summary.includes(fromText) && summary.includes(toText);
  return [ok, ok];
}
