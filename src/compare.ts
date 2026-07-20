import type {
  CompareResult,
  PostsStore,
  ScrapedPost,
  StoredPost,
} from "./types.js";

export function comparePost(
  scraped: ScrapedPost,
  previous: StoredPost | undefined,
): CompareResult {
  if (!previous) {
    return { kind: "new", scraped };
  }

  const oldPrice = previous.lastPrice;
  const newPrice = scraped.price;
  if (
    typeof oldPrice === "number" &&
    typeof newPrice === "number" &&
    oldPrice !== newPrice
  ) {
    return {
      kind: "price_changed",
      scraped,
      previous,
      priceDelta: Math.abs(newPrice - oldPrice),
    };
  }

  return { kind: "unchanged", scraped, previous };
}

export function comparePosts(
  scrapedPosts: ScrapedPost[],
  store: PostsStore,
): CompareResult[] {
  return scrapedPosts.map((scraped) => comparePost(scraped, store[scraped.id]));
}

/** Merge compare results into a new store snapshot (updates lastSeen / lastPrice). */
export function applyCompareResults(
  store: PostsStore,
  results: CompareResult[],
  nowIso: string = new Date().toISOString(),
): PostsStore {
  const next: PostsStore = { ...store };

  for (const result of results) {
    const scraped = result.scraped;
    if (result.kind === "new" || !result.previous) {
      next[scraped.id] = {
        id: scraped.id,
        title: scraped.title,
        price: scraped.price,
        city: scraped.city,
        url: scraped.url,
        firstSeen: nowIso,
        lastSeen: nowIso,
        lastPrice: scraped.price,
        ...(scraped.filterId !== undefined ? { filterId: scraped.filterId } : {}),
      };
      continue;
    }

    next[scraped.id] = {
      ...result.previous,
      title: scraped.title,
      price: scraped.price,
      city: scraped.city,
      url: scraped.url,
      lastSeen: nowIso,
      lastPrice: scraped.price,
      ...(scraped.filterId !== undefined
        ? { filterId: scraped.filterId }
        : result.previous.filterId !== undefined
          ? { filterId: result.previous.filterId }
          : {}),
    };
  }

  return next;
}

/** Drop posts whose lastSeen is older than pruneDays. */
export function pruneStalePosts(
  store: PostsStore,
  pruneDays: number,
  now: Date = new Date(),
): { store: PostsStore; removedIds: string[] } {
  if (pruneDays <= 0) {
    return { store, removedIds: [] };
  }

  const cutoffMs = now.getTime() - pruneDays * 24 * 60 * 60 * 1000;
  const pruned: PostsStore = {};
  const removedIds: string[] = [];

  for (const [id, post] of Object.entries(store)) {
    const lastSeenMs = Date.parse(post.lastSeen);
    if (Number.isFinite(lastSeenMs) && lastSeenMs >= cutoffMs) {
      pruned[id] = post;
    } else {
      removedIds.push(id);
    }
  }

  return { store: pruned, removedIds };
}
