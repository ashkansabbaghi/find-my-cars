import "dotenv/config";

import { formatCoinSnapshotMessage, scrapeCoinQuotes } from "./coins.js";
import { createLogger } from "./logger.js";
import {
  createTelegramBot,
  normalizeTelegramApiRoot,
  sendTelegramMessage,
  verifyTelegram,
} from "./telegram.js";

async function main(): Promise<void> {
  const log = createLogger("test-telegram", "info");

  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim() ?? "";
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }
  if (!chatId) {
    throw new Error("TELEGRAM_CHAT_ID is required");
  }

  const quotes = await scrapeCoinQuotes(log);
  const text = ["🧪 تست نوتیفیکیشن", "", formatCoinSnapshotMessage(quotes)].join("\n");

  const apiRoot = normalizeTelegramApiRoot(
    process.env.TELEGRAM_API_ROOT?.trim() || "https://api.telegram.org",
  );
  log.info(`apiRoot=${apiRoot}`);

  const bot = createTelegramBot(token, { apiRoot });
  await verifyTelegram(bot, chatId, log);
  await sendTelegramMessage(bot, chatId, text, log);
  log.info("test message sent");
}

main().catch((err) => {
  console.error("[test-telegram] fatal:", err);
  process.exit(1);
});
