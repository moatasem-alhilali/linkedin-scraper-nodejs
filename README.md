# LinkedIn Telegram Bot (Node.js + Vercel)

بوت تيليجرام يستقبل رابط منشور لينكدإن، ثم يرد بالعربية بالنص المستخرج وصور المنشور (كمجموعة صور أو ملف ZIP).

## Project Structure

```text
linkedin-telegram-bot/
  api/
    telegram.js
  lib/
    linkedin.js
    telegram.js
    zip.js
    utils.js
  package.json
  vercel.json
  README.md
```

## Requirements

- Node.js 18+
- Vercel account
- Telegram Bot Token من BotFather

## Environment Variables

في Vercel Project Settings > Environment Variables:

- `TELEGRAM_BOT_TOKEN` = توكن البوت
- `ENABLE_HEADLESS` = `false` (اختياري، محجوز لتوسعة مستقبلية)

## Install

```bash
npm install
```

## Local Development

```bash
npm run dev
```

ثم اختبر endpoint محليًا:

```bash
curl -X POST "http://localhost:3000/api/telegram" \
  -H "Content-Type: application/json" \
  -d '{
    "update_id": 1,
    "message": {
      "chat": { "id": 123456 },
      "text": "https://www.linkedin.com/posts/example-post"
    }
  }'
```

## Deploy to Vercel

1. ارفع المشروع إلى GitHub.
2. أنشئ مشروع جديد في Vercel واربطه بالمستودع.
3. أضف `TELEGRAM_BOT_TOKEN` كمتغير بيئة.
4. انشر المشروع.

## Set Telegram Webhook

بعد النشر:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://YOUR_DOMAIN/api/telegram"
```

مثال:

```bash
curl "https://api.telegram.org/bot123456:ABCDEF/setWebhook?url=https://my-bot.vercel.app/api/telegram"
```

## Arabic Bot Responses

- نجاح:
  - `تم استخراج المنشور بنجاح ✅`
- رابط غير صالح:
  - `الرابط غير صالح. الرجاء إرسال رابط منشور من لينكدإن.`
- منشور خاص:
  - `قد يكون المنشور خاصًا أو يتطلب تسجيل دخول.`
- لا يمكن استخراج النص:
  - `لم أستطع استخراج محتوى المنشور. قد يكون خاصًا أو محميًا.`
- خطأ عام:
  - `حدث خطأ أثناء معالجة الرابط. حاول مرة أخرى لاحقًا.`

## Production Readiness Checklist

- [x] ESM + Node 18+ compatible.
- [x] Single Vercel Serverless function: `/api/telegram.js`.
- [x] Input validation with `zod`.
- [x] Strict LinkedIn URL validation (`https://www.linkedin.com/...` فقط).
- [x] SSRF mitigation with hostname allowlists.
- [x] Redirect guard blocks unknown hosts.
- [x] Request timeout 12s with `AbortController`.
- [x] Retry scraping up to 2 times.
- [x] Concurrency control for image downloads (`p-limit`, max 3).
- [x] ZIP generation fully in memory (`archiver` + Buffer).
- [x] No filesystem writes.
- [x] Telegram media group limit respected (max 10).
- [x] Long text safely trimmed for Telegram.
- [x] Clean Arabic user-facing errors + structured server logs.

## LinkedIn Scraping Limitations

- لينكدإن يغيّر HTML بشكل متكرر؛ selectors قد تحتاج تحديث دوري.
- بعض المنشورات الخاصة أو التي تتطلب تسجيل دخول لن تكون قابلة للاستخراج.
- قد تظهر حماية anti-bot (مثل status 999) وتمنع الاستخراج.
- روابط الصور من لينكدإن قد تنتهي صلاحيتها.
- النسخة الحالية بدون Headless browser عمدًا للحفاظ على الأداء والبساطة؛ يمكن إضافة وضع Headless لاحقًا عبر `ENABLE_HEADLESS`.
