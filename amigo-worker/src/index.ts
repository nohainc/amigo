import feedsNano from "./feeds.nano";
import topicsNano from "./topics.nano";
import { parseFeed } from "./services/feed";
import { parseNano } from "./services/nanomarkup";
import { FeedRunStatus, HourlyRunStatus, StorageService } from "./services/storage";
import { FeedItem, TelegramService } from "./services/telegram";
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
  SUBREQUESTS_LIMIT?: string;
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
        await runBot(env, "manual");
        return new Response("Bot run completed successfully", { status: 200 });
      } catch (err: any) {
        return new Response(`Error running bot: ${err.message}`, { status: 500 });
      }
    }

    if (url.pathname === "/weather") {
      try {
        await sendWeatherForecast(env, { force: true, markSent: false });
        return new Response("Weather message sent successfully", { status: 200 });
      } catch (err: any) {
        return new Response(`Error sending weather message: ${err.message}`, { status: 500 });
      }
    }

    if (url.pathname === "/status") {
      const timezone = env.TIMEZONE || "Europe/Bratislava";
      const storage = new StorageService(env.amigo);
      const date = getLocalDateParts(timezone).date;
      const status = await storage.getDailyStatus(date);
      const nanoStatus = storage.formatDailyStatusNano(
        status ?? {
          date,
          timezone,
          updatedAt: new Date().toISOString(),
          sentItems: 0,
          sentPostsByFeed: {},
          runs: [],
        }
      );
      return new Response(nanoStatus, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    return new Response("Amigo Telegram Bot Worker is active. Use /run to execute manual feed pull, /weather to send the weather message, or /status to inspect today's status.", { status: 200 });
  },
};

interface SendWeatherForecastOptions {
  force?: boolean;
  markSent?: boolean;
}

async function runBot(env: Env, trigger: "scheduled" | "manual" = "scheduled"): Promise<void> {
  const timezone = env.TIMEZONE || "Europe/Bratislava";
  const startHour = parseInt(env.START_HOUR || "9", 10);
  const endHour = parseInt(env.END_HOUR || "21", 10);
  const storage = new StorageService(env.amigo);
  const localDateParts = getLocalDateParts(timezone);
  const runStatus: HourlyRunStatus = {
    hour: localDateParts.hour,
    startedAt: new Date().toISOString(),
    status: "running",
    trigger,
    processedFeeds: 0,
    totalFeeds: 0,
    sentItems: 0,
    feeds: [],
  };

  // Validate active hour constraint (Slovakia Timezone)
  const currentLocalHour = parseInt(localDateParts.hour, 10);

  if (currentLocalHour < startHour || currentLocalHour > endHour) {
    console.log(`Skipping bot run. Current hour (${currentLocalHour}) is outside working hours (${startHour}-${endHour}) for timezone ${timezone}.`);
    runStatus.status = "skipped";
    runStatus.finishedAt = new Date().toISOString();
    await storage.saveHourlyStatus(localDateParts.date, timezone, runStatus);
    return;
  }
  resetSubrequestsCount(parsePositiveInteger(env.SUBREQUESTS_LIMIT, 9000));
  console.log(`[${currentLocalHour}:00] Executing amigo bot run...`);

  if (!env.TELEGRAM_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error("Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID bindings");
  }

  const feedsConfig: any[] = parseNano(feedsNano);
  const topicsConfig: any[] = parseNano(topicsNano);
  const activeFeeds = feedsConfig.filter((feed) => feed.active);
  runStatus.totalFeeds = activeFeeds.length;
  await storage.saveHourlyStatus(localDateParts.date, timezone, runStatus);

  const telegram = new TelegramService(env.TELEGRAM_TOKEN, env.TELEGRAM_CHAT_ID, topicsConfig, env.AI, timezone);
  const runLockToken = await storage.acquireRunLock();

  if (!runLockToken) {
    console.log("Skipping bot run because another run is still in progress.");
    runStatus.status = "skipped";
    runStatus.finishedAt = new Date().toISOString();
    await storage.saveHourlyStatus(localDateParts.date, timezone, runStatus);
    return;
  }

  let currentFeedLink = "";
  let currentFeedSnapshot: string[] = [];
  let currentRecentSent: string[] = [];
  let currentSentLinks: string[] = [];
  let progressUpdated = false;

  try {
    // 1. Weather check runs FIRST if current local hour is 09:00.
    if (currentLocalHour === 9) {
      try {
        await sendWeatherForecast(env, { telegram, timezone });
      } catch (weatherErr) {
        console.error("Error executing evening weather forecast:", weatherErr);
      }
    }

    // 2. Feed checks run next. Order is defined in feeds.nano.
    for (const feed of feedsConfig) {
      if (!feed.active) {
        continue;
      }

      const feedStatus: FeedRunStatus = {
        feed: feed.link,
        status: "success",
        currentItems: 0,
        newItems: 0,
        sentItems: 0,
      };

      currentFeedLink = feed.link;
      progressUpdated = false;
      currentSentLinks = [];

      try {
        console.log(`Checking feed: ${feed.link}`);
        const items = await parseFeed(feed.link);
        const currentFeedLinks = items.map((item) => item.link).filter(Boolean);
        feedStatus.currentItems = currentFeedLinks.length;

        const previousSnapshot = await storage.getFeedSnapshot(feed.link);
        currentFeedSnapshot = currentFeedLinks;

        if (previousSnapshot === null) {
          await storage.saveFeedSnapshot(feed.link, currentFeedSnapshot);
          feedStatus.status = "initialized";
          console.log(`Initialized snapshot for feed: ${feed.link} with ${currentFeedSnapshot.length} items.`);
          continue;
        }

        currentRecentSent = await storage.getRecentSent(feed.link);
        const previousSnapshotSet = new Set(previousSnapshot);
        const recentSentSet = new Set(currentRecentSent);
        const newItems = [];

        // Find new items
        for (const item of items) {
          if (item.link && !previousSnapshotSet.has(item.link) && !recentSentSet.has(item.link)) {
            newItems.push(item);
          }
        }
        feedStatus.newItems = newItems.length;

        if (newItems.length === 0) {
          await storage.saveFeedSnapshot(feed.link, currentFeedSnapshot);
          continue;
        }

        console.log(`Found ${newItems.length} new items in feed: ${feed.link}`);

        const isUkrainian = feed.language === "uk";

        // Batch translate foreign feeds
        let processedItems = sortByPublishedTime(newItems);
        if (!isUkrainian) {
          processedItems = await telegram.batchTranslate(processedItems, feed.language || "sk");
        }

        // Send items to Telegram
        for (const item of processedItems) {
          console.log(`Forwarding feed item: ${item.title} to Telegram topic "${feed.topic}"`);
          await telegram.sendItem(feed.topic, item, feed.language);
        
          currentSentLinks.push(item.link);
          feedStatus.sentItems = currentSentLinks.length;
          runStatus.sentItems++;
          progressUpdated = true;

          // Small sleep to avoid hitting limits if we send multiple entries (2 seconds sleep)
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        if (progressUpdated) {
          currentRecentSent = storage.mergeRecentSent(currentRecentSent, currentSentLinks);
          await storage.saveRecentSent(feed.link, currentRecentSent);
          progressUpdated = false;
        }
        await storage.saveFeedSnapshot(feed.link, currentFeedSnapshot);
      } catch (feedError: any) {
        feedStatus.status = "error";
        feedStatus.error = feedError?.message || String(feedError);
        if (feedStatus.error === "SUBREQUESTS_LIMIT_EXCEEDED") {
          throw feedError;
        }
        console.error(`Feed processing failed for ${feed.link}:`, feedError);
      } finally {
        runStatus.feeds.push(feedStatus);
        if (feedStatus.status !== "error") {
          runStatus.processedFeeds++;
        }
        await storage.saveHourlyStatus(localDateParts.date, timezone, runStatus);
      }
    }
    runStatus.status = "success";
    runStatus.finishedAt = new Date().toISOString();
  } catch (error: any) {
    // If limit exceeded, save successfully sent links before stopping.
    if (progressUpdated && currentFeedLink) {
      try {
        console.log(`Saving progress for ${currentFeedLink} before exiting...`);
        currentRecentSent = storage.mergeRecentSent(currentRecentSent, currentSentLinks);
        await storage.saveRecentSent(currentFeedLink, currentRecentSent);
        await storage.saveFeedSnapshot(currentFeedLink, currentFeedSnapshot);
      } catch (kvErr) {
        console.error("Failed to save progress on interruption:", kvErr);
      }
    }

    if (error.message === "SUBREQUESTS_LIMIT_EXCEEDED") {
      console.warn("Cloudflare Worker subrequest limit reached (safety threshold). Gracefully interrupting execution. Remaining feeds will be processed during the next scheduled hour.");
      runStatus.status = "partial";
    } else {
      console.error("Error processing feeds:", error);
      runStatus.status = "error";
    }
    runStatus.finishedAt = new Date().toISOString();
    runStatus.error = error?.message || String(error);
  } finally {
    await storage.saveHourlyStatus(localDateParts.date, timezone, runStatus);
    await storage.releaseRunLock(runLockToken);
  }
}

async function sendWeatherForecast(
  env: Env,
  options: SendWeatherForecastOptions & { telegram?: TelegramService; timezone?: string } = {}
): Promise<void> {
  const timezone = options.timezone || env.TIMEZONE || "Europe/Bratislava";
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

  if (!options.force) {
    const alreadySentWeather = await env.amigo.get(weatherSentKey);
    if (alreadySentWeather) {
      return;
    }
  }

  if (!env.TELEGRAM_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error("Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID bindings");
  }

  const telegram =
    options.telegram ||
    new TelegramService(env.TELEGRAM_TOKEN, env.TELEGRAM_CHAT_ID, parseNano(topicsNano), env.AI, timezone);

  console.log(`Sending morning weather forecast for the third day from today...`);
  const weatherForecasts = await fetchAllCitiesWeather();
  const weatherMessage = formatMultiCityWeatherMessage(weatherForecasts);
  await telegram.sendRawMessage("weather", weatherMessage);

  if (options.markSent !== false) {
    await env.amigo.put(weatherSentKey, "sent");
  }

  console.log("Third-day weather forecast successfully posted.");
}

function sortByPublishedTime(items: FeedItem[]): FeedItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aTime = a.item.publishedTimestamp;
      const bTime = b.item.publishedTimestamp;

      if (aTime !== undefined && bTime !== undefined) {
        return aTime - bTime;
      }
      if (aTime !== undefined) return -1;
      if (bTime !== undefined) return 1;
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getLocalDateParts(timezone: string): { date: string; hour: string } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  const hour = parts.find((part) => part.type === "hour")?.value || "00";

  return {
    date: `${year}-${month}-${day}`,
    hour,
  };
}
