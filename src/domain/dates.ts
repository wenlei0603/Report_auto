const MONTHS = new Map<string, number>([
  ["jan", 1],
  ["feb", 2],
  ["mar", 3],
  ["apr", 4],
  ["may", 5],
  ["jun", 6],
  ["jul", 7],
  ["aug", 8],
  ["sep", 9],
  ["oct", 10],
  ["nov", 11],
  ["dec", 12]
]);

export function parseDateToIso(raw: string): string {
  const value = raw.trim();
  const monthNameMatch = value.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+\d{1,2}:\d{2})?$/);
  if (monthNameMatch) {
    const dayRaw = monthNameMatch[1]!;
    const monthRaw = monthNameMatch[2]!;
    const yearRaw = monthNameMatch[3]!;
    const month = MONTHS.get(monthRaw.toLowerCase());
    if (!month) {
      throw new Error(`Unsupported month in date: ${raw}`);
    }
    return isoFromParts(Number(yearRaw), month, Number(dayRaw));
  }

  const numeric = value.replace(/\./g, "/").replace(/-/g, "/");
  const parts = numeric.split(/[/\s]+/).filter(Boolean);
  if (parts.length >= 3) {
    const aRaw = parts[0]!;
    const bRaw = parts[1]!;
    const cRaw = parts[2]!;
    const a = Number(aRaw);
    const b = Number(bRaw);
    const c = Number(cRaw);
    if (aRaw.length === 4) {
      return isoFromParts(a, b, c);
    }
    if (cRaw.length === 4) {
      const monthFirst = a <= 12 && b > 12;
      return monthFirst ? isoFromParts(c, a, b) : isoFromParts(c, b, a);
    }
  }

  throw new Error(`Unsupported date format: ${raw}`);
}

export function compareIsoDates(a: string, b: string): number {
  return a.localeCompare(b);
}

export function orderIsoDates(a: string, b: string): [string, string] {
  return compareIsoDates(a, b) <= 0 ? [a, b] : [b, a];
}

export function formatPickerDate(isoDate: string): string {
  const [year, month, day] = splitIsoDate(isoDate);
  const monthName = [...MONTHS.entries()].find(([, value]) => value === month)?.[0];
  if (!monthName) {
    throw new Error(`Unsupported ISO date: ${isoDate}`);
  }
  const label = `${monthName.charAt(0).toUpperCase()}${monthName.slice(1)}`;
  return `${String(day).padStart(2, "0")}-${label}-${year} 00:00`;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysIso(isoDate: string, days: number): string {
  const [year, month, day] = splitIsoDate(isoDate);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function differenceInDaysIso(a: string, b: string): number {
  const [aYear, aMonth, aDay] = splitIsoDate(a);
  const [bYear, bMonth, bDay] = splitIsoDate(b);
  const aUtc = Date.UTC(aYear, aMonth - 1, aDay);
  const bUtc = Date.UTC(bYear, bMonth - 1, bDay);
  return Math.round((aUtc - bUtc) / 86_400_000);
}

export function timestampIso(): string {
  return new Date().toISOString();
}

function isoFromParts(year: number, month: number, day: number): string {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error("Date contains non-numeric parts");
  }
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Date parts out of range: ${year}-${month}-${day}`);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Invalid calendar date: ${year}-${month}-${day}`);
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function splitIsoDate(isoDate: string): [number, number, number] {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Unsupported ISO date: ${isoDate}`);
  }
  return [Number(match[1]!), Number(match[2]!), Number(match[3]!)];
}
