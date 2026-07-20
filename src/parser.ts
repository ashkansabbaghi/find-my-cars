import type { ScrapedPost } from "./types.js";

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

const NON_NUMERIC_PRICE_MARKERS = [
  "توافقی",
  "توافق",
  "مجانی",
  "رایگان",
  "قیمت اعلام نشده",
];

interface PostRowData {
  token?: string;
  title?: string;
  middle_description_text?: string;
  action?: {
    payload?: {
      token?: string;
      web_info?: {
        city_persian?: string;
        title?: string;
      };
    };
  };
}

interface ListWidget {
  data?: {
    dto?: {
      widget_type?: string;
      data?: PostRowData;
    };
  };
}

interface PreloadedState {
  nb?: {
    listWidgets?: ListWidget[];
  };
}

function toAsciiDigits(input: string): string {
  let out = "";
  for (const ch of input) {
    const p = PERSIAN_DIGITS.indexOf(ch);
    if (p !== -1) {
      out += String(p);
      continue;
    }
    const a = ARABIC_DIGITS.indexOf(ch);
    if (a !== -1) {
      out += String(a);
      continue;
    }
    out += ch;
  }
  return out;
}

/** Normalize Divar price text (e.g. `۸۵۰,۰۰۰,۰۰۰ تومان`) to a number, or null. */
export function parsePrice(text: string | null | undefined): number | null {
  if (!text) {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  if (NON_NUMERIC_PRICE_MARKERS.some((m) => trimmed.includes(m) || lower.includes(m))) {
    return null;
  }

  const ascii = toAsciiDigits(trimmed);
  const digits = ascii.replace(/[^\d]/g, "");
  if (!digits) {
    return null;
  }

  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

export function buildPostUrl(token: string): string {
  return `https://divar.ir/v/${token}`;
}

export function extractPreloadedState(html: string): PreloadedState {
  const marker = "window.__PRELOADED_STATE__";
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error("window.__PRELOADED_STATE__ not found in HTML");
  }

  const eqIndex = html.indexOf("=", markerIndex + marker.length);
  if (eqIndex === -1) {
    throw new Error("malformed __PRELOADED_STATE__ assignment");
  }

  let i = eqIndex + 1;
  while (i < html.length && /\s/.test(html[i]!)) {
    i += 1;
  }
  if (html[i] !== "{") {
    throw new Error("expected JSON object after __PRELOADED_STATE__ =");
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  const start = i;

  for (; i < html.length; i += 1) {
    const ch = html[i]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const jsonText = html.slice(start, i + 1);
        return JSON.parse(jsonText) as PreloadedState;
      }
    }
  }

  throw new Error("unterminated __PRELOADED_STATE__ JSON object");
}

function toScrapedPost(data: PostRowData, filterId?: string): ScrapedPost | null {
  const token = data.token ?? data.action?.payload?.token;
  const title = data.title ?? data.action?.payload?.web_info?.title;
  if (!token || !title) {
    return null;
  }

  const city = data.action?.payload?.web_info?.city_persian ?? "";
  const price = parsePrice(data.middle_description_text);

  return {
    id: token,
    title,
    price,
    city,
    url: buildPostUrl(token),
    ...(filterId !== undefined ? { filterId } : {}),
  };
}

/** Parse first-page POST_ROW widgets from Divar search HTML. */
export function parsePostsFromHtml(html: string, filterId?: string): ScrapedPost[] {
  const state = extractPreloadedState(html);
  const widgets = state.nb?.listWidgets ?? [];
  const posts: ScrapedPost[] = [];

  for (const widget of widgets) {
    const dto = widget.data?.dto;
    if (dto?.widget_type !== "POST_ROW" || !dto.data) {
      continue;
    }
    const post = toScrapedPost(dto.data, filterId);
    if (post) {
      posts.push(post);
    }
  }

  return posts;
}
