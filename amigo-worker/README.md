# Amigo Telegram Bot Worker

This is a TypeScript Cloudflare Worker that fetches RSS/Atom feeds, parses them, translates them from Slovak (`sk`) to Ukrainian (`uk`), and posts new items to a Telegram chat.

## Configuration

Feeds are configured in `src/feeds.nano` using Nano Markup:
```nano
:
    ..
        link https://example.com/rss
        topic news
        language sk
        active true
```

## Local Development

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start local server with simulated KV storage:
   ```bash
   npm run dev
   ```
3. Trigger a manual sync check by visiting:
   `http://localhost:8787/run`

## Deployment

1. Set your Telegram secrets on Cloudflare:
   ```bash
   npx wrangler secret put TELEGRAM_TOKEN
   npx wrangler secret put TELEGRAM_CHAT_ID
   ```
2. Create your `amigo` KV namespace and add its ID to `wrangler.toml`:
   ```bash
   npx wrangler kv:namespace create amigo
   ```
3. Deploy the Worker:
   ```bash
   npm run deploy
   ```
