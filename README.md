# ربات مانیتور دیوار

مانیتور آگهی‌های دیوار و اطلاع از آگهی جدید یا تغییر قیمت از طریق تلگرام.

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
| `PRUNE_DAYS` | حذف آگهی‌هایی که این تعداد روز دیده نشده‌اند (پیش‌فرض: ۱۴) |

3. فیلترها را در `data/filters.json` تنظیم کنید (نمونهٔ شاهین/تهران از قبل موجود است).

4. اجرا در حالت توسعه:

```bash
npm run dev
```

برای ساخت و اجرای production:

```bash
npm run build
npm start
```

## فیلترها (`data/filters.json`)

هر فیلتر یک آبجکت با این فیلدهاست:

| فیلد | الزامی | توضیح |
|------|--------|--------|
| `id` | بله | شناسه یکتا برای دیباگ |
| `city` | بله | اسلاگ شهر در URL دیوار (مثلاً `tehran`) |
| `category` | بله | **اسلاگ واقعی دسته در URL دیوار** (مثلاً `car`، `light`) — نه نام دلخواه مثل `vehicle` |
| `keywords` | بله | آرایهٔ کلمات؛ همه باید در عنوان آگهی باشند |
| `minPrice` / `maxPrice` | خیر | محدوده قیمت به تومان |

نمونه:

```json
[
  {
    "id": "shahin-tehran",
    "city": "tehran",
    "category": "car",
    "keywords": ["شاهین", "اتومات"],
    "minPrice": 500000000,
    "maxPrice": 1200000000
  }
]
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

1. یک Environment به نام `production` بسازید (Settings → Environments) و این Secrets را داخل آن بگذارید:

| Secret | الزامی |
|--------|--------|
| `TELEGRAM_BOT_TOKEN` | بله |
| `TELEGRAM_CHAT_ID` | بله |
| `TELEGRAM_API_ROOT` | خیر — معمولاً روی رانرهای GitHub لازم نیست |

Workflow با `environment: production` به همین Secrets وصل است؛ اگر Environment اسم دیگری دارد، همان را در `.github/workflows/monitor.yml` عوض کنید.

2. Actions را در ریپو فعال کنید؛ workflow هر حدود ۱۰ دقیقه یک بار (و با `workflow_dispatch` دستی) یک cycle با `RUN_ONCE=1` اجرا می‌کند و در صورت تغییر، `data/posts.json` را commit می‌کند تا ران بعدی cold-start نشود.

تفاوت با لوکال: `npm run dev` اسکجولر را مدام روی ماشین شما نگه می‌دارد؛ روی Actions هر بار یک اجرا و خروج است و `.env` commit نمی‌شود — فقط Secrets.

## نکات

- در اجرای اول (وقتی `data/posts.json` خالی است) فقط وضعیت فعلی ذخیره می‌شود و نوتیف سیل آگهی‌های موجود ارسال نمی‌شود؛ از دور بعد آگهی‌های جدید/تغییر قیمت اطلاع داده می‌شوند.
- فاصلهٔ پیشنهادی بین بررسی‌ها حداقل ۳–۵ دقیقه است تا rate limit دیوار کمتر پیش بیاید.
- استفاده شخصی و مودبانه؛ رعایت شرایط استفادهٔ دیوار بر عهدهٔ شماست.
