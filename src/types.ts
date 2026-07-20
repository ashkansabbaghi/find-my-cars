export interface Filter {
  id: string;
  city: string;
  category: string;
  keywords: string[];
  minPrice?: number;
  maxPrice?: number;
}

export interface ScrapedPost {
  id: string;
  title: string;
  price: number | null;
  city: string;
  url: string;
  filterId?: string;
}

export interface StoredPost {
  id: string;
  title: string;
  price: number | null;
  city: string;
  url: string;
  firstSeen: string;
  lastSeen: string;
  lastPrice: number | null;
  filterId?: string;
}

export type PostsStore = Record<string, StoredPost>;

export type CompareKind = "new" | "price_changed" | "unchanged";

export interface CompareResult {
  kind: CompareKind;
  scraped: ScrapedPost;
  previous?: StoredPost;
  /** Absolute price difference when kind is price_changed */
  priceDelta?: number;
}

export type LogLevel = "info" | "warn" | "error";

export interface AppConfig {
  telegramBotToken: string;
  telegramChatId: string;
  /** Override Bot API base URL (e.g. Cloudflare Worker proxy). Default: https://api.telegram.org */
  telegramApiRoot: string;
  cronSchedule: string;
  logLevel: LogLevel;
  pruneDays: number;
}
