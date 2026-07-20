/**
 * Cloudflare Worker reverse-proxy for Telegram Bot API.
 * Deploy: npx wrangler deploy (from this folder)
 * Then set TELEGRAM_API_ROOT to your worker URL (no trailing slash).
 */
export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = "api.telegram.org";
    url.protocol = "https:";

    const headers = new Headers(request.headers);
    headers.delete("host");

    return fetch(url, {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : request.body,
      redirect: "follow",
    });
  },
};
