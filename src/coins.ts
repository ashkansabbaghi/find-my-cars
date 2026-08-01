import axios, { AxiosError, type AxiosResponse } from "axios";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Logger } from "./logger.js";

const COIN_PAGE_URL = "https://www.tgju.org/coin";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_COINS_PATH = path.join(ROOT_DIR, "data", "coins.json");

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7",
  Referer: "https://www.tgju.org/",
} as const;

/** Cash-market rows on tgju.org/coin (not retail / bubble). */
export const TRACKED_COINS = [
  { slug: "sekee", name: "سکه امامی" },
  { slug: "nim", name: "نیم سکه" },
  { slug: "gerami", name: "سکه گرمی" },
] as const;

export type CoinSlug = (typeof TRACKED_COINS)[number]["slug"];

export interface CoinQuote {
  slug: CoinSlug;
  name: string;
  /** Price as published on TGJU (ریال). */
  price: number;
  url: string;
}

export interface StoredCoin {
  slug: CoinSlug;
  name: string;
  price: number;
  firstSeen: string;
  lastSeen: string;
  lastPrice: number;
}

export type CoinsStore = Partial<Record<CoinSlug, StoredCoin>>;

export type CoinCompareKind = "new" | "price_changed" | "unchanged";

export interface CoinCompareResult {
  kind: CoinCompareKind;
  quote: CoinQuote;
  previous?: StoredCoin;
  priceDelta?: number;
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
  const digits = raw.replace(/[^\d]/g, "");
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

/** Extract cash-market quotes for Emami / half / gram from TGJU HTML. */
export function parseCoinQuotes(html: string): CoinQuote[] {
  const quotes: CoinQuote[] = [];

  for (const coin of TRACKED_COINS) {
    const price = extractRowPrice(html, coin.slug);
    if (price === null) {
      throw new Error(`coin row not found for ${coin.slug} (${coin.name})`);
    }
    quotes.push({
      slug: coin.slug,
      name: coin.name,
      price,
      url: `${COIN_PAGE_URL}#${coin.slug}`,
    });
  }

  return quotes;
}

export async function fetchCoinHtml(): Promise<string> {
  console.info(`[coins] GET ${COIN_PAGE_URL}`);
  const response = await getWithRetry(COIN_PAGE_URL);
  return response.data;
}

export async function scrapeCoinQuotes(log?: Logger): Promise<CoinQuote[]> {
  const html = await fetchCoinHtml();
  const quotes = parseCoinQuotes(html);
  log?.info(
    `coins scraped: ${quotes
      .map((q) => `${q.name}=${q.price.toLocaleString("en-US")}`)
      .join(", ")}`,
  );
  return quotes;
}

export function getDefaultCoinsPath(): string {
  return DEFAULT_COINS_PATH;
}

export async function loadCoins(
  filePath: string = DEFAULT_COINS_PATH,
): Promise<CoinsStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as CoinsStore;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

export async function saveCoins(
  store: CoinsStore,
  filePath: string = DEFAULT_COINS_PATH,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(store, null, 2)}\n`;
  await writeFile(tmpPath, payload, "utf8");
  await rename(tmpPath, filePath);
}

export function isCoinsStoreEmpty(store: CoinsStore): boolean {
  return TRACKED_COINS.every((coin) => store[coin.slug] === undefined);
}

export function compareCoinQuotes(
  quotes: CoinQuote[],
  store: CoinsStore,
): CoinCompareResult[] {
  return quotes.map((quote) => {
    const previous = store[quote.slug];
    if (!previous) {
      return { kind: "new", quote };
    }
    if (previous.lastPrice !== quote.price) {
      return {
        kind: "price_changed",
        quote,
        previous,
        priceDelta: Math.abs(quote.price - previous.lastPrice),
      };
    }
    return { kind: "unchanged", quote, previous };
  });
}

export function applyCoinCompareResults(
  store: CoinsStore,
  results: CoinCompareResult[],
  nowIso: string,
): CoinsStore {
  const next: CoinsStore = { ...store };
  for (const result of results) {
    const { quote } = result;
    const previous = next[quote.slug];
    if (!previous) {
      next[quote.slug] = {
        slug: quote.slug,
        name: quote.name,
        price: quote.price,
        firstSeen: nowIso,
        lastSeen: nowIso,
        lastPrice: quote.price,
      };
      continue;
    }
    next[quote.slug] = {
      ...previous,
      name: quote.name,
      price: quote.price,
      lastSeen: nowIso,
      lastPrice: quote.price,
    };
  }
  return next;
}

/** TGJU publishes coin prices in ریال; convert to تومان for display. */
export function rialToToman(rial: number): number {
  return Math.round(rial / 10);
}

export function formatCoinPriceToman(rial: number): string {
  return `${rialToToman(rial).toLocaleString("en-US")} تومان`;
}

function quoteTomanBySlug(quotes: CoinQuote[]): Record<CoinSlug, number> {
  const bySlug = {} as Record<CoinSlug, number>;
  for (const quote of quotes) {
    bySlug[quote.slug] = rialToToman(quote.price);
  }
  return bySlug;
}

/**
 * ((سکه امامی × ۲) + نیم سکه + (۳ × سکه گرمی)) ÷ ۰٫۰۱
 * Prices are in تومان.
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
  return (emami * 2 + nim + 3 * gerami) / (0.01 + 1);
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

export function formatCoinSnapshotMessage(quotes: CoinQuote[]): string {
  const lines = [
    "🪙 قیمت سکه (TGJU)",
    "",
    ...quotes.flatMap((q, index) => [
      ...(index > 0 ? [""] : []),
      q.name,
      formatCoinPriceToman(q.price),
    ]),
    ...formatFinancialValueSection(quotes),
    "",
    "منبع:",
    COIN_PAGE_URL,
  ];
  return lines.join("\n");
}

export function formatCoinPriceChangeMessage(
  result: CoinCompareResult,
  allQuotes?: CoinQuote[],
): string {
  const previous = result.previous;
  if (!previous) {
    throw new Error("price_changed coin result requires previous quote");
  }
  const oldPrice = previous.lastPrice;
  const newPrice = result.quote.price;
  const delta = Math.abs(newPrice - oldPrice);
  const direction = newPrice < oldPrice ? "کاهش" : "افزایش";

  return [
    "🪙 تغییر قیمت سکه",
    "",
    "نوع:",
    result.quote.name,
    "",
    "قیمت قبلی:",
    formatCoinPriceToman(oldPrice),
    "",
    "قیمت جدید:",
    formatCoinPriceToman(newPrice),
    "",
    "میزان تغییر:",
    `${formatCoinPriceToman(delta)} ${direction}`,
    ...(allQuotes ? formatFinancialValueSection(allQuotes) : []),
    "",
    "منبع:",
    COIN_PAGE_URL,
  ].join("\n");
}
