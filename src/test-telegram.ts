import "dotenv/config";

import { createLogger } from "./logger.js";
import { loadPosts } from "./storage.js";
import {
  createTelegramBot,
  formatNewPostMessage,
  normalizeTelegramApiRoot,
  sendTelegramMessage,
  verifyTelegram,
} from "./telegram.js";
import type { ScrapedPost, StoredPost } from "./types.js";

function toScraped(post: StoredPost): ScrapedPost {
  return {
    id: post.id,
    title: post.title,
    price: post.price,
    city: post.city,
    url: post.url,
    filterId: post.filterId,
  };
}

function pickLatestPost(posts: StoredPost[]): StoredPost {
  return [...posts].sort((a, b) => {
    const byLastSeen = b.lastSeen.localeCompare(a.lastSeen);
    if (byLastSeen !== 0) {
      return byLastSeen;
    }
    return b.firstSeen.localeCompare(a.firstSeen);
  })[0]!;
}

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

  const store = await loadPosts();
  const posts = Object.values(store);
  if (posts.length === 0) {
    throw new Error("data/posts.json is empty — run the monitor once first");
  }

  const post = pickLatestPost(posts);
  const body = formatNewPostMessage(toScraped(post));
  const text = ["🧪 تست نوتیفیکیشن", "", body].join("\n");

  log.info(
    `resending latest post id=${post.id} lastSeen=${post.lastSeen} title="${post.title.slice(0, 60)}"`,
  );

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
