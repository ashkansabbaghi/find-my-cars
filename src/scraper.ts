import axios, { AxiosError, type AxiosResponse } from "axios";

import type { Filter } from "./types.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7",
  Referer: "https://divar.ir/",
} as const;

export function buildSearchUrl(filter: Filter): string {
  const url = new URL(
    `https://divar.ir/s/${encodeURIComponent(filter.city)}/${encodeURIComponent(filter.category)}`,
  );

  if (filter.keywords.length > 0) {
    url.searchParams.set("q", filter.keywords.join(" "));
  }

  if (filter.minPrice !== undefined || filter.maxPrice !== undefined) {
    const min = filter.minPrice ?? "";
    const max = filter.maxPrice ?? "";
    url.searchParams.set("price", `${min}-${max}`);
  }

  return url.toString();
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
    // Network / timeout / DNS
    return true;
  }
  const status = axiosErr.response.status;
  return status === 429 || status >= 500;
}

async function getWithRetry(url: string, attempt = 1): Promise<AxiosResponse<string>> {
  try {
    return await axios.get<string>(url, {
      headers: BROWSER_HEADERS,
      responseType: "text",
      timeout: DEFAULT_TIMEOUT_MS,
      // Follow redirects; axios decompresses gzip/br by default when supported.
      validateStatus: (status) => status >= 200 && status < 300,
    });
  } catch (err) {
    if (attempt >= MAX_ATTEMPTS || !isRetryableError(err)) {
      throw err;
    }
    const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    console.warn(
      `[scraper] attempt ${attempt}/${MAX_ATTEMPTS} failed` +
        (status !== undefined ? ` (HTTP ${status})` : "") +
        `; retrying in ${delayMs}ms`,
    );
    await sleep(delayMs);
    return getWithRetry(url, attempt + 1);
  }
}

/** GET Divar search page HTML (first page only). Does not call api.divar.ir. */
export async function fetchSearchHtml(filter: Filter): Promise<string> {
  const url = buildSearchUrl(filter);
  console.info(`[scraper] GET ${url}`);
  const response = await getWithRetry(url);
  return response.data;
}

/** Polite pause between filter scrapes (1–2s). */
export async function delayBetweenFilters(
  minMs = 1_000,
  maxMs = 2_000,
): Promise<void> {
  const span = Math.max(0, maxMs - minMs);
  const ms = minMs + Math.floor(Math.random() * (span + 1));
  await sleep(ms);
}
