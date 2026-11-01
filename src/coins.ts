import axios, { AxiosError, type AxiosResponse } from "axios";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Logger } from "./logger.js";

const TGJU_URL = "https://www.tgju.org";
const COIN_PAGE_URL = `${TGJU_URL}/coin`;
const GOLD_PAGE_URL = `${TGJU_URL}/gold-chart`;
const GLOBAL_GOLD_PAGE_URL = `${TGJU_URL}/gold-global`;
const TEHRAN_TZ = "Asia/Tehran";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_COINS_PATH = path.join(ROOT_DIR, "data", "coins.json");
const DEFAULT_DAILY_PATH = path.join(ROOT_DIR, "data", "daily.json");

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7",
  Referer: "https://www.tgju.org/",
} as const;

/** ریال for Iranian markets, US dollars for the global ounce. */
export type PriceUnit = "rial" | "usd";

/** Coin and gold rows tracked on TGJU, in report order (cash market, not retail / bubble). */
export const TRACKED_COINS = [
  { slug: "sekee", name: "سکه امامی", page: COIN_PAGE_URL, unit: "rial" },
  { slug: "nim", name: "نیم سکه", page: COIN_PAGE_URL, unit: "rial" },
  { slug: "gerami", name: "سکه گرمی", page: COIN_PAGE_URL, unit: "rial" },
  { slug: "geram18", name: "طلای ۱۸ عیار (هر گرم)", page: GOLD_PAGE_URL, unit: "rial" },
  { slug: "mesghal", name: "مثقال طلا", page: GOLD_PAGE_URL, unit: "rial" },
  { slug: "ons", name: "انس طلا (جهانی)", page: GLOBAL_GOLD_PAGE_URL, unit: "usd" },
] as const satisfies readonly {
  slug: string;
  name: string;
  page: string;
  unit: PriceUnit;
}[];

export type CoinSlug = (typeof TRACKED_COINS)[number]["slug"];

export interface CoinQuote {
  slug: CoinSlug;
  name: string;
  unit: PriceUnit;
  /** Price as published on TGJU (ریال or USD, see unit). */
  price: number;
}

export interface StoredCoin {
  slug: CoinSlug;
  name: string;
  price: number;
  firstSeen: string;
  /** When lastPrice was recorded. */
  lastSeen: string;
  /** Price at the last report; changes are measured against it. */
  lastPrice: number;
}

export type CoinsStore = Partial<Record<CoinSlug, StoredCoin>>;

export interface DailyReport {
  /** Tehran calendar day (YYYY-MM-DD) the report was sent. */
  date: string;
  /** Prices at that report; the next daily report compares against them. */
  prices: CoinsStore;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) {
    return false;
  }
  const axiosErr = err as AxiosError;
  if (!axiosErr.response) {
    return true;
  }
  const status = axiosErr.response.status;
  return status === 429 || status >= 500;
}

async function getWithRetry(
  url: string,
  attempt = 1,
): Promise<AxiosResponse<string>> {
  try {
    return await axios.get<string>(url, {
      headers: BROWSER_HEADERS,
      responseType: "text",
      timeout: DEFAULT_TIMEOUT_MS,
      validateStatus: (status) => status >= 200 && status < 300,
    });
  } catch (err) {
    if (attempt >= MAX_ATTEMPTS || !isRetryableError(err)) {
      throw err;
    }
    const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    console.warn(
      `[coins] attempt ${attempt}/${MAX_ATTEMPTS} failed` +
        (status !== undefined ? ` (HTTP ${status})` : "") +
        `; retrying in ${delayMs}ms`,
    );
    await sleep(delayMs);
    return getWithRetry(url, attempt + 1);
  }
}

export function parsePriceString(raw: string): number | null {
  // Keep the decimal point: the global ounce is quoted like "3,875.84".
  const digits = raw.replace(/[^\d.]/g, "");
  if (!digits) {
    return null;
  }
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

/**
 * Find data-price for an exact data-market-row slug.
 * TGJU puts HTML (with `>`) inside data-title, so we cannot stop at `>`.
 */
function extractRowPrice(html: string, slug: string): number | null {
  const markers = [
    `data-market-row="${slug}"`,
    `data-market-row='${slug}'`,
  ];

  let rowIndex = -1;
  for (const marker of markers) {
    const idx = html.indexOf(marker);
    if (idx >= 0) {
      rowIndex = idx;
      break;
    }
  }
  if (rowIndex < 0) {
    return null;
  }

  // Prefer price after the row marker (usual TGJU attribute order).
  const after = html.slice(rowIndex, rowIndex + 12_000);
  const afterMatch = after.match(/data-price=["']([^"']+)["']/);
  if (afterMatch?.[1]) {
    return parsePriceString(afterMatch[1]);
  }

  // Fallback: price attribute slightly before the row marker.
  const before = html.slice(Math.max(0, rowIndex - 500), rowIndex);
  const beforeMatch = before.match(/data-price=["']([^"']+)["'](?![\s\S]*data-price=)/);
  if (beforeMatch?.[1]) {
    return parsePriceString(beforeMatch[1]);
  }

  return null;
}

/** Extract quotes for the tracked rows listed on `page`; rows missing from the HTML are skipped. */
export function parseCoinQuotes(html: string, page: string): CoinQuote[] {
  const quotes: CoinQuote[] = [];

  for (const coin of TRACKED_COINS) {
    if (coin.page !== page) {
      continue;
    }
    const price = extractRowPrice(html, coin.slug);
    if (price === null) {
      console.warn(`[coins] row not found for ${coin.slug} (${coin.name}) on ${page}`);
      continue;
    }
    quotes.push({ slug: coin.slug, name: coin.name, unit: coin.unit, price });
  }

  return quotes;
}

export async function fetchPageHtml(url: string): Promise<string> {
  console.info(`[coins] GET ${url}`);
  const response = await getWithRetry(url);
  return response.data;
}

/** Scrape every tracked page; a page that fails is logged and its rows left out. */
export async function scrapeCoinQuotes(log: Logger): Promise<CoinQuote[]> {
  const pages = [...new Set(TRACKED_COINS.map((coin) => coin.page))];
  const quotes: CoinQuote[] = [];

  for (const page of pages) {
    try {
      quotes.push(...parseCoinQuotes(await fetchPageHtml(page), page));
    } catch (err) {
      log.error(`scrape failed for ${page}`, err);
    }
  }

  log.info(
    `coins scraped: ${quotes
      .map((q) => `${q.name}=${q.price.toLocaleString("en-US")}`)
      .join(", ")}`,
  );
  return quotes;
}

export function getDefaultCoinsPath(): string {
  return DEFAULT_COINS_PATH;
}

async function readJsonObject(
  filePath: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tmpPath, payload, "utf8");
  await rename(tmpPath, filePath);
}

export async function loadCoins(
  filePath: string = DEFAULT_COINS_PATH,
): Promise<CoinsStore> {
  return ((await readJsonObject(filePath)) ?? {}) as CoinsStore;
}

export async function saveCoins(
  store: CoinsStore,
  filePath: string = DEFAULT_COINS_PATH,
): Promise<void> {
  await writeJsonAtomic(filePath, store);
}

export async function loadDailyReport(
  filePath: string = DEFAULT_DAILY_PATH,
): Promise<DailyReport | undefined> {
  const parsed = await readJsonObject(filePath);
  if (typeof parsed?.date !== "string" || !parsed.prices || typeof parsed.prices !== "object") {
    return undefined;
  }
  return parsed as unknown as DailyReport;
}

export async function saveDailyReport(
  report: DailyReport,
  filePath: string = DEFAULT_DAILY_PATH,
): Promise<void> {
  await writeJsonAtomic(filePath, report);
}

export function isCoinsStoreEmpty(store: CoinsStore): boolean {
  return TRACKED_COINS.every((coin) => store[coin.slug] === undefined);
}

/** Signed percent change from oldPrice to newPrice. */
export function changePercent(oldPrice: number, newPrice: number): number {
  return ((newPrice - oldPrice) / oldPrice) * 100;
}

/** Quotes that moved at least thresholdPercent from their stored baseline. */
export function findPriceAlerts(
  quotes: CoinQuote[],
  store: CoinsStore,
  thresholdPercent: number,
): CoinQuote[] {
  return quotes.filter((quote) => {
    const previous = store[quote.slug];
    return (
      previous !== undefined &&
      Math.abs(changePercent(previous.lastPrice, quote.price)) >= thresholdPercent
    );
  });
}

/** Record quotes as the new baseline; rows not in `quotes` keep their old one. */
export function rebaseline(
  store: CoinsStore,
  quotes: CoinQuote[],
  nowIso: string,
): CoinsStore {
  const next: CoinsStore = { ...store };
  for (const quote of quotes) {
    next[quote.slug] = {
      slug: quote.slug,
      name: quote.name,
      price: quote.price,
      firstSeen: store[quote.slug]?.firstSeen ?? nowIso,
      lastSeen: nowIso,
      lastPrice: quote.price,
    };
  }
  return next;
}

function tehranParts(now: Date): { date: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TEHRAN_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export function tehranDate(now: Date): string {
  return tehranParts(now).date;
}

/** Due once per Tehran day, on the first cycle at or after reportHour. */
export function isDailyReportDue(
  previous: DailyReport | undefined,
  now: Date,
  reportHour: number,
): boolean {
  const { date, hour } = tehranParts(now);
  return previous?.date !== date && hour >= reportHour;
}

/** TGJU publishes coin prices in ریال; convert to تومان for display. */
export function rialToToman(rial: number): number {
  return Math.round(rial / 10);
}

export function formatCoinPriceToman(rial: number): string {
  return `${rialToToman(rial).toLocaleString("en-US")} تومان`;
}

export function formatQuotePrice(unit: PriceUnit, price: number): string {
  if (unit === "usd") {
    const usd = price.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${usd} دلار`;
  }
  return formatCoinPriceToman(price);
}

function formatChangeLine(unit: PriceUnit, oldPrice: number, newPrice: number): string {
  if (newPrice === oldPrice) {
    return "بدون تغییر";
  }
  const direction = newPrice > oldPrice ? "🔺 افزایش" : "🔻 کاهش";
  const percent = Math.abs(changePercent(oldPrice, newPrice)).toFixed(2);
  return `${direction} ${formatQuotePrice(unit, Math.abs(newPrice - oldPrice))} (${percent}٪)`;
}

function formatTehranDate(at: Date): string {
  return at.toLocaleDateString("fa-IR", { timeZone: TEHRAN_TZ, dateStyle: "long" });
}

function quoteTomanBySlug(quotes: CoinQuote[]): Record<CoinSlug, number> {
  const bySlug = {} as Record<CoinSlug, number>;
  for (const quote of quotes) {
    bySlug[quote.slug] = rialToToman(quote.price);
  }
  return bySlug;
}

/**
 * ((سکه امامی × ۲) + نیم سکه + (۳ × سکه گرمی)) ÷ ۱٫۰۱
 * Prices are in تومان; the result is rounded to whole تومان.
 */
export function computeFinancialValueToman(quotes: CoinQuote[]): number {
  const bySlug = quoteTomanBySlug(quotes);
  const emami = bySlug.sekee;
  const nim = bySlug.nim;
  const gerami = bySlug.gerami;
  if (
    emami === undefined ||
    nim === undefined ||
    gerami === undefined
  ) {
    throw new Error("financial value needs sekee, nim, and gerami quotes");
  }
  return Math.round((emami * 2 + nim + 3 * gerami) / (0.01 + 1));
}

export function formatFinancialValueSection(quotes: CoinQuote[]): string[] {
  const bySlug = quoteTomanBySlug(quotes);
  const emami = bySlug.sekee;
  const nim = bySlug.nim;
  const gerami = bySlug.gerami;
  if (
    emami === undefined ||
    nim === undefined ||
    gerami === undefined
  ) {
    return [];
  }

  const value = computeFinancialValueToman(quotes);
  return [
    "",
    "فرمول ارزش مالی:",
    "((سکه امامی × ۲) + نیم سکه + (۳ × سکه گرمی)) ÷ (۰٫۰۱ + ۱)",
    "",
    `((${emami.toLocaleString("en-US")} × ۲) + ${nim.toLocaleString("en-US")} + (۳ × ${gerami.toLocaleString("en-US")})) ÷ (0.01 + 1)`,
    "",
    "نتیجه:",
    `${value.toLocaleString("en-US")} تومان`,
  ];
}

/** One block per quote; with a baseline, each block also shows the change since then. */
function formatPriceReport(
  header: string[],
  quotes: CoinQuote[],
  baseline?: CoinsStore,
): string {
  const lines = [
    ...header,
    ...quotes.flatMap((q) => {
      const previous = baseline?.[q.slug];
      return [
        "",
        q.name,
        formatQuotePrice(q.unit, q.price),
        ...(previous ? [formatChangeLine(q.unit, previous.lastPrice, q.price)] : []),
      ];
    }),
    ...formatFinancialValueSection(quotes),
    "",
    "منبع:",
    TGJU_URL,
  ];
  return lines.join("\n");
}

export function formatCoinSnapshotMessage(quotes: CoinQuote[]): string {
  return formatPriceReport(["🪙 قیمت طلا و سکه (TGJU)"], quotes);
}

export function formatPriceAlertMessage(
  quotes: CoinQuote[],
  baseline: CoinsStore,
  thresholdPercent: number,
): string {
  return formatPriceReport(
    [
      "🔔 تغییر قیمت طلا و سکه",
      `تغییر ${thresholdPercent}٪ یا بیشتر نسبت به آخرین گزارش`,
    ],
    quotes,
    baseline,
  );
}

export function formatDailyReportMessage(
  quotes: CoinQuote[],
  previous: DailyReport | undefined,
  now: Date,
): string {
  const header = [`📊 گزارش روزانهٔ طلا و سکه — ${formatTehranDate(now)}`];
  if (previous) {
    const previousAt = new Date(`${previous.date}T12:00:00Z`);
    header.push(`مقایسه با گزارش ${formatTehranDate(previousAt)}`);
  }
  return formatPriceReport(header, quotes, previous?.prices);
}
