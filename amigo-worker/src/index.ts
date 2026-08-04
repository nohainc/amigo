import feedsNano from "./feeds.nano";
import { parseFeed } from "./services/feed";
import { parseNano } from "./services/nanomarkup";
import { StorageService } from "./services/storage";
import { TelegramService } from "./services/telegram";

export interface Env {
  amigo: KVNamespace;
  TELEGRAM_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  TIMEZONE?: string;
  START_HOUR?: string;
  END_HOUR?: string;
}

export default {
  // 1. Cron Trigger Handler
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runBot(env));
  },

  // 2. HTTP Request Trigger Handler (for manual triggers and testing)
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      try {
        await runBot(env);
        return new Response("Bot run completed successfully", { status: 200 });
      } catch (err: any) {
        return new Response(`Error running bot: ${err.message}`, { status: 500 });
      }
    }
    return new Response("Amigo Telegram Bot Worker is active. Use /run to execute manual feed pull.", { status: 200 });
  },
};

async function runBot(env: Env): Promise<void> {
  const timezone = env.TIMEZONE || "Europe/Bratislava";
  const startHour = parseInt(env.START_HOUR || "9", 10);
  const endHour = parseInt(env.END_HOUR || "21", 10);

  // Validate active hour constraint (Slovakia Timezone)
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  });
  const currentLocalHour = parseInt(formatter.format(new Date()), 10);

  if (currentLocalHour < startHour || currentLocalHour > endHour) {
    console.log(`Skipping bot run. Current hour (${currentLocalHour}) is outside working hours (${startHour}-${endHour}) for timezone ${timezone}.`);
    return;
  }

  console.log(`[${currentLocalHour}:00] Executing feeds check...`);

  if (!env.TELEGRAM_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error("Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID bindings");
  }

  const feedsConfig: any[] = parseNano(feedsNano);
  const storage = new StorageService(env.amigo);
  const telegram = new TelegramService(env.TELEGRAM_TOKEN, env.TELEGRAM_CHAT_ID);

  for (const feed of feedsConfig) {

    if (!feed.active) {
      continue;
    }

    try {
      console.log(`Checking feed: ${feed.link}`);
      const items = await parseFeed(feed.link);

      // Check if feed is newly added/activated.
      // If it has not been registered in storage before, we mark all current items as read/sent 
      // so we don't spam the chat with historical messages.
      const isRegistered = await storage.isFeedActivated(feed.link);
      if (!isRegistered) {
        console.log(`New feed registered: ${feed.link}. Marking existing items as processed.`);
        for (const item of items) {
          if (item.link) {
            await storage.markAsSent(item.link);
          }
        }
        await storage.activateFeed(feed.link);
        continue;
      }

      // Process feed items (find new ones)
      for (const item of items) {
        if (!item.link) {
          continue;
        }

        const alreadySent = await storage.isSent(item.link);
        if (!alreadySent) {
          console.log(`Found new feed item: ${item.title}. Forwarding to Telegram topic "${feed.topic}"`);
          // Stagger sends slightly if there are multiple items
          await telegram.sendItem(feed.topic, item, feed.language);
          await storage.markAsSent(item.link);
          
          // Small sleep to avoid hit limits if we send multiple entries (2 seconds sleep)
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    } catch (error) {
      console.error(`Error processing feed ${feed.link}:`, error);
    }
  }
}
