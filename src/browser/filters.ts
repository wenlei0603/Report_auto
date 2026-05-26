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

export interface CountryCandidate {
  label: string;
  value: string;
  matchType: string;
}

const COMPANY_SUFFIX_WORDS = new Set(["co", "inc", "corp", "corporation", "ltd", "limited", "plc", "group", "sa", "ag"]);
const CONTRIBUTOR_COMPONENT_SELECTOR =
  "app-contributors-filter emerald-multi-select, app-contributors-filter app-multi-select emerald-multi-select";
const CONTRIBUTOR_INPUT_SELECTOR = `${CONTRIBUTOR_COMPONENT_SELECTOR} input[placeholder*='Contributors' i]`;
const COUNTRY_COMPONENT_SELECTOR = "app-regions-filter emerald-multi-select";

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

export function isContributorSelectionApplied(
  state: { selectedLabels?: string[]; values?: string[] },
  contributor: string
): boolean {
  const requested = normalizeText(contributor);
  if (!requested) {
    return false;
  }
  const labels = (state.selectedLabels ?? []).map((label) => normalizeText(label));
  return labels.some((label) => label === requested || label.includes(requested));
}

export function chooseCountryCandidate(items: Array<{ label?: string; value?: string }>, country: string): CountryCandidate | null {
  const requested = normalizeText(country);
  const aliases =
    requested === "usa" || requested === "united states" || requested === "united states of america"
      ? new Set(["usa", "us", "united states", "united states of america"])
      : new Set([requested]);

  const candidates = items
    .filter((item) => item?.value)
    .map((item) => {
      const label = normalizeText(String(item.label ?? ""));
      const value = normalizeText(String(item.value ?? ""));
      const match = aliases.has(label) || aliases.has(value);
      return {
        label: String(item.label ?? ""),
        value: String(item.value ?? ""),
        score: match ? 100 : 0,
        matchType: match && aliases.has("usa") ? "usa_alias" : match ? "exact_label" : "none"
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
  await throwIfAuthSessionText(scope);
  if (await waitForQueryMode(scope, config, 3500)) {
    return true;
  }
  if (await reopenSearchCriteriaPanel(scope, config)) {
    await owningPage(scope).waitForTimeout(900);
    await closePopupDialogs(scope);
    await throwIfAuthSessionText(scope);
    if (await waitForQueryMode(scope, config, 3500)) {
      return true;
    }
  }
  return false;
}

async function throwIfAuthSessionText(scope: AutomationScope): Promise<void> {
  const text = await scope.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  if (/signed in to another device|session is expired|session expired|sign in|log in/i.test(text)) {
    throw new Error("LSEG session is not authenticated: auth_text. Log in manually, then run again.");
  }
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
  const countryResult = await setCountryRegion(scope, config.filters.country);
  const pageLimitResult = await applyPageLimitFilter(scope, config.filters.max_pages);
  const details = await scope.evaluate(
    ({ industry, contributorResult, countryResult, pageLimitResult }) => {
      const clearContributorPreferred = () => {
        const includeButton = document.querySelector<HTMLElement>("app-contributors-filter coral-radio-button");
        includeButton?.click();

        for (const cb of [...document.querySelectorAll<any>("app-contributors-filter coral-checkbox")]) {
          const label = String(cb.textContent ?? "").toLowerCase();
          const checked = cb.hasAttribute("checked") || cb.checked === true || cb.getAttribute("aria-checked") === "true";
          if (label.includes("preferred") && checked) cb.click();
        }
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
      const industryResult = clearIndustry();
      const preferredStillChecked = [...document.querySelectorAll<any>("coral-checkbox")].filter((cb) => {
        const label = String(cb.textContent ?? "").toLowerCase();
        const checked = cb.hasAttribute("checked") || cb.checked === true || cb.getAttribute("aria-checked") === "true";
        return label.includes("preferred") && checked;
      }).length;

      return { contributorResult, countryResult, industryResult, pageLimitResult, preferredStillChecked };
    },
    { industry: config.filters.industry, contributorResult, countryResult, pageLimitResult }
  );

  const ok =
    Boolean((details as any).contributorResult?.ok) &&
    Boolean((details as any).countryResult?.ok) &&
    Boolean((details as any).industryResult?.ok) &&
    Number((details as any).preferredStillChecked ?? 0) === 0;

  return { ok, reason: ok ? "global_filters_validated" : "global_filters_failed", details: details as Record<string, unknown> };
}

async function setContributor(scope: AutomationScope, contributor: string): Promise<Record<string, unknown>> {
  const page = owningPage(scope);
  const existingSelection = await readContributorSelection(scope);
  if (isContributorSelectionApplied(existingSelection, contributor)) {
    return { ...existingSelection, ok: true, applied: true, reason: "contributor_already_selected" };
  }

  const input = scope.locator(CONTRIBUTOR_INPUT_SELECTOR).first();
  const beforeSignature = await scope.evaluate(() => {
    const el = document.querySelector<any>(
      "app-contributors-filter emerald-multi-select, app-contributors-filter app-multi-select emerald-multi-select"
    );
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
      const el = document.querySelector<any>(
        "app-contributors-filter emerald-multi-select, app-contributors-filter app-multi-select emerald-multi-select"
      );
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
      const el = document.querySelector<any>(
        "app-contributors-filter emerald-multi-select, app-contributors-filter app-multi-select emerald-multi-select"
      );
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
      const el = document.querySelector<any>(
        "app-contributors-filter emerald-multi-select, app-contributors-filter app-multi-select emerald-multi-select"
      );
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
    const currentSelection = await readContributorSelection(scope);
    if (isContributorSelectionApplied(currentSelection, contributor)) {
      return { ...currentSelection, ok: true, applied: true, reason: "contributor_selected_without_fresh_suggestions", snapshot };
    }
    return { ok: false, reason: "contributor_not_found", labels: pool.slice(0, 8).map((item) => item.label), snapshot };
  }

  return applyContributorValueWithVerification(scope, selected.value, selected.label).then((state) => ({
    ...state,
    selected,
    candidates: pool.slice(0, 10)
  }));
}

async function readContributorSelection(scope: AutomationScope): Promise<{ selectedLabels: string[]; values: string[] }> {
  return scope
    .evaluate(() => {
      const el = document.querySelector<any>(
        "app-contributors-filter emerald-multi-select, app-contributors-filter app-multi-select emerald-multi-select"
      );
      if (!el) {
        return { selectedLabels: [], values: [] };
      }
      const selectedLabels = Array.isArray(el.selectedLabels) ? el.selectedLabels.map((value: unknown) => String(value)) : [];
      const values = Array.isArray(el.values) ? el.values.map((value: unknown) => String(value)) : [];
      return { selectedLabels, values };
    })
    .catch(() => ({ selectedLabels: [], values: [] }));
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
        const el = document.querySelector<any>(
          "app-contributors-filter emerald-multi-select, app-contributors-filter app-multi-select emerald-multi-select"
        );
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

async function setCountryRegion(scope: AutomationScope, country: string): Promise<Record<string, unknown>> {
  const page = owningPage(scope);
  await scope
    .evaluate(
      ({ selector, query }) => {
        const el = document.querySelector<any>(selector);
        if (!el) {
          return;
        }
        el.opened = true;
        el.query = query;
      },
      { selector: COUNTRY_COMPONENT_SELECTOR, query: country === "USA" ? "United States" : country }
    )
    .catch(() => undefined);

  let pool: Array<{ label: string; value: string }> = [];
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    pool = await scope
      .evaluate((selector) => {
        const el = document.querySelector<any>(selector);
        if (!el) {
          return [];
        }
        const read = (items: any[]): Array<{ label: string; value: string }> => {
          const out: Array<{ label: string; value: string }> = [];
          for (const item of items ?? []) {
            if (item?.value) {
              out.push({ label: String(item.label ?? ""), value: String(item.value ?? "") });
            }
            out.push(...read(item?.items ?? item?.children ?? []));
          }
          return out;
        };
        return read([...(el._resolvedData ?? []), ...(el._data ?? []), ...(el.data ?? [])]);
      }, COUNTRY_COMPONENT_SELECTOR)
      .catch(() => []);

    const selected = chooseCountryCandidate(pool, country);
    if (selected) {
      return applyCountryValueWithVerification(scope, selected.value, selected.label).then((state) => ({
        ...state,
        selected,
        candidates: pool.slice(0, 10),
        requested: country
      }));
    }
    await page.waitForTimeout(250);
  }

  return { ok: false, reason: "country_not_found", labels: pool.slice(0, 8).map((item) => item.label), requested: country };
}

async function applyCountryValueWithVerification(
  scope: AutomationScope,
  selectedValue: string,
  selectedLabel: string
): Promise<Record<string, unknown>> {
  const labelNorm = normalizeText(selectedLabel);
  const valueNorm = normalizeText(selectedValue);

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const state = await scope.evaluate(
      async ({ selector, value, label }) => {
        const el = document.querySelector<any>(selector);
        if (!el) return { ok: false, reason: "no_regions_component", selectedLabels: [], values: [], applied: false };
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
        return { ok: hasValue || hasLabel, selectedLabels, values, applied: hasValue || hasLabel };
      },
      { selector: COUNTRY_COMPONENT_SELECTOR, value: selectedValue, label: selectedLabel }
    );

    const values = ((state.values as string[] | undefined) ?? []).map((item) => normalizeText(item));
    const labels = ((state.selectedLabels as string[] | undefined) ?? []).map((item) => normalizeText(item));
    if (values.includes(valueNorm) || labels.some((item) => item.includes(labelNorm))) {
      return { ...state, ok: true, applied: true, applyAttempt: attempt };
    }
    await owningPage(scope).waitForTimeout(220);
  }

  return { ok: false, applied: false, reason: "country_selection_not_materialized", selectedLabels: [], values: [] };
}

async function applyPageLimitFilter(scope: AutomationScope, maxPages: number): Promise<Record<string, unknown>> {
  return scope
    .evaluate((limit) => {
      const visible = (el: Element) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 2 && rect.height > 2;
      };
      const text = (el: Element) => String(el.textContent ?? "").replace(/\s+/g, " ").trim();
      const dispatch = (el: Element) => {
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        el.dispatchEvent(new CustomEvent("confirm", { bubbles: true, composed: true }));
      };
      const deepElements = (root: ParentNode): Element[] => {
        const out: Element[] = [];
        for (const el of [...root.querySelectorAll("*")]) {
          out.push(el);
          const shadow = (el as HTMLElement).shadowRoot;
          if (shadow) {
            out.push(...deepElements(shadow));
          }
        }
        return out;
      };

      const elements = deepElements(document);
      const host =
        document.querySelector("app-page-count-filter") ??
        elements.find((el) => /^app-.*pages?.*filter$/i.test(el.tagName.toLowerCase())) ??
        elements.find((el) => visible(el) && /pages?|number of pages/i.test(text(el)) && el.querySelector("input, emerald-number-input, coral-input"));
      if (!host) {
        return { ok: true, applied: false, reason: "page_filter_component_not_found_result_review_only", requestedMaxPages: limit };
      }

      const hostElements = [host, ...deepElements(host)];
      const operatorSelect = host.querySelector("coral-select") as HTMLElement & {
        value?: string;
        selectedItem?: HTMLElement;
      } | null;
      const lessOrEqualItem = [...host.querySelectorAll("coral-item")].find((item) => {
        const value = String(item.getAttribute("value") ?? (item as any).value ?? "");
        return value === "LessOrEqual" || text(item) === "<=";
      }) as (HTMLElement & { selected?: boolean; value?: string }) | undefined;
      if (operatorSelect) {
        operatorSelect.click();
        if (lessOrEqualItem) {
          for (const item of [...host.querySelectorAll("coral-item")] as Array<HTMLElement & { selected?: boolean }>) {
            item.removeAttribute("selected");
            item.selected = false;
          }
          lessOrEqualItem.setAttribute("selected", "");
          lessOrEqualItem.selected = true;
          operatorSelect.value = String(lessOrEqualItem.getAttribute("value") ?? lessOrEqualItem.value ?? "LessOrEqual");
          operatorSelect.selectedItem = lessOrEqualItem;
          lessOrEqualItem.click();
        } else {
          operatorSelect.value = "LessOrEqual";
        }
        dispatch(operatorSelect);
      }

      const pageCountField = host.querySelector("coral-text-field") as (HTMLElement & { value?: string }) | null;
      const pageCountShadowInput = pageCountField?.shadowRoot?.querySelector("input[part='input'], input") as HTMLInputElement | null;
      if (pageCountField || pageCountShadowInput) {
        if (pageCountShadowInput) {
          pageCountShadowInput.focus();
          pageCountShadowInput.value = String(limit);
          dispatch(pageCountShadowInput);
          pageCountShadowInput.blur();
        }
        if (pageCountField) {
          pageCountField.value = String(limit);
          pageCountField.setAttribute("value", String(limit));
          dispatch(pageCountField);
        }

        const appliedValue = String(pageCountField?.value ?? pageCountShadowInput?.value ?? "");
        const appliedOperator =
          String(operatorSelect?.value ?? "") ||
          text((operatorSelect?.selectedItem as Element | undefined) ?? lessOrEqualItem ?? host).slice(0, 30);
        return {
          ok: appliedValue === String(limit),
          applied: appliedValue === String(limit),
          requestedMaxPages: limit,
          value: appliedValue,
          operator: appliedOperator,
          hostText: text(host).slice(0, 160)
        };
      }

      const numericInputs = hostElements.filter((el) => {
        const name = [
          el.getAttribute("placeholder"),
          el.getAttribute("aria-label"),
          el.getAttribute("name"),
          el.getAttribute("label"),
          text(el.parentElement ?? el)
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return el instanceof HTMLInputElement && (!name || /page|max|to|less|under|<=|number/.test(name));
      }) as HTMLInputElement[];

      const targetInput = numericInputs[numericInputs.length - 1] ?? null;
      if (!targetInput) {
        return { ok: false, applied: false, reason: "page_filter_input_not_found", requestedMaxPages: limit, hostText: text(host).slice(0, 160) };
      }

      targetInput.focus();
      targetInput.value = String(limit);
      dispatch(targetInput);
      targetInput.blur();

      const fallbackOperatorSelect = hostElements.find((el) => el.tagName.toLowerCase() === "coral-select") as HTMLElement | undefined;
      fallbackOperatorSelect?.click();
      const leItem = deepElements(document).find((el) => {
        const value = text(el).toLowerCase();
        return visible(el) && /less than or equal|less than|at most|<=|≤|max/i.test(value);
      }) as HTMLElement | undefined;
      leItem?.click();

      return { ok: true, applied: true, requestedMaxPages: limit, value: targetInput.value, hostText: text(host).slice(0, 160) };
    }, maxPages)
    .catch((error) => ({ ok: false, applied: false, reason: "page_filter_apply_failed", error: String(error), requestedMaxPages: maxPages }));
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

  const openedSelect = await scope.evaluate(() => {
    const root = document.querySelector("app-date-range-filter");
    const select = root?.querySelector("coral-select") as HTMLElement | null;
    select?.click();
    return Boolean(select);
  });
  if (!openedSelect) {
    return [false, false];
  }
  await page.waitForTimeout(250);

  const opened = await scope.evaluate(async () => {
    const visible = (el: Element) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 2 && rect.height > 2;
    };
    const normalizedText = (el: Element) => String(el.textContent ?? "").replace(/\s+/g, " ").trim();
    const deepElements = (root: ParentNode): Element[] => {
      const out: Element[] = [];
      for (const el of [...root.querySelectorAll("*")]) {
        out.push(el);
        const shadow = (el as HTMLElement).shadowRoot;
        if (shadow) {
          out.push(...deepElements(shadow));
        }
      }
      return out;
    };
    const root = document.querySelector("app-date-range-filter");
    const select = root?.querySelector<any>("coral-select");
    if (select) {
      select.setOpened?.(true);
      select.opened = true;
      select.dispatchEvent(new CustomEvent("opened-changed", { bubbles: true, composed: true, detail: { value: true } }));
      await new Promise((resolve) => setTimeout(resolve, 160));
    }

    const candidates = deepElements(root ?? document).filter((el) => {
      const value = normalizedText(el);
      return /^custom\b/i.test(value) && value.length <= 80;
    });
    const custom =
      candidates.find((el) => visible(el) && el.tagName.toLowerCase() === "coral-item") ??
      candidates.find((el) => el.tagName.toLowerCase() === "coral-item") ??
      candidates.find((el) => ["option", "menuitem"].includes(String(el.getAttribute("role") ?? "").toLowerCase())) ??
      candidates.find((el) => visible(el) && el instanceof HTMLElement) ??
      candidates.find((el) => el instanceof HTMLElement);
    if (custom instanceof HTMLElement) {
      if (select) {
        for (const item of [...select.querySelectorAll("coral-item")] as Array<HTMLElement & { selected?: boolean }>) {
          item.removeAttribute("selected");
          item.selected = false;
        }
        (custom as any).selected = true;
        custom.setAttribute("selected", "");
        select.selectedItem = custom;
        select.value = String((custom as any).value ?? custom.getAttribute("value") ?? "Custom");
      }
      custom.click();
      select?.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      select?.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return true;
    }
    return false;
  });
  if (!opened) {
    return [false, false];
  }
  await page.waitForTimeout(350);

  const filled = await scope.evaluate(
    ({ fromText: fromValue, toText: toValue }) => {
      const deepElements = (root: ParentNode): Element[] => {
        const out: Element[] = [];
        for (const el of [...root.querySelectorAll("*")]) {
          out.push(el);
          const shadow = (el as HTMLElement).shadowRoot;
          if (shadow) {
            out.push(...deepElements(shadow));
          }
        }
        return out;
      };
      const visible = (el: Element) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 2 && rect.height > 2;
      };
      const dispatchValueEvents = (el: Element) => {
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        el.dispatchEvent(new CustomEvent("confirm", { bubbles: true, composed: true }));
      };
      const setValue = (field: Element, value: string) => {
        const input =
          field instanceof HTMLInputElement ? field : ((field as HTMLElement).shadowRoot?.querySelector("input[part='input'], input") as HTMLInputElement | null);
        if (input) {
          input.focus();
          input.value = value;
          dispatchValueEvents(input);
          input.blur();
        }
        if (!(field instanceof HTMLInputElement)) {
          (field as HTMLElement & { value?: string }).value = value;
          field.setAttribute("value", value);
          dispatchValueEvents(field);
        }
      };

      const root = document.querySelector("app-date-range-filter");
      const fields = deepElements(root ?? document).filter(
        (el): el is HTMLElement => el.tagName.toLowerCase() === "coral-text-field" && visible(el)
      );
      const candidates = deepElements(root ?? document).filter(
        (el): el is HTMLInputElement => el instanceof HTMLInputElement && visible(el)
      );
      const fromInput =
        fields.find((field) => field.id === "input") ??
        candidates.find((input) => input.id === "input") ??
        candidates.find((input) => /from|start/i.test(`${input.placeholder} ${input.ariaLabel} ${input.name}`));
      const toInput =
        fields.find((field) => field.id === "input-to") ??
        candidates.find((input) => input.id === "input-to") ??
        candidates.find((input) => /to|end/i.test(`${input.placeholder} ${input.ariaLabel} ${input.name}`)) ??
        candidates.find((input) => input !== fromInput);
      if (!fromInput || !toInput) {
        return { ok: false, inputCount: candidates.length, fieldCount: fields.length };
      }
      setValue(fromInput, fromValue);
      setValue(toInput, toValue);
      const readValue = (field: Element) =>
        field instanceof HTMLInputElement
          ? field.value
          : String((field as HTMLElement & { value?: string }).value ?? (field as HTMLElement).shadowRoot?.querySelector<HTMLInputElement>("input")?.value ?? "");
      return { ok: true, inputCount: candidates.length, fieldCount: fields.length, fromValue: readValue(fromInput), toValue: readValue(toInput) };
    },
    { fromText, toText }
  );
  if (!filled.ok) {
    return [false, false];
  }

  await scope.evaluate(() => {
    const visible = (el: Element) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 2 && rect.height > 2;
    };
    const buttons = [...document.querySelectorAll("app-date-range-filter app-date-picker-popup coral-button, coral-popup-panel.popup-dialog coral-button")];
    const ok = buttons.find((button) => visible(button) && (button.textContent ?? "").trim().toLowerCase() === "ok");
    if (ok instanceof HTMLElement) {
      ok.click();
    }
  });
  await page.waitForTimeout(400);

  const summary = await scope.evaluate(
    () => (document.querySelector("app-date-range-filter .date-range-filter__date-summary")?.textContent ?? "").trim()
  );
  const ok = summary.includes(fromText) && summary.includes(toText);
  return [ok, ok];
}
