import "dotenv/config";

import type { ScheduledTask } from "node-cron";
import type { Telegraf } from "telegraf";

import {
  applyCompareResults,
  comparePosts,
  pruneStalePosts,
} from "./compare.js";
import { applyFilter, loadFilters } from "./filters.js";
import { createLogger, type Logger } from "./logger.js";
import { parsePostsFromHtml } from "./parser.js";
import { delayBetweenFilters, fetchSearchHtml } from "./scraper.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { isStoreEmpty, loadPosts, savePosts } from "./storage.js";
import {
  createTelegramBot,
  createTelegramLogger,
  formatTaskStartedMessage,
  notifyCompareResult,
  normalizeTelegramApiRoot,
  sendTelegramMessage,
  verifyTelegram,
} from "./telegram.js";
import type { AppConfig, LogLevel, ScrapedPost } from "./types.js";

function runSource(): string {
  if (process.env.GITHUB_ACTIONS === "true") {
    return "GitHub Actions";
  }
  if (process.env.RUN_ONCE === "1") {
    return "once";
  }
  return "local";
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return "info";
}

function loadConfig(): AppConfig {
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const telegramChatId = process.env.TELEGRAM_CHAT_ID?.trim() ?? "";
  if (!telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }
  if (!telegramChatId) {
    throw new Error("TELEGRAM_CHAT_ID is required");
  }

  const pruneRaw = process.env.PRUNE_DAYS?.trim();
  const pruneDays = pruneRaw ? Number(pruneRaw) : 14;
  if (!Number.isFinite(pruneDays) || pruneDays < 0) {
    throw new Error("PRUNE_DAYS must be a non-negative number");
  }

  const telegramApiRoot = normalizeTelegramApiRoot(
    process.env.TELEGRAM_API_ROOT?.trim() || "https://api.telegram.org",
  );

  return {
    telegramBotToken,
    telegramChatId,
    telegramApiRoot,
    cronSchedule: process.env.CRON_SCHEDULE?.trim() || "*/5 * * * *",
    logLevel: parseLogLevel(process.env.LOG_LEVEL),
    pruneDays,
  };
}

function dedupeById(posts: ScrapedPost[]): ScrapedPost[] {
  const seen = new Map<string, ScrapedPost>();
  for (const post of posts) {
    if (!seen.has(post.id)) {
      seen.set(post.id, post);
    }
  }
  return [...seen.values()];
}

async function scrapeAllFilters(log: Logger): Promise<ScrapedPost[]> {
  const filters = await loadFilters();
  log.info(`loaded ${filters.length} filter(s)`);

  const collected: ScrapedPost[] = [];

  for (const [index, filter] of filters.entries()) {
    try {
      const html = await fetchSearchHtml(filter);
      const parsed = parsePostsFromHtml(html, filter.id);
      const matched = applyFilter(parsed, filter);
      log.info(
        `filter "${filter.id}": ${parsed.length} scraped, ${matched.length} matched`,
      );
      collected.push(...matched);
    } catch (err) {
      log.error(`filter "${filter.id}" failed`, err);
    }

    if (index < filters.length - 1) {
      await delayBetweenFilters();
    }
  }

  return dedupeById(collected);
}

export async function runCycle(
  config: AppConfig,
  bot: Telegraf,
  log: Logger = createLogger("index", config.logLevel),
): Promise<void> {
  log.info("cycle start");

  const tgLog = createTelegramLogger(config.logLevel);
  try {
    await sendTelegramMessage(
      bot,
      config.telegramChatId,
      formatTaskStartedMessage(runSource()),
      tgLog,
    );
  } catch (err) {
    log.error("telegram task-started notify failed", err);
  }

  const scraped = await scrapeAllFilters(log);
  const store = await loadPosts();
  const storedCount = Object.keys(store).length;
  const coldStart = isStoreEmpty(store);
  log.info(`store loaded: ${storedCount} post(s), coldStart=${coldStart}`);

  const results = comparePosts(scraped, store);
  const nowIso = new Date().toISOString();
  let nextStore = applyCompareResults(store, results, nowIso);

  const newCount = results.filter((r) => r.kind === "new").length;
  const changedCount = results.filter((r) => r.kind === "price_changed").length;
  const unchangedCount = results.filter((r) => r.kind === "unchanged").length;
  const notifiable = results.filter(
    (r) => r.kind === "new" || r.kind === "price_changed",
  );
  log.info(
    `compare: new=${newCount} price_changed=${changedCount} unchanged=${unchangedCount} notifiable=${notifiable.length}`,
  );

  if (coldStart) {
    log.warn(
      `cold start: store was empty — baselining ${scraped.length} post(s); Telegram notifications SKIPPED on purpose (will notify only on later new/price_changed)`,
    );
  } else if (notifiable.length === 0) {
    log.info("no notifiable changes this cycle; nothing to send to Telegram");
  } else {
    log.info(
      `sending ${notifiable.length} Telegram notification(s) to chatId=${config.telegramChatId}`,
    );
    for (const result of notifiable) {
      try {
        await notifyCompareResult(bot, config.telegramChatId, result, tgLog);
        log.info(`notified ${result.kind}: ${result.scraped.id}`);
      } catch (err) {
        log.error(`telegram notify failed for ${result.scraped.id}`, err);
      }
    }
  }

  const pruned = pruneStalePosts(nextStore, config.pruneDays);
  nextStore = pruned.store;
  if (pruned.removedIds.length > 0) {
    log.info(`pruned ${pruned.removedIds.length} stale post(s)`);
  }

  await savePosts(nextStore);
  log.info(
    `cycle done: scraped=${scraped.length} new=${newCount} price_changed=${changedCount} unchanged=${unchangedCount} stored=${Object.keys(nextStore).length}`,
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger("index", config.logLevel);
  const tgLog = createTelegramLogger(config.logLevel);
  const bot = createTelegramBot(config.telegramBotToken, {
    apiRoot: config.telegramApiRoot,
  });

  log.info(
    `config: chatId=${config.telegramChatId} apiRoot=${config.telegramApiRoot} cron="${config.cronSchedule}" pruneDays=${config.pruneDays}`,
  );

  try {
    await verifyTelegram(bot, config.telegramChatId, tgLog);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const networkHint =
      /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|network|FetchError/i.test(detail)
        ? " — api.telegram.org is likely blocked; set TELEGRAM_API_ROOT to a reachable reverse proxy (see README)"
        : " — check TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID";
    log.error(`Telegram verification failed${networkHint}`, err);
    throw err;
  }

  let task: ScheduledTask | undefined;
  let shuttingDown = false;
  let cycleInFlight: Promise<void> | undefined;

  const safeRunCycle = async (): Promise<void> => {
    if (cycleInFlight) {
      log.warn("previous cycle still running; skipping");
      return;
    }
    cycleInFlight = runCycle(config, bot, log).finally(() => {
      cycleInFlight = undefined;
    });
    await cycleInFlight;
  };

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info(`shutting down (${signal})`);
    if (task) {
      await stopScheduler(task);
    }
    if (cycleInFlight) {
      try {
        await cycleInFlight;
      } catch {
        // already logged inside runCycle / scheduler
      }
    }
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await safeRunCycle();
  if (process.env.RUN_ONCE === "1") {
    log.info("RUN_ONCE set; exiting");
    return;
  }
  task = startScheduler(config.cronSchedule, safeRunCycle);
  log.info("monitor is running");
}

main().catch((err) => {
  console.error("[index] fatal:", err);
  process.exit(1);
});
