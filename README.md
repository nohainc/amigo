# Amigo Telegram Bot (Slovakia)

A Telegram RSS bot that aggregates news and events for Slovakia and posts them to a Telegram group/channel.

## Architecture

The bot has been rewritten from Go to TypeScript and runs on **Cloudflare Workers**. It utilizes **Cloudflare KV** for state management (keeping track of sent messages) and parses configuration using the **Nano Markup** format.

See the [amigo-worker/README.md](amigo-worker/README.md) (or [walkthrough documentation](https://amigo-worker.vitalii-e07.workers.dev)) for setup, configuration, and deployment details.
