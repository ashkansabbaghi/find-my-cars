import { Telegraf } from "telegraf";

import { createLogger, type Logger } from "./logger.js";
import type { CompareResult, LogLevel, ScrapedPost } from "./types.js";

export function formatPrice(price: number | null): string {
  if (price === null) {
    return "توافقی";
  }
  return `${price.toLocaleString("en-US")} تومان`;
}

export function formatNewPostMessage(post: ScrapedPost): string {
  return [
    "🚗 آگهی جدید دیوار",
    "",
    "عنوان:",
    post.title,
    "",
    "قیمت:",
    formatPrice(post.price),
    "",
    "شهر:",
    post.city || "—",
    "",
    "لینک:",
    post.url,
  ].join("\n");
}

export function formatPriceChangeMessage(result: CompareResult): string {
  const previous = result.previous;
  if (!previous) {
    throw new Error("price_changed result requires previous post");
  }

  const oldPrice = previous.lastPrice;
  const newPrice = result.scraped.price;
  if (typeof oldPrice !== "number" || typeof newPrice !== "number") {
    throw new Error("price_changed result requires numeric prices");
  }

  const delta = Math.abs(newPrice - oldPrice);
  const direction = newPrice < oldPrice ? "کاهش" : "افزایش";

  return [
    "💰 تغییر قیمت دیوار",
    "",
    "عنوان:",
    result.scraped.title,
    "",
    "قیمت قبلی:",
    formatPrice(oldPrice),
    "",
    "قیمت جدید:",
    formatPrice(newPrice),
    "",
    "میزان تغییر:",
    `${formatPrice(delta)} ${direction}`,
    "",
    "شهر:",
    result.scraped.city || previous.city || "—",
    "",
    "لینک:",
    result.scraped.url,
  ].join("\n");
}

export interface TelegramBotOptions {
  /** Bot API base URL. Use a reverse proxy when api.telegram.org is blocked. */
  apiRoot?: string;
}

/** Telegraf joins with `new URL("./bot…", apiRoot)` — path base must end with `/`. */
export function normalizeTelegramApiRoot(apiRoot: string): string {
  const trimmed = apiRoot.trim().replace(/\/+$/, "");
  return `${trimmed || "https://api.telegram.org"}/`;
}

export function createTelegramBot(
  token: string,
  options: TelegramBotOptions = {},
): Telegraf {
  const apiRoot = normalizeTelegramApiRoot(
    options.apiRoot ?? "https://api.telegram.org",
  );
  return new Telegraf(token, {
    telegram: { apiRoot },
  });
}

function telegramErrorDetail(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as {
      response?: { error_code?: number; description?: string };
      message?: string;
    };
    if (e.response?.description) {
      return `code=${e.response.error_code ?? "?"} ${e.response.description}`;
    }
    if (typeof e.message === "string") {
      return e.message;
    }
  }
  return String(err);
}

/** Verify bot token and that the chat is reachable (sends nothing). */
export async function verifyTelegram(
  bot: Telegraf,
  chatId: string,
  log: Logger = createLogger("telegram", "info"),
): Promise<void> {
  log.info("verifying bot token (getMe)...");
  const me = await bot.telegram.getMe();
  log.info(`bot ok: @${me.username ?? "?"} id=${me.id}`);

  log.info(`checking chatId=${chatId} (getChat)...`);
  try {
    const chat = await bot.telegram.getChat(chatId);
    const title =
      "title" in chat && typeof chat.title === "string"
        ? chat.title
        : "username" in chat && typeof chat.username === "string"
          ? `@${chat.username}`
          : "first_name" in chat && typeof chat.first_name === "string"
            ? chat.first_name
            : chat.type;
    log.info(`chat ok: type=${chat.type} ${title}`);
  } catch (err) {
    log.error(
      `chat check failed for chatId=${chatId}: ${telegramErrorDetail(err)}`,
      err,
    );
    throw err;
  }
}

export async function sendTelegramMessage(
  bot: Telegraf,
  chatId: string,
  text: string,
  log: Logger = createLogger("telegram", "info"),
): Promise<void> {
  const preview = text.replace(/\s+/g, " ").slice(0, 80);
  log.info(`sendMessage → chatId=${chatId} chars=${text.length} preview="${preview}"`);
  try {
    const sent = await bot.telegram.sendMessage(chatId, text, {
      link_preview_options: { is_disabled: false },
    });
    log.info(`sendMessage ok message_id=${sent.message_id}`);
  } catch (err) {
    log.error(`sendMessage failed: ${telegramErrorDetail(err)}`, err);
    throw err;
  }
}

export async function notifyCompareResult(
  bot: Telegraf,
  chatId: string,
  result: CompareResult,
  log: Logger = createLogger("telegram", "info"),
): Promise<void> {
  log.info(
    `notify kind=${result.kind} postId=${result.scraped.id} title="${result.scraped.title.slice(0, 60)}"`,
  );
  if (result.kind === "new") {
    await sendTelegramMessage(
      bot,
      chatId,
      formatNewPostMessage(result.scraped),
      log,
    );
    return;
  }
  if (result.kind === "price_changed") {
    await sendTelegramMessage(
      bot,
      chatId,
      formatPriceChangeMessage(result),
      log,
    );
    return;
  }
  log.info(`notify skipped: kind=${result.kind} (not notifiable)`);
}

export function createTelegramLogger(level: LogLevel): Logger {
  return createLogger("telegram", level);
}
