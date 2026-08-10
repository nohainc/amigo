import feedsNano from "./feeds.nano";
import topicsNano from "./topics.nano";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { parseFeed } from "./services/feed";
import { enrichCodnesEvents, isCodnesUrl, isPastCodnesEvent } from "./services/codnes";
import { parseNano } from "./services/nanomarkup";
import { enrichStartitupNews, isStartitupUrl } from "./services/startitup";
import { FeedRunStatus, HourlyRunStatus, StorageService } from "./services/storage";
import { enrichTerazNews, isTerazUrl } from "./services/teraz";
import { FeedItem, TelegramService } from "./services/telegram";
import { enrichUkrinformNews, isUkrinformUrl } from "./services/ukrinform";
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
  BOT_RUN_WORKFLOW: Workflow<ManualRunWorkflowParams>;
}

interface ManualRunWorkflowParams {
  trigger: "manual";
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
      const instance = await env.BOT_RUN_WORKFLOW.create({
        params: { trigger: "manual" },
      });
      return Response.json(
        {
          workflowId: instance.id,
          statusUrl: `${url.origin}/status?workflowId=${encodeURIComponent(instance.id)}`,
        },
        { status: 202 }
      );
    }

    if (url.pathname === "/weather") {
      try {
        const replaceMessageId = parsePositiveInteger(url.searchParams.get("replaceMessageId") || undefined, 0);
        await sendWeatherForecast(env, {
          force: true,
          markSent: false,
          replaceMessageId: replaceMessageId || undefined,
        });
        return new Response("Weather message sent successfully", { status: 200 });
      } catch (err: any) {
        return new Response(`Error sending weather message: ${err.message}`, { status: 500 });
      }
    }

    if (url.pathname === "/status") {
      const workflowId = url.searchParams.get("workflowId");
      if (workflowId) {
        try {
          const instance = await env.BOT_RUN_WORKFLOW.get(workflowId);
          return Response.json({ workflowId, ...(await instance.status()) });
        } catch (error: any) {
          return Response.json(
            { workflowId, status: "unknown", error: error?.message || String(error) },
            { status: 404 }
          );
        }
      }

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

    if (url.pathname === "/cleanup") {
      try {
        const report = await cleanupTelegramUpdates(env);
        return Response.json(report, { status: 200 });
      } catch (err: any) {
        return new Response(`Error running cleanup: ${err.message}`, { status: 500 });
      }
    }

    if (request.method === "POST") {
      try {
        const update: any = await request.json();
        if (update.message) {
          const msg = update.message;
          // Check for join or leave service messages
          if (msg.new_chat_members || msg.left_chat_member) {
            const chatId = msg.chat.id;
            const messageId = msg.message_id;
            const topicsConfig = parseNano(topicsNano);
            const telegram = new TelegramService(env.TELEGRAM_TOKEN, env.TELEGRAM_CHAT_ID, topicsConfig, env.AI);
            await telegram.deleteMessage(chatId, messageId);
            return new Response("OK - Deleted service message", { status: 200 });
          }
        }
        return new Response("OK - Ignored update", { status: 200 });
      } catch (err: any) {
        console.error("Webhook processing error:", err);
        return new Response(`Error: ${err.message}`, { status: 500 });
      }
    }

    return new Response("Amigo Telegram Bot Worker is active. Use /run to execute manual feed pull, /weather to send the weather message, or /status to inspect today's status.", { status: 200 });
  },
};

interface SendWeatherForecastOptions {
  force?: boolean;
  markSent?: boolean;
  replaceMessageId?: number;
}

async function runBot(env: Env, trigger: "scheduled" | "manual" = "scheduled"): Promise<HourlyRunStatus> {
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

  // Run cleanup of join/leave messages 24/7 (regardless of working hours)
  try {
    await cleanupTelegramUpdates(env);
  } catch (err) {
    console.error("Cleanup failed in runBot:", err);
  }

  // Validate active hour constraint (Slovakia Timezone)
  const currentLocalHour = parseInt(localDateParts.hour, 10);

  if (currentLocalHour < startHour || currentLocalHour > endHour) {
    console.log(`Skipping bot run. Current hour (${currentLocalHour}) is outside working hours (${startHour}-${endHour}) for timezone ${timezone}.`);
    runStatus.status = "skipped";
    runStatus.finishedAt = new Date().toISOString();
    await storage.saveHourlyStatus(localDateParts.date, timezone, runStatus);
    return runStatus;
  }
  resetSubrequestsCount(parsePositiveInteger(env.SUBREQUESTS_LIMIT, 9000));
  console.log(`[${currentLocalHour}:00] Executing amigo bot run...`);

  if (!env.TELEGRAM_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error("Missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID bindings");
  }

  const feedsConfig: any[] = parseNano(feedsNano);
  const topicsConfig: any[] = parseNano(topicsNano);
  const activeFeeds = feedsConfig.filter(isFeedActive);
  runStatus.totalFeeds = activeFeeds.length;

  const telegram = new TelegramService(env.TELEGRAM_TOKEN, env.TELEGRAM_CHAT_ID, topicsConfig, env.AI, timezone);
  const runLockToken = await storage.acquireRunLock();

  if (!runLockToken) {
    console.log("Skipping bot run because another run is still in progress.");
    runStatus.status = "skipped";
    runStatus.finishedAt = new Date().toISOString();
    await storage.saveHourlyStatus(localDateParts.date, timezone, runStatus);
    return runStatus;
  }

  await storage.saveHourlyStatus(localDateParts.date, timezone, runStatus);

  let currentRecentSent: string[] = [];
  let lastStatusSavedAt = Date.now();

  const saveRunStatus = async () => {
    // KV permits only one write per second to the same key. This also prevents a
    // status write problem from interrupting the actual feed delivery.
    const waitMs = 1000 - (Date.now() - lastStatusSavedAt);
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    await storage.saveHourlyStatus(localDateParts.date, timezone, runStatus);
    lastStatusSavedAt = Date.now();
  };

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
      if (!isFeedActive(feed)) {
        continue;
      }

      const feedStatus: FeedRunStatus = {
        feed: feed.link,
        status: "success",
        currentItems: 0,
        newItems: 0,
        sentItems: 0,
      };

      runStatus.feeds.push(feedStatus);
      await saveRunStatus();

      try {
        console.log(`Checking feed: ${feed.link}`);
        const isCodnesFeed = isCodnesUrl(String(feed.link || ""));
        const isStartitupFeed = isStartitupUrl(String(feed.link || ""));
        const isTerazFeed = isTerazUrl(String(feed.link || ""));
        const isUkrinformFeed = isUkrinformUrl(String(feed.link || ""));
        const parsedItems = await parseFeed(feed.link);
        const items = isCodnesFeed ? await enrichCodnesEvents(parsedItems) : parsedItems;
        const currentFeedLinks = items.map((item) => item.link).filter(Boolean);
        feedStatus.currentItems = currentFeedLinks.length;

        const previousSnapshot = await storage.getFeedSnapshot(feed.link);
        const pastCodnesLinks = isCodnesFeed
          ? items.filter((item) => item.link && isPastCodnesEvent(item)).map((item) => item.link)
          : [];
        const currentFeedSnapshot = currentFeedLinks;

        if (previousSnapshot === null) {
          await storage.saveFeedSnapshot(feed.link, isCodnesFeed ? pastCodnesLinks : currentFeedSnapshot);
          feedStatus.status = "initialized";
          console.log(
            `Initialized snapshot for feed: ${feed.link} with ${
              isCodnesFeed ? pastCodnesLinks.length : currentFeedSnapshot.length
            } items.`
          );
          continue;
        }

        currentRecentSent = await storage.getRecentSent(feed.link);
        const previousSnapshotSet = new Set(previousSnapshot);
        const recentSentSet = new Set(currentRecentSent);
        const excludedCategories = getExcludedCategories(feed);
        const newItems: FeedItem[] = [];
        let excludedItems = 0;
        let reroutedToUkraineItems = 0;
        let pastCodnesItems = 0;

        // Find new items
        for (const item of items) {
          if (!item.link || previousSnapshotSet.has(item.link) || recentSentSet.has(item.link)) {
            continue;
          }

          if (isCodnesFeed && isPastCodnesEvent(item)) {
            pastCodnesItems++;
            continue;
          }

          if (isItemExcludedByCategory(item, excludedCategories)) {
            excludedItems++;
            continue;
          }

          if (isItemRoutedToDifferentTopic(item, feed.topic, "ukraine", topicsConfig)) {
            reroutedToUkraineItems++;
            continue;
          }

          newItems.push(item);
        }
        if (excludedItems > 0) {
          console.log(
            `Skipped ${excludedItems} new items from ${feed.link} because of excluded categories: ${excludedCategories.join(", ")}`
          );
        }
        if (reroutedToUkraineItems > 0) {
          console.log(
            `Skipped ${reroutedToUkraineItems} new items from ${feed.link} because they matched the Ukraine topic while the feed topic is "${feed.topic}".`
          );
        }
        if (pastCodnesItems > 0) {
          console.log(`Skipped ${pastCodnesItems} old Codnes events from ${feed.link}.`);
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
        if (isStartitupFeed) {
          processedItems = await enrichStartitupNews(processedItems);
        }
        if (isTerazFeed) {
          processedItems = await enrichTerazNews(processedItems);
        }
        if (isUkrinformFeed) {
          processedItems = await enrichUkrinformNews(processedItems);
        }
        if (!isUkrainian) {
          processedItems = await telegram.batchTranslate(processedItems, feed.language || "sk");
        }

        // Send items to Telegram
        for (const item of processedItems) {
          console.log(`Forwarding feed item: ${item.title} to Telegram topic "${feed.topic}"`);
          await telegram.sendItem(feed.topic, item, feed.language);
        
          feedStatus.sentItems = (feedStatus.sentItems ?? 0) + 1;
          runStatus.sentItems++;
          currentRecentSent = storage.mergeRecentSent(currentRecentSent, [item.link]);
          await storage.saveRecentSent(feed.link, currentRecentSent);
          await saveRunStatus();

          // Keep group sends below Telegram's published flood-control guidance.
          await new Promise((resolve) => setTimeout(resolve, 3500));
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
        if (feedStatus.status !== "error") {
          runStatus.processedFeeds++;
        }
        await saveRunStatus();
      }
    }
    runStatus.status = "success";
    runStatus.finishedAt = new Date().toISOString();
  } catch (error: any) {
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
    await saveRunStatus();
    await storage.releaseRunLock(runLockToken);
  }

  return runStatus;
}

export class ManualBotRunWorkflow extends WorkflowEntrypoint<Env, ManualRunWorkflowParams> {
  async run(event: Readonly<WorkflowEvent<ManualRunWorkflowParams>>, step: WorkflowStep) {
    return step.do(
      "process manual feed run",
      {
        retries: { limit: 2, delay: "1 minute", backoff: "exponential" },
        timeout: "15 minutes",
      },
      async () => {
        const run = await runBot(this.env, event.payload.trigger);
        return {
          runStatus: run.status,
          processedFeeds: run.processedFeeds,
          totalFeeds: run.totalFeeds,
          sentItems: run.sentItems,
        };
      }
    );
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
  const weatherMessageIdKey = "weather_message_id";

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

  const storedMessageId = options.replaceMessageId ? undefined : await env.amigo.get(weatherMessageIdKey);
  const messageIdToDelete = options.replaceMessageId || parsePositiveInteger(storedMessageId || undefined, 0);
  if (messageIdToDelete) {
    try {
      await telegram.deleteMessage(env.TELEGRAM_CHAT_ID, messageIdToDelete);
    } catch (error) {
      console.warn(`Failed to delete previous weather message ${messageIdToDelete}:`, error);
    }
  }

  console.log(`Sending three-day weather forecast...`);
  const weatherForecasts = await fetchAllCitiesWeather();
  const weatherMessage = formatMultiCityWeatherMessage(weatherForecasts);
  const sentMessageId = await telegram.sendRawMessage("weather", weatherMessage);
  if (sentMessageId) {
    await env.amigo.put(weatherMessageIdKey, String(sentMessageId));
  }

  if (options.markSent !== false) {
    await env.amigo.put(weatherSentKey, "sent");
  }

  console.log("Three-day weather forecast successfully posted.");
}

export function sortByPublishedTime(items: FeedItem[]): FeedItem[] {
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

export function isFeedActive(feed: { active?: unknown }): boolean {
  return feed.active === true || feed.active === "true";
}

export function getExcludedCategories(feed: { exclude?: unknown }): string[] {
  const configured = feed.exclude;
  const categories = Array.isArray(configured) ? configured : configured ? [configured] : [];

  return categories
    .filter((category): category is string => typeof category === "string")
    .map((category) => category.trim())
    .filter(Boolean);
}

export function isItemExcludedByCategory(item: FeedItem, excludedCategories: string[]): boolean {
  if (!item.categories?.length || !excludedCategories.length) {
    return false;
  }

  const excluded = new Set(excludedCategories.map(normalizeCategory));
  return item.categories.some((category) => excluded.has(normalizeCategory(category)));
}

export function isItemRoutedToDifferentTopic(
  item: FeedItem,
  feedTopic: unknown,
  targetTopic: string,
  topicsConfig: any[]
): boolean {
  if (normalizeCategory(String(feedTopic || "")) === normalizeCategory(targetTopic)) {
    return false;
  }

  const target = topicsConfig.find((topic) => {
    const names = [topic.name_en, topic.name_uk].filter((name): name is string => typeof name === "string");
    return names.some((name) => normalizeCategory(name) === normalizeCategory(targetTopic));
  });

  if (!target || !item.categories?.length) {
    return false;
  }

  const terms = [target.name_en, target.name_uk, ...(Array.isArray(target.tags) ? target.tags : [])]
    .filter((term): term is string => typeof term === "string")
    .map(normalizeCategory);

  return item.categories.some((category) => {
    const normalizedCategory = normalizeCategory(category);
    const words = normalizedCategory.split(/[\s,]+/);
    return terms.some((term) => normalizedCategory === term || words.includes(term));
  });
}

function normalizeCategory(category: string): string {
  return category.trim().toLocaleLowerCase();
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

async function cleanupTelegramUpdates(env: Env): Promise<any> {
  const topicsConfig = parseNano(topicsNano);
  const telegram = new TelegramService(env.TELEGRAM_TOKEN, env.TELEGRAM_CHAT_ID, topicsConfig, env.AI);
  
  const getUpdatesUrl = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getUpdates`;
  const response = await fetch(getUpdatesUrl);
  if (!response.ok) {
    return { error: "Failed to get updates", details: await response.text() };
  }
  
  const data: any = await response.json();
  if (!data.ok || !Array.isArray(data.result)) {
    return { error: "Invalid updates format", response: data };
  }
  
  if (data.result.length === 0) {
    return { message: "No updates found" };
  }
  
  const deleted: any[] = [];
  let maxUpdateId = 0;
  for (const update of data.result) {
    if (update.update_id > maxUpdateId) {
      maxUpdateId = update.update_id;
    }
    
    if (update.message) {
      const msg = update.message;
      if (msg.new_chat_members || msg.left_chat_member) {
        const chatId = msg.chat.id;
        const messageId = msg.message_id;
        try {
          await telegram.deleteMessage(chatId, messageId);
          deleted.push({ chatId, messageId, status: "deleted" });
        } catch (err: any) {
          deleted.push({ chatId, messageId, status: "failed", error: err.message });
        }
      }
    }
  }
  
  if (maxUpdateId > 0) {
    await fetch(`${getUpdatesUrl}?offset=${maxUpdateId + 1}&limit=1`);
  }
  
  return {
    totalUpdates: data.result.length,
    deletedCount: deleted.length,
    deletedDetails: deleted,
    maxUpdateId,
  };
}
