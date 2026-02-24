# LinkedIn Telegram Scraper Bot (Node.js + Vercel)

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Vercel](https://img.shields.io/badge/Deploy-Vercel-000000?logo=vercel&logoColor=white)](https://vercel.com/)

Production-ready Telegram bot that accepts a LinkedIn post URL and replies in Arabic with:
- extracted post text
- post media (images/videos)
- post documents (PDF when available)

Repository: `https://github.com/moatasem-alhilali/linkedin-scraper-nodejs`
Live deployment: `https://linkedin-scraper-orcin.vercel.app`

## Features

- Node.js 18+ ESM project
- Single Vercel Serverless Function (`/api/telegram.js`)
- Strict LinkedIn URL validation (`https://www.linkedin.com/...`)
- SSRF protection via strict host allow-lists and redirect guard
- Fetch timeout with `AbortController` (12s) + retries (2)
- Scraping fallback strategy:
  - primary DOM selectors for post text/media
  - Open Graph fallback for text/media
- Media handling:
  - single media item => `sendPhoto` / `sendVideo`
  - 2-10 items => `sendMediaGroup`
  - >10 items => ZIP in memory and send as document
  - PDF/doc attachments sent as documents
- Concurrency control with `p-limit` (max 3 downloads)
- Input validation with `zod`
- No filesystem writes (ZIP generated in memory buffer)
- Arabic user-facing messages with clean server-side error logging

## Tech Stack

- Runtime: Node.js 18+
- Module system: ESM
- Deploy target: Vercel Serverless
- HTTP client: native `fetch`
- HTML parsing: `cheerio`
- ZIP creation: `archiver`
- Validation: `zod`
- Concurrency limiter: `p-limit`

## Project Structure

```text
linkedin-scraper-nodejs/
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

## Prerequisites

- Node.js 18+
- Telegram bot token from BotFather
- Vercel account (for deployment)

## Environment Variables

Set these in Vercel (`Project Settings -> Environment Variables`):

- `TELEGRAM_BOT_TOKEN` (required)
- `ENABLE_HEADLESS` (optional, default `false`, reserved for future headless mode)

## Quick Start

1. Clone:
```bash
git clone https://github.com/moatasem-alhilali/linkedin-scraper-nodejs.git
cd linkedin-scraper-nodejs
```

2. Install dependencies:
```bash
npm install
```

3. Run locally:
```bash
npm run dev
```

4. Local webhook test:
```bash
curl -X POST "http://localhost:3000/api/telegram" \
  -H "Content-Type: application/json" \
  -d '{
    "update_id": 100001,
    "message": {
      "chat": { "id": 123456789 },
      "text": "https://www.linkedin.com/posts/example-post"
    }
  }'
```

## Deploy to Vercel

1. Push repository to GitHub.
2. Import the repo in Vercel.
3. Add `TELEGRAM_BOT_TOKEN` in Production environment variables.
4. Deploy:
```bash
npx vercel --prod
```

## Configure Telegram Webhook

After deployment:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://YOUR_DOMAIN/api/telegram"
```

Verify:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

Expected:
- `result.url` points to `https://YOUR_DOMAIN/api/telegram`
- no recent `last_error_message`

## API Behavior

Endpoint: `POST /api/telegram`

- Non-POST requests return `405`
- Invalid Telegram payload returns `400`
- Valid Telegram updates always return `200 { "ok": true }` after processing
- If message has no text, request is safely ignored
- If URL is not a valid LinkedIn post URL, bot sends Arabic invalid-link message

## Arabic Bot Responses

- Success:
  - `تم استخراج المنشور بنجاح ✅`
- Invalid URL:
  - `الرابط غير صالح. الرجاء إرسال رابط منشور من لينكدإن.`
- Private/protected post:
  - `قد يكون المنشور خاصًا أو يتطلب تسجيل دخول.`
- Could not extract post content:
  - `لم أستطع استخراج محتوى المنشور. قد يكون خاصًا أو محميًا.`
- Generic processing error:
  - `حدث خطأ أثناء معالجة الرابط. حاول مرة أخرى لاحقًا.`

## Security Notes

- Only `https://www.linkedin.com/...` post URLs are accepted
- Only LinkedIn CDN media hosts (`*.licdn.com`) are allowed for media downloads
- Redirects are manually validated and blocked if host is not allowed
- All untrusted input is validated and sanitized before processing

## Testing Guide (Postman)

Request:
- Method: `POST`
- URL: `https://YOUR_DOMAIN/api/telegram`
- Header: `Content-Type: application/json`
- Body:
```json
{
  "update_id": 100001,
  "message": {
    "chat": { "id": 123456789 },
    "text": "https://www.linkedin.com/posts/example-post"
  }
}
```

Scenarios to test:
- valid public image post
- valid public video post
- valid public post containing PDF/document
- invalid URL
- private/protected post

## Production Checklist

- [x] Node.js 18+ and ESM
- [x] Serverless-ready (`/api/telegram.js`)
- [x] Timeout + retry strategy
- [x] Strict URL and hostname validation
- [x] Concurrency control for media downloads
- [x] In-memory ZIP generation
- [x] Arabic responses + structured error logs

## LinkedIn Scraping Limitations

- LinkedIn markup changes often; selectors may need periodic updates
- Some posts are private/auth-gated and cannot be scraped
- LinkedIn anti-bot protections (e.g. status 999) may block extraction
- Media URLs can expire quickly
- This base version avoids headless browsers by design for simplicity and cost

## Contributing

Issues and pull requests are welcome.

Recommended contribution flow:
1. Fork the repository
2. Create a feature branch
3. Add/adjust tests or reproducible validation steps
4. Open a pull request with clear before/after behavior

## License

No license file is included yet.  
If you want public reuse, add a license file (for example `MIT`) to the repository root.
