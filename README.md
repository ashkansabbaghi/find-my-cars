# ربات مانیتور طلا و سکه

مانیتور قیمت سکه و طلا (ایران و جهانی، از TGJU) با اطلاع از طریق تلگرام.

## راه‌اندازی

1. وابستگی‌ها را نصب کنید:

```bash
npm install
```

2. فایل `.env` را از روی نمونه بسازید و مقادیر را پر کنید:

```bash
cp .env.example .env
```

| متغیر | توضیح |
|--------|--------|
| `TELEGRAM_BOT_TOKEN` | توکن بات از [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | آیدی چتی که پیام‌ها به آن ارسال می‌شود |
| `TELEGRAM_API_ROOT` | (اختیاری) آدرس reverse proxy برای Bot API وقتی `api.telegram.org` فیلتر است |
| `CRON_SCHEDULE` | زمان‌بندی بررسی (پیش‌فرض: هر ۵ دقیقه) |
| `LOG_LEVEL` | سطح لاگ: `info` / `warn` / `error` |
| `ALERT_THRESHOLD_PERCENT` | حداقل درصد تغییر برای ارسال هشدار قیمت (پیش‌فرض: `0.5`) |
| `DAILY_REPORT_HOUR` | ساعت گزارش روزانه به وقت تهران، ۰ تا ۲۳ (پیش‌فرض: `9`) |

3. اجرا در حالت توسعه:

```bash
npm run dev
```

برای ساخت و اجرای production:

```bash
npm run build
npm start
```

## دسترسی به تلگرام (فیلترینگ)

اگر به `api.telegram.org` وصل نمی‌شوید (`ETIMEDOUT`)، یک reverse proxy لازم است:

1. پوشهٔ `telegram-proxy/` را با Cloudflare Workers دیپلوی کنید:

```bash
cd telegram-proxy
npx wrangler deploy
```

2. URL ورکر را در `.env` بگذارید:

```bash
TELEGRAM_API_ROOT=https://your-worker.workers.dev
```

بدون trailing slash هم درست است (کد خودش `/` اضافه می‌کند). درخواست‌ها به شکل `{TELEGRAM_API_ROOT}/bot{token}/{method}` ارسال می‌شوند.

## اجرا با GitHub Actions

به‌جای cron لوکال می‌توانید مانیتور را با workflow زمان‌بندی‌شده روی GitHub اجرا کنید (`.github/workflows/monitor.yml`).

1. یک Environment به نام `env-find-my-car` بسازید (Settings → Environments) و این Secrets را داخل آن بگذارید:

| Secret | الزامی |
|--------|--------|
| `TELEGRAM_BOT_TOKEN` | بله |
| `TELEGRAM_CHAT_ID` | بله |
| `TELEGRAM_API_ROOT` | خیر — معمولاً روی رانرهای GitHub لازم نیست |

Workflow با `environment: env-find-my-car` به همین Secrets وصل است؛ اگر Environment اسم دیگری دارد، همان را در `.github/workflows/monitor.yml` عوض کنید.

2. Actions را در ریپو فعال کنید؛ workflow هر حدود ۱۰ دقیقه یک بار (و با `workflow_dispatch` دستی) یک cycle با `RUN_ONCE=1` اجرا می‌کند و در صورت تغییر، فایل‌های `data/` را commit می‌کند تا ران بعدی cold-start نشود.

تفاوت با لوکال: `npm run dev` اسکجولر را مدام روی ماشین شما نگه می‌دارد؛ روی Actions هر بار یک اجرا و خروج است و `.env` commit نمی‌شود — فقط Secrets.

## قیمت طلا و سکه (TGJU)

در هر cycle این صفحه‌ها خوانده می‌شوند:

| صفحه | ردیف‌ها |
|------|---------|
| [tgju.org/coin](https://www.tgju.org/coin) | سکه امامی (`sekee`)، نیم سکه (`nim`)، سکه گرمی (`gerami`) |
| [tgju.org/gold-chart](https://www.tgju.org/gold-chart) | طلای ۱۸ عیار هر گرم (`geram18`)، مثقال طلا (`mesghal`) |
| [tgju.org/gold-global](https://www.tgju.org/gold-global) | انس جهانی طلا به دلار (`ons`) |

برای اضافه کردن ردیف دیگر، slug آن (`data-market-row` در HTML صفحه) را به `TRACKED_COINS` در `src/coins.ts` اضافه کنید.

پیام‌های تلگرام (هر پیام همهٔ قیمت‌ها را با هم دارد و در هر cycle حداکثر یک پیام می‌آید):

- **اسنپ‌شات:** در اولین اجرا، هنگام شروع `npm run dev` و در اجرای دستی workflow.
- **گزارش روزانه:** اولین cycle بعد از `DAILY_REPORT_HOUR` به وقت تهران، با تغییر نسبت به گزارش روز قبل.
- **هشدار قیمت:** وقتی یکی از ردیف‌ها حداقل `ALERT_THRESHOLD_PERCENT` درصد نسبت به آخرین گزارش تغییر کند.

وضعیت در `data/coins.json` (قیمت آخرین گزارش) و `data/daily.json` (قیمت گزارش روزانهٔ قبلی) ذخیره می‌شود. این فایل‌ها فقط وقتی پیامی ارسال شود تغییر می‌کنند، پس workflow هم فقط همان موقع commit می‌زند.

## نکات

- فاصلهٔ پیشنهادی بین بررسی‌ها حداقل ۳–۵ دقیقه است تا rate limit سایت TGJU کمتر پیش بیاید.
- استفاده شخصی و مودبانه؛ رعایت شرایط استفادهٔ TGJU بر عهدهٔ شماست.
