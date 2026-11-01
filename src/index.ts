import "dotenv/config";

import type { ScheduledTask } from "node-cron";
import type { Telegraf } from "telegraf";

import {
  findPriceAlerts,
  formatCoinSnapshotMessage,
  formatDailyReportMessage,
  formatPriceAlertMessage,
  isCoinsStoreEmpty,
  isDailyReportDue,
  loadCoins,
  loadDailyReport,
  rebaseline,
  saveCoins,
  saveDailyReport,
  scrapeCoinQuotes,
  tehranDate,
} from "./coins.js";
import { createLogger, type Logger } from "./logger.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import {
  createTelegramBot,
  createTelegramLogger,
  normalizeTelegramApiRoot,
  sendTelegramMessage,
  verifyTelegram,
} from "./telegram.js";
import type { AppConfig, LogLevel } from "./types.js";

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

  const alertThresholdPercent = Number(
    process.env.ALERT_THRESHOLD_PERCENT?.trim() || 0.5,
  );
  if (!Number.isFinite(alertThresholdPercent) || alertThresholdPercent < 0) {
    throw new Error("ALERT_THRESHOLD_PERCENT must be a non-negative number");
  }

  const dailyReportHour = Number(process.env.DAILY_REPORT_HOUR?.trim() || 9);
  if (!Number.isInteger(dailyReportHour) || dailyReportHour < 0 || dailyReportHour > 23) {
    throw new Error("DAILY_REPORT_HOUR must be an integer between 0 and 23");
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
    alertThresholdPercent,
    dailyReportHour,
  };
}

export interface RunCycleOptions {
  /** Always send a price snapshot (local startup, manual GitHub run). */
  forceCoinSnapshot?: boolean;
}

export async function runCycle(
  config: AppConfig,
  bot: Telegraf,
  log: Logger = createLogger("index", config.logLevel),
  options: RunCycleOptions = {},
): Promise<void> {
  log.info("cycle start");

  const tgLog = createTelegramLogger(config.logLevel);
  const now = new Date();
  const nowIso = now.toISOString();

  const quotes = await scrapeCoinQuotes(log);
  if (quotes.length === 0) {
    log.error("no prices scraped; skipping cycle");
    return;
  }

  /** Returns false when Telegram fails, so the report is retried next cycle. */
  const send = async (kind: string, text: string): Promise<boolean> => {
    try {
      await sendTelegramMessage(bot, config.telegramChatId, text, tgLog);
      log.info(`sent ${kind}`);
      return true;
    } catch (err) {
      log.error(`telegram ${kind} failed`, err);
      return false;
    }
  };

  const store = await loadCoins();
  const daily = await loadDailyReport();

  // Every report lists all current prices, so at most one goes out per cycle.
  let reported = false;
  if (isDailyReportDue(daily, now, config.dailyReportHour)) {
    reported = await send("daily report", formatDailyReportMessage(quotes, daily, now));
    if (reported) {
      await saveDailyReport({
        date: tehranDate(now),
        prices: rebaseline(daily?.prices ?? {}, quotes, nowIso),
      });
    }
  }

  if (!reported && (isCoinsStoreEmpty(store) || options.forceCoinSnapshot)) {
    reported = await send("snapshot", formatCoinSnapshotMessage(quotes));
  }

  if (!reported) {
    const alerts = findPriceAlerts(quotes, store, config.alertThresholdPercent);
    log.info(
      `alerts (>= ${config.alertThresholdPercent}%): ${alerts.map((q) => q.slug).join(", ") || "none"}`,
    );
    if (alerts.length > 0) {
      reported = await send(
        "price alert",
        formatPriceAlertMessage(quotes, store, config.alertThresholdPercent),
      );
    }
  }

  // Without a report the baseline stays put, so small moves add up to an alert;
  // rows seen for the first time are baselined silently.
  const toBaseline = reported
    ? quotes
    : quotes.filter((quote) => store[quote.slug] === undefined);
  if (toBaseline.length > 0) {
    await saveCoins(rebaseline(store, toBaseline, nowIso));
  }

  log.info(`cycle done: quotes=${quotes.length} reported=${reported}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger("index", config.logLevel);
  const tgLog = createTelegramLogger(config.logLevel);
  const bot = createTelegramBot(config.telegramBotToken, {
    apiRoot: config.telegramApiRoot,
  });

  log.info(
    `config: chatId=${config.telegramChatId} apiRoot=${config.telegramApiRoot} cron="${config.cronSchedule}" alertThreshold=${config.alertThresholdPercent}% dailyReportHour=${config.dailyReportHour}`,
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

  const safeRunCycle = async (options: RunCycleOptions = {}): Promise<void> => {
    if (cycleInFlight) {
      log.warn("previous cycle still running; skipping");
      return;
    }
    cycleInFlight = runCycle(config, bot, log, options).finally(() => {
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

  // Long-running / manual GitHub run: send current prices once on startup.
  // Scheduled RUN_ONCE runs only send the daily report or price alerts.
  const forceCoinSnapshot =
    process.env.RUN_ONCE !== "1" ||
    process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  await safeRunCycle({ forceCoinSnapshot });
  if (process.env.RUN_ONCE === "1") {
    log.info("RUN_ONCE set; exiting");
    return;
  }
  task = startScheduler(config.cronSchedule, () => safeRunCycle());
  log.info("monitor is running");
}

main().catch((err) => {
  console.error("[index] fatal:", err);
  process.exit(1);
});
