import feedsNano from "./feeds.nano";
import topicsNano from "./topics.nano";
import { parseFeed, isLinkValid } from "./services/feed";
import { parseNano } from "./services/nanomarkup";
import { StorageService } from "./services/storage";
import { TelegramService } from "./services/telegram";
import { fetchAllCitiesWeather, formatMultiCityWeatherMessage } from "./services/weather";
import { resetSubrequestsCount } from "./utils/tracker";

export interface Env {
  amigo: KVNamespace;
  AI: any;
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
  resetSubrequestsCount();
  console.log(`[${currentLocalHour}:00] Executing amigo bot run...`);

  if (!env.TELEGRAM_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error("Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID bindings");
  }

  const feedsConfig: any[] = parseNano(feedsNano);
  const topicsConfig: any[] = parseNano(topicsNano);
  const storage = new StorageService(env.amigo);
  const telegram = new TelegramService(env.TELEGRAM_TOKEN, env.TELEGRAM_CHAT_ID, topicsConfig, env.AI);

  // 1. Weather check runs FIRST if current local hour is 18:00 (6:00 PM)
  if (currentLocalHour === 18) {
    try {
      const dateFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      const parts = dateFormatter.formatToParts(new Date());
      const year = parts.find((p) => p.type === "year")?.value;
      const month = parts.find((p) => p.type === "month")?.value;
      const day = parts.find((p) => p.type === "day")?.value;
      const todayDateStr = `${year}-${month}-${day}`;

      const weatherSentKey = `weather_sent:${todayDateStr}`;
      const alreadySentWeather = await env.amigo.get(weatherSentKey);

      if (!alreadySentWeather) {
        console.log(`Sending evening weather forecast for tomorrow...`);
        const weatherForecasts = await fetchAllCitiesWeather();
        const weatherMessage = formatMultiCityWeatherMessage(weatherForecasts);

        // Send to weather topic (thread ID 22)
        await telegram.sendRawMessage("weather", weatherMessage);

        // Mark as sent in KV
        await env.amigo.put(weatherSentKey, "sent");
        console.log("Tomorrow's weather forecast successfully posted and logged in KV");
      }
    } catch (weatherErr) {
      console.error("Error executing evening weather forecast:", weatherErr);
    }
  }

  // 2. Feed checks run next. Order is defined in feeds.nano.
  let currentFeedLink = "";
  let currentFeedHistory: string[] = [];
  let historyUpdated = false;

  try {
    for (const feed of feedsConfig) {
      if (!feed.active) {
        continue;
      }

      currentFeedLink = feed.link;
      historyUpdated = false;

      console.log(`Checking feed: ${feed.link}`);
      const items = await parseFeed(feed.link);

      // Check feed history
      let historyList = await storage.getFeedHistory(feed.link);

      if (historyList === null) {
        // Backwards compatibility migration or newly registered feed
        const wasActive = await storage.isFeedActivated(feed.link);
        historyList = items.map(item => item.link).filter(Boolean);
        currentFeedHistory = historyList;
        
        await storage.saveFeedHistory(feed.link, currentFeedHistory);
        if (!wasActive) {
          console.log(`New feed registered: ${feed.link}. Marking existing items as processed in history.`);
          await storage.activateFeed(feed.link);
        }
        continue;
      }

      currentFeedHistory = historyList;
      const historySet = new Set(currentFeedHistory);
      const newItems = [];

      // Find new items
      for (const item of items) {
        if (item.link && !historySet.has(item.link)) {
          newItems.push(item);
        }
      }

      if (newItems.length === 0) {
        continue;
      }

      console.log(`Found ${newItems.length} new items in feed: ${feed.link}`);

      // Filter invalid links (unless Ukrainian)
      const validNewItems = [];
      const isUkrainian = feed.language === "uk";
      
      for (const item of newItems) {
        if (!item.link) continue;
        const isValid = isUkrainian ? true : await isLinkValid(item.link);
        if (isValid) {
          validNewItems.push(item);
        } else {
          console.log(`Skipping invalid/corrupted feed item link: ${item.link}`);
          // Add invalid links to history so we don't check them again
          currentFeedHistory.push(item.link);
          historyUpdated = true;
        }
      }

      if (validNewItems.length === 0) {
        if (historyUpdated) {
          await storage.saveFeedHistory(feed.link, currentFeedHistory);
        }
        continue;
      }

      // Batch translate foreign feeds
      let processedItems = validNewItems;
      if (!isUkrainian) {
        processedItems = await telegram.batchTranslate(validNewItems, feed.language || "sk");
      }

      // Send items to Telegram
      for (const item of processedItems) {
        console.log(`Forwarding feed item: ${item.title} to Telegram topic "${feed.topic}"`);
        await telegram.sendItem(feed.topic, item, feed.language);
        
        // Add to history list on successful send
        currentFeedHistory.push(item.link);
        historyUpdated = true;

        // Small sleep to avoid hitting limits if we send multiple entries (2 seconds sleep)
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      // Save history back to KV (1 request per feed)
      if (historyUpdated) {
        await storage.saveFeedHistory(feed.link, currentFeedHistory);
        historyUpdated = false;
      }
    }
  } catch (error: any) {
    // If limit exceeded, save any pending history before stopping
    if (historyUpdated && currentFeedLink) {
      try {
        console.log(`Saving progress for ${currentFeedLink} before exiting...`);
        await storage.saveFeedHistory(currentFeedLink, currentFeedHistory);
      } catch (kvErr) {
        console.error("Failed to save progress on interruption:", kvErr);
      }
    }

    if (error.message === "SUBREQUESTS_LIMIT_EXCEEDED") {
      console.warn("Cloudflare Worker subrequest limit reached (safety threshold). Gracefully interrupting execution. Remaining feeds will be processed during the next scheduled hour.");
    } else {
      console.error("Error processing feeds:", error);
    }
  }
}

