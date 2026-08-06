# Amigo Project Guide for AI Agents

This file is the first-stop context for AI/code agents working on the Amigo repository. Keep it accurate when architecture, deployment, or state handling changes.

## Repository Map

- Repo root: `/Users/vitaliinoha/Documents/Amigo/amigo`
- Worker app: `amigo-worker/`
- Main Worker entry: `amigo-worker/src/index.ts`
- Feed configuration: `amigo-worker/src/feeds.nano`
- Telegram topic/thread mapping: `amigo-worker/src/topics.nano`
- Cloudflare config: `amigo-worker/wrangler.toml`
- KV initialization helper: `amigo-worker/scripts/prepare-kv-state.mjs`

The outer folder `/Users/vitaliinoha/Documents/Amigo` is not the git repository. Run git commands from `/Users/vitaliinoha/Documents/Amigo/amigo`.

## What This Project Does

Amigo is a TypeScript Cloudflare Worker that:

1. Runs hourly from a Cloudflare cron trigger.
2. Reads RSS/Atom feeds from `src/feeds.nano`.
3. Compares each feed against the last stored snapshot in Cloudflare KV.
4. Translates non-Ukrainian posts to Ukrainian.
5. Sends new items to Telegram topics based on `src/topics.nano`.
6. Sends an evening weather forecast at local 18:00.
7. Stores per-hour daily run status in KV and exposes it via `/status`.

Production Worker URL:

- `https://amigo-worker.vitalii-e07.workers.dev`

Important endpoints:

- `/status` returns today's KV status JSON. This is safe to call.
- `/run` manually runs the bot and can post real Telegram messages. Do not call it casually.

## Runtime and Deployment

The Worker uses:

- Cloudflare Workers
- Cloudflare KV binding named `amigo`
- Cloudflare Workers AI binding named `AI`
- Telegram Bot API
- `fast-xml-parser`
- Nano Markup config files loaded as text through Wrangler rules

Secrets must be Cloudflare Worker secrets, never source code or `wrangler.toml` values:

```bash
cd /Users/vitaliinoha/Documents/Amigo/amigo/amigo-worker
npx wrangler secret put TELEGRAM_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

Deploy:

```bash
cd /Users/vitaliinoha/Documents/Amigo/amigo/amigo-worker
npm run deploy
```

Validate locally before deploy:

```bash
cd /Users/vitaliinoha/Documents/Amigo/amigo/amigo-worker
npm exec tsc -- --noEmit
npm run deploy -- --dry-run
```

Wrangler may print a local log-file permission warning in sandboxed environments while still completing the bundle/dry run. Look for the upload summary before deciding it failed.

## Feed State Model

KV state is intentionally small and feed-based.

Current keys:

- `snapshot:[feedHash]`: the list of links currently visible in the feed at the previous check.
- `recent:[feedHash]`: a capped list of recently sent links, currently limited to 300, used to avoid duplicates if an RSS feed temporarily removes and re-adds a link.
- `status:YYYY-MM-DD`: today's hourly bot run status, expiring after 3 days.
- `weather_sent:YYYY-MM-DD`: marks weather forecast sent for that local day.
- `run_lock`: short-lived lock that prevents overlapping runs.

Old keys no longer used:

- `feed:*`
- `sent:*`
- `history:*`

Do not reintroduce permanent per-item sent keys unless there is a clear need. The current design avoids an ever-growing history.

## New Item Detection

For each active feed:

1. Fetch and parse the current RSS/Atom feed.
2. Read `snapshot:[feedHash]`.
3. Read `recent:[feedHash]`.
4. A link is new when it is missing from both the previous snapshot and recent sent list.
5. Successfully sent links are prepended to `recent:[feedHash]`.
6. Save the current feed links as the new snapshot.

If a feed has no snapshot, the Worker initializes the snapshot and does not post existing items. This avoids flooding Telegram when adding a feed or resetting KV.

Link validation before posting is currently disabled intentionally to reduce subrequests and increase successful posting throughput.

## Status Tracking

`/status` reads `status:YYYY-MM-DD` for the configured local timezone, default `Europe/Bratislava`.

Each run record is stored by `startedAt`, so multiple runs in the same hour are preserved:

- `status`: `running`, `success`, `partial`, `skipped`, or `error`
- `trigger`: `scheduled` or `manual`
- `startedAt` as the unique per-run key
- processed feed count
- total active feed count
- sent item count
- `sentPostsByFeed`, keyed by feed URL, for that run
- per-feed status and error
- start/finish timestamps

A new local day naturally uses a new status key, so morning status starts fresh. Status keys expire after 3 days.

The top-level daily status also includes `sentItems` and `sentPostsByFeed`, recalculated from all saved hourly runs each time the status key is written.

## Subrequest Limits

`src/utils/tracker.ts` wraps outbound fetches and throws `SUBREQUESTS_LIMIT_EXCEEDED` at a safety threshold. The catch block saves successfully sent progress before stopping.

Main subrequest sources:

- fetching each RSS/Atom feed
- translation calls
- Telegram `sendMessage`
- weather API calls
- link validation if re-enabled

Avoid adding per-item external calls. Batch when possible.

## Telegram Behavior

`src/services/telegram.ts`:

- Builds topic/thread mappings from `src/topics.nano`.
- Sends messages with Telegram `sendMessage`.
- Uses `parse_mode: "HTML"`.
- Batch-translates non-Ukrainian feed item summaries/titles using a separator.
- Falls back from Workers AI translation to Google Translate helper if needed.

Telegram token and chat ID come from `env.TELEGRAM_TOKEN` and `env.TELEGRAM_CHAT_ID`. Never hardcode real values.

## Weather Behavior

Weather runs before feeds at local 18:00. It sends a tomorrow forecast to the weather topic and writes `weather_sent:YYYY-MM-DD`.

Be careful when cleaning KV: deleting `weather_sent:*` can allow another weather message for the same day.

## Feed and Topic Configuration

Feeds use Nano Markup in `amigo-worker/src/feeds.nano`:

```nano
:
    ..
        link https://example.com/rss
        topic news
        language sk
        active true
```

Topics and Telegram thread IDs are configured in `amigo-worker/src/topics.nano`.

When adding or changing feeds, run the KV preparation helper if you want to initialize snapshots without posting existing feed items:

```bash
cd /Users/vitaliinoha/Documents/Amigo/amigo/amigo-worker
node scripts/prepare-kv-state.mjs
npx wrangler kv bulk put .tmp-kv/snapshot-put.json --namespace-id=972c4dcd683e4d5696edddb7d0253423
```

The helper fetches current active feeds and creates `snapshot:*` plus empty `recent:*` values.

## Git Notes

Run git from the repository root:

```bash
cd /Users/vitaliinoha/Documents/Amigo/amigo
```

The Worker package is inside `amigo-worker/`, but it is not a separate repository.

If `git pull` reports divergent branches, inspect first:

```bash
git status
git log --oneline --decorate --graph --all -20
```

Prefer a rebase for local-only commits when history should stay linear:

```bash
git pull --rebase origin main
```

Do not use `git reset --hard` unless the user explicitly asks and understands it will discard local commits/changes.

## Safe Work Checklist

Before changing behavior:

1. Read `amigo-worker/src/index.ts`.
2. Read `amigo-worker/src/services/storage.ts`.
3. Check `amigo-worker/src/feeds.nano` and `amigo-worker/src/topics.nano` if routing/feed behavior matters.
4. Run `npm exec tsc -- --noEmit` from `amigo-worker/`.
5. Use `/status` for observation.
6. Avoid `/run` unless the user explicitly accepts that it may post real Telegram messages.

## Recent Design Decisions

- Switched from old per-item history (`sent:*`) to feed snapshots (`snapshot:*`) plus capped recent sent lists (`recent:*`).
- Added daily run status in KV and `/status`.
- Added a run lock to avoid overlapping scheduled/manual executions.
- Disabled pre-post link validation to reduce subrequests and increase posting throughput.
- Bot token should be managed only with Cloudflare secrets.
