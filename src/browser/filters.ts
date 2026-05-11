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

export interface ContributorCandidate {
  label: string;
  value: string;
  matchType: string;
}

export interface SearchFilterInitializationState {
  contributorLabels: string[];
  preferredContributorChecked: boolean;
  dateRangeMode: string;
  industryLabels: string[];
  countryLabels: string[];
}

export interface SearchFilterInitializationValidation {
  ok: boolean;
  reasons: string[];
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

export function evaluateSearchFilterInitialization(state: SearchFilterInitializationState): SearchFilterInitializationValidation {
  const reasons: string[] = [];
  const contributors = state.contributorLabels.map(normalizeText).filter(Boolean);
  if (contributors.length !== 1 || contributors[0] !== "morgan stanley") {
    reasons.push("contributor_not_exact_morgan_stanley");
  }
  if (state.preferredContributorChecked) {
    reasons.push("preferred_contributor_checked");
  }
  const dateRangeMode = normalizeText(state.dateRangeMode);
  if (!dateRangeMode.includes("custom") || dateRangeMode.includes("last 90 days")) {
    reasons.push("date_range_not_custom");
  }
  const industryLabels = state.industryLabels.map(normalizeText).filter(Boolean);
  if (industryLabels.length > 0 && !industryLabels.some((label) => label === "any" || label === "none")) {
    reasons.push("industry_not_any");
  }
  const countryLabels = state.countryLabels.map(normalizeText).filter(Boolean);
  const hasUnitedStates = countryLabels.some((label) => label === "usa" || label.includes("united states"));
  if (!hasUnitedStates) {
    reasons.push("country_not_united_states");
  }
  return { ok: reasons.length === 0, reasons };
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

export function chooseContributorCandidate(
  items: Array<{ label?: string; value?: string }>,
  contributor: string
): ContributorCandidate | null {
  const requested = normalizeText(contributor);
  if (!requested) {
    return null;
  }

  const candidates = items
    .filter((item) => item?.value)
    .map((item) => {
      const label = normalizeText(String(item.label ?? ""));
      const exact = label === requested;
      const contains = label.includes(requested);
      return {
        label: String(item.label ?? ""),
        value: String(item.value ?? ""),
        score: exact ? 100 : contains ? 50 : 0,
        matchType: exact ? "exact_label" : contains ? "label_contains" : "none"
      };
    })
    .sort((a, b) => b.score - a.score);

  const selected = candidates.find((candidate) => candidate.score > 0);
  if (!selected) {
    return null;
  }
  return { label: selected.label, value: selected.value, matchType: selected.matchType };
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
        "app-button.edit-filters-button coral-button[icon='filter']",
        "app-button[pi-button-name='FilterIconClick'] coral-button[icon='filter']",
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
  const contributorResult = await setContributor(scope, config.filters.contributor);
  const details = await scope.evaluate(
    ({ country, industry, contributorResult }) => {
      const clearContributorPreferred = () => {
        const includeButton = document.querySelector<HTMLElement>("app-contributors-filter coral-radio-button");
        includeButton?.click();

        for (const cb of [...document.querySelectorAll<any>("app-contributors-filter coral-checkbox")]) {
          const label = String(cb.textContent ?? "").toLowerCase();
          const checked = cb.hasAttribute("checked") || cb.checked === true || cb.getAttribute("aria-checked") === "true";
          if (label.includes("preferred") && checked) cb.click();
        }
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

      clearContributorPreferred();
      const countryResult = setCountry();
      const industryResult = clearIndustry();
      const preferredStillChecked = [...document.querySelectorAll<any>("coral-checkbox")].filter((cb) => {
        const label = String(cb.textContent ?? "").toLowerCase();
        const checked = cb.hasAttribute("checked") || cb.checked === true || cb.getAttribute("aria-checked") === "true";
        return label.includes("preferred") && checked;
      }).length;

      return { contributorResult, countryResult, industryResult, preferredStillChecked };
    },
    { country: config.filters.country, industry: config.filters.industry, contributorResult }
  );

  const ok =
    Boolean((details as any).contributorResult?.ok) &&
    Boolean((details as any).countryResult?.ok) &&
    Boolean((details as any).industryResult?.ok) &&
    Number((details as any).preferredStillChecked ?? 0) === 0;

  return { ok, reason: ok ? "global_filters_validated" : "global_filters_failed", details: details as Record<string, unknown> };
}

export async function initializeSearchFilters(scope: AutomationScope, config: LsegConfig): Promise<FilterResult> {
  await closePopupDialogs(scope);
  const globalResult = await applyGlobalFilters(scope, config);
  if (!globalResult.ok) {
    return globalResult;
  }

  const dateResult = await ensureDateRangeCustomMode(scope);
  const snapshot = await readSearchFilterInitializationState(scope);
  const validation = evaluateSearchFilterInitialization({
    ...snapshot,
    dateRangeMode: snapshot.dateRangeMode
  });
  return {
    ok: validation.ok,
    reason: validation.ok ? "search_filters_initialized" : "search_filter_initialization_failed",
    details: {
      global: globalResult.details,
      date: dateResult,
      snapshot,
      validation
    }
  };
}

async function ensureDateRangeCustomMode(scope: AutomationScope): Promise<{ ok: boolean; mode: string; reason: string }> {
  const before = await selectedDateRangeMode(scope);
  if (normalizeText(before).includes("custom")) {
    return { ok: true, mode: before, reason: "already_custom" };
  }
  const opened = await openCustomDatePicker(scope);
  if (!opened) {
    await forceSelectCustomDateRangeMode(scope);
  }
  const after = await selectedDateRangeMode(scope);
  return {
    ok: normalizeText(after).includes("custom"),
    mode: after,
    reason: opened ? "custom_clicked" : "custom_forced"
  };
}

async function selectedDateRangeMode(scope: AutomationScope): Promise<string> {
  return scope
    .evaluate(
      () =>
        [...document.querySelectorAll("app-date-range-filter coral-select coral-item[selected]")]
          .map((item) => String(item.textContent ?? "").trim())
          .find(Boolean) ?? ""
    )
    .catch(() => "");
}

async function forceSelectCustomDateRangeMode(scope: AutomationScope): Promise<void> {
  await scope.evaluate(() => {
    const select = document.querySelector("app-date-range-filter coral-select") as any;
    if (!select) {
      return;
    }
    const items = [...select.querySelectorAll("coral-item")];
    const custom = items.find((item) => /custom/i.test((item.textContent ?? "").trim())) as any;
    if (!custom) {
      return;
    }
    for (const item of items) {
      item.removeAttribute("selected");
    }
    custom.setAttribute("selected", "");
    select.value = custom.value || "Custom";
    select.selectedIndex = items.indexOf(custom);
    select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    select.dispatchEvent(new CustomEvent("coral-select:change", { bubbles: true, composed: true, detail: { value: select.value } }));
  });
}

export function dateSummaryMatchesRange(summary: string, fromText: string, toText: string): boolean {
  const normalizedSummary = normalizeDateSummaryText(summary);
  return normalizedSummary.includes(normalizeDateSummaryText(fromText)) && normalizedSummary.includes(normalizeDateSummaryText(toText));
}

function normalizeDateSummaryText(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

async function readSearchFilterInitializationState(scope: AutomationScope): Promise<SearchFilterInitializationState> {
  return scope
    .evaluate(() => {
      const selectedLabels = (selector: string) => {
        const el = document.querySelector<any>(selector);
        const labels = Array.isArray(el?.selectedLabels) ? el.selectedLabels.map((item: unknown) => String(item)) : [];
        if (labels.length > 0) {
          return labels;
        }
        return String(el?.textContent ?? "")
          .split(/\n|,/)
          .map((item) => item.trim())
          .filter(Boolean);
      };
      const preferredContributorChecked = [...document.querySelectorAll<any>("app-contributors-filter coral-checkbox")].some((cb) => {
        const label = String(cb.textContent ?? "").toLowerCase();
        const checked = cb.hasAttribute("checked") || cb.checked === true || cb.getAttribute("aria-checked") === "true";
        return label.includes("preferred") && checked;
      });
      return {
        contributorLabels: selectedLabels("app-contributors-filter app-multi-select emerald-multi-select"),
        preferredContributorChecked,
        dateRangeMode:
          [...document.querySelectorAll("app-date-range-filter coral-select coral-item[selected]")]
            .map((item) => String(item.textContent ?? "").trim())
            .find(Boolean) ?? String(document.querySelector("app-date-range-filter")?.textContent ?? ""),
        industryLabels: selectedLabels("app-industry-filter emerald-multi-select"),
        countryLabels: selectedLabels("app-regions-filter emerald-multi-select")
      };
    })
    .catch(() => ({
      contributorLabels: [],
      preferredContributorChecked: false,
      dateRangeMode: "",
      industryLabels: [],
      countryLabels: []
    }));
}

async function setContributor(scope: AutomationScope, contributor: string): Promise<Record<string, unknown>> {
  const page = owningPage(scope);
  const input = scope
    .locator("app-contributors-filter app-multi-select emerald-multi-select input[placeholder*='Contributors' i]")
    .first();
  const beforeSignature = await scope.evaluate(() => {
    const el = document.querySelector<any>("app-contributors-filter app-multi-select emerald-multi-select");
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
      const el = document.querySelector<any>("app-contributors-filter app-multi-select emerald-multi-select");
      if (!el) return;
      el.values = [];
      el.value = "";
      el.query = "";
      el.opened = true;
    });
    await input.click({ timeout: 3000 });
    await input.press("Control+A", { timeout: 3000 }).catch(() => undefined);
    await input.press("Backspace", { timeout: 3000 }).catch(() => undefined);
    await input.type(contributor, { delay: 70, timeout: 6000 });
    await scope.evaluate((typedQuery) => {
      const el = document.querySelector<any>("app-contributors-filter app-multi-select emerald-multi-select");
      if (!el) return;
      el.query = typedQuery;
      el.opened = true;
    }, contributor);
  } catch {
    return { ok: false, reason: "contributor_input_fill_failed", candidates: [] };
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
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    snapshot = await scope.evaluate((typedQuery) => {
      const normalized = String(typedQuery ?? "").trim().toLowerCase();
      const el = document.querySelector<any>("app-contributors-filter app-multi-select emerald-multi-select");
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
      const inputEl = el.shadowRoot?.querySelector("input") as HTMLInputElement | null;
      return {
        filtered,
        signature,
        componentQuery: String(el.query ?? ""),
        inputValue: String(inputEl?.value ?? "")
      };
    }, contributor);

    pool = snapshot.filtered;
    if (snapshot.signature && snapshot.signature === lastSignature) {
      stableCycles += 1;
    } else if (snapshot.signature) {
      stableCycles = 1;
      lastSignature = snapshot.signature;
    } else {
      stableCycles = 0;
    }

    if (isContributorSuggestionSnapshotReady(snapshot, contributor, beforeSignature, stableCycles)) {
      break;
    }
    await page.waitForTimeout(250);
  }

  const selected = chooseContributorCandidate(pool, contributor);
  if (!selected) {
    return { ok: false, reason: "contributor_not_found", labels: pool.slice(0, 8).map((item) => item.label), snapshot };
  }

  return applyContributorValueWithVerification(scope, selected.value, selected.label).then((state) => ({
    ...state,
    selected,
    candidates: pool.slice(0, 10)
  }));
}

export function isContributorSuggestionSnapshotReady(
  snapshot: SuggestionSnapshot,
  contributor: string,
  beforeSignature: string,
  stableCycles: number
): boolean {
  if (snapshot.filtered.length === 0 || stableCycles < 2) {
    return false;
  }
  const normalizedQuery = normalizeText(contributor);
  const querySeen =
    normalizeText(snapshot.componentQuery).includes(normalizedQuery) || normalizeText(snapshot.inputValue).includes(normalizedQuery);
  if (!querySeen) {
    return false;
  }
  const hasRequestedContributor = chooseContributorCandidate(snapshot.filtered, contributor) !== null;
  if (!hasRequestedContributor) {
    return false;
  }
  return snapshot.signature !== beforeSignature || hasRequestedContributor;
}

async function applyContributorValueWithVerification(
  scope: AutomationScope,
  selectedValue: string,
  selectedLabel: string
): Promise<Record<string, unknown>> {
  const labelNorm = normalizeText(selectedLabel);
  const valueNorm = normalizeText(selectedValue);

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const state = await scope.evaluate(
      async ({ value, label }) => {
        const el = document.querySelector<any>("app-contributors-filter app-multi-select emerald-multi-select");
        if (!el) return { ok: false, reason: "no_contributor_component", selectedLabels: [], values: [], applied: false };

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
    reason: "contributor_selection_not_materialized",
    selectedLabels: [],
    values: []
  };
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

  const opened = await openCustomDatePicker(scope);
  if (!opened) {
    return [false, false];
  }

  const applied = await scope.evaluate(
    ({ fromText, toText }) => {
    const picker = document.querySelector("app-date-range-filter emerald-datetime-picker") as any;
      if (!picker?.shadowRoot) {
        return false;
      }
      const setField = (selector: string, value: string) => {
        const field = picker.shadowRoot.querySelector(selector) as any;
        const input = field?.shadowRoot?.querySelector("input") as HTMLInputElement | null;
        if (!input) {
          return false;
        }
        input.focus();
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        return true;
      };
      const okFrom = setField("#input", fromText);
      const okTo = setField("#input-to", toText);
      picker.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      picker.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      picker.dispatchEvent(new CustomEvent("confirm", { bubbles: true, composed: true }));
      return okFrom && okTo;
    },
    { fromText, toText }
  );
  if (!applied) {
    return [false, false];
  }

  await scope.evaluate(() => {
    const panel = document.querySelector("app-date-range-filter app-date-picker-popup coral-popup-panel.popup-dialog");
    const ok = [...(panel?.querySelectorAll("coral-button") ?? [])].find((button) => (button.textContent ?? "").trim() === "OK");
    if (ok instanceof HTMLElement) ok.click();
  });
  await page.waitForTimeout(400);

  const summary = await scope.evaluate(
    () => (document.querySelector("app-date-range-filter .date-range-filter__date-summary")?.textContent ?? "").trim()
  );
  const ok = dateSummaryMatchesRange(summary, fromText, toText);
  return [ok, ok];
}

async function openCustomDatePicker(scope: AutomationScope): Promise<boolean> {
  const page = owningPage(scope);
  if (await hasVisibleCustomDatePicker(scope)) {
    return true;
  }
  try {
    await clickDateRangeOption(scope, /Last 90 Days/i, true);
    await page.waitForTimeout(250);
    await clickDateRangeOption(scope, /Custom/i, false);
    await page.waitForTimeout(700);
  } catch {
    return false;
  }

  return hasVisibleCustomDatePicker(scope);
}

async function clickDateRangeOption(scope: AutomationScope, option: RegExp, optional: boolean): Promise<boolean> {
  const page = owningPage(scope);
  try {
    await scope.locator("app-date-range-filter coral-select").first().click({ timeout: 3000 });
    await page.waitForTimeout(250);
    const item = scope.locator("app-date-range-filter coral-item").filter({ hasText: option }).first();
    await item.click({ timeout: 3000 });
    return true;
  } catch {
    const clicked = await clickDateRangeOptionByCoordinates(scope, option);
    if (clicked || optional) {
      return clicked;
    }
    throw new Error(`Date range option not clickable: ${String(option)}`);
  }
}

async function clickDateRangeOptionByCoordinates(scope: AutomationScope, option: RegExp): Promise<boolean> {
  const page = owningPage(scope);
  const selectBox = await scope.locator("app-date-range-filter coral-select").first().boundingBox().catch(() => null);
  if (!selectBox) {
    return false;
  }
  await page.mouse.click(selectBox.x + selectBox.width / 2, selectBox.y + selectBox.height / 2);
  await page.waitForTimeout(250);
  const box = await scope
    .locator("app-date-range-filter coral-item")
    .filter({ hasText: option })
    .first()
    .boundingBox()
    .catch(() => null);
  if (!box) {
    return false;
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return true;
}

async function hasVisibleCustomDatePicker(scope: AutomationScope): Promise<boolean> {
  return scope.evaluate(() => {
    const picker = document.querySelector("app-date-range-filter emerald-datetime-picker");
    if (!picker) {
      return false;
    }
    const rect = picker.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  });
}
