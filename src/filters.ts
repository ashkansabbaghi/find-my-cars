import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Filter, ScrapedPost } from "./types.js";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FILTERS_PATH = path.join(ROOT_DIR, "data", "filters.json");

export function getDefaultFiltersPath(): string {
  return DEFAULT_FILTERS_PATH;
}

function isFilter(value: unknown): value is Filter {
  if (!value || typeof value !== "object") {
    return false;
  }
  const f = value as Record<string, unknown>;
  return (
    typeof f.id === "string" &&
    typeof f.city === "string" &&
    typeof f.category === "string" &&
    Array.isArray(f.keywords) &&
    f.keywords.every((k) => typeof k === "string") &&
    (f.minPrice === undefined || typeof f.minPrice === "number") &&
    (f.maxPrice === undefined || typeof f.maxPrice === "number")
  );
}

export async function loadFilters(
  filePath: string = DEFAULT_FILTERS_PATH,
): Promise<Filter[]> {
  const raw = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`filters file must be a JSON array: ${filePath}`);
  }

  const filters: Filter[] = [];
  for (const [index, item] of parsed.entries()) {
    if (!isFilter(item)) {
      throw new Error(`invalid filter at index ${index} in ${filePath}`);
    }
    if (!item.category.trim()) {
      throw new Error(`filter "${item.id}" has empty category (use Divar URL slug, e.g. car)`);
    }
    filters.push({
      id: item.id,
      city: item.city,
      category: item.category,
      keywords: item.keywords,
      ...(item.minPrice !== undefined ? { minPrice: item.minPrice } : {}),
      ...(item.maxPrice !== undefined ? { maxPrice: item.maxPrice } : {}),
    });
  }

  return filters;
}

/** All keywords must appear in the title (case-sensitive for Persian). */
export function matchesKeywords(title: string, keywords: string[]): boolean {
  if (keywords.length === 0) {
    return true;
  }
  return keywords.every((keyword) => title.includes(keyword));
}

export function matchesPrice(
  price: number | null,
  minPrice?: number,
  maxPrice?: number,
): boolean {
  if (minPrice === undefined && maxPrice === undefined) {
    return true;
  }
  // Negotiable / unknown prices cannot satisfy a numeric range.
  if (price === null) {
    return false;
  }
  if (minPrice !== undefined && price < minPrice) {
    return false;
  }
  if (maxPrice !== undefined && price > maxPrice) {
    return false;
  }
  return true;
}

export function matchesFilter(post: ScrapedPost, filter: Filter): boolean {
  return (
    matchesKeywords(post.title, filter.keywords) &&
    matchesPrice(post.price, filter.minPrice, filter.maxPrice)
  );
}

export function applyFilter(posts: ScrapedPost[], filter: Filter): ScrapedPost[] {
  return posts
    .filter((post) => matchesFilter(post, filter))
    .map((post) => ({ ...post, filterId: filter.id }));
}
