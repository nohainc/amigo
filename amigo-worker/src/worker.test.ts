import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./feeds.nano", () => ({ default: "" }));
vi.mock("./topics.nano", () => ({ default: "" }));

import { parseFeed } from "./services/feed";
import { parseNano } from "./services/nanomarkup";
import { StorageService, type HourlyRunStatus, type KVNamespaceMock } from "./services/storage";
import { TelegramService } from "./services/telegram";
import { checkSubrequestsCapacity, getSubrequestsCount, resetSubrequestsCount, trackedFetch } from "./utils/tracker";
import worker, { sortByPublishedTime } from "./index";

class MemoryKV implements KVNamespaceMock {
  store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

describe("feed parsing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads RSS and Atom publish dates into sortable timestamps", async () => {
    const rssXml = `<?xml version="1.0"?>
      <rss><channel>
        <item>
          <title>RSS post</title>
          <link>https://example.com/rss-post</link>
          <pubDate>Fri, 07 Aug 2026 08:30:00 GMT</pubDate>
          <category>News</category>
        </item>
      </channel></rss>`;

    vi.stubGlobal("fetch", vi.fn(async () => new Response(rssXml, { status: 200 })));
    resetSubrequestsCount();

    const [rssItem] = await parseFeed("https://example.com/rss.xml");

    expect(rssItem.publishedAt).toBe("2026-08-07T08:30:00.000Z");
    expect(rssItem.publishedTimestamp).toBe(Date.parse("2026-08-07T08:30:00Z"));

    const atomXml = `<?xml version="1.0"?>
      <feed>
        <entry>
          <title>Atom post</title>
          <link rel="alternate" href="https://example.com/atom-post" />
          <updated>2026-08-07T09:45:00Z</updated>
        </entry>
      </feed>`;

    vi.stubGlobal("fetch", vi.fn(async () => new Response(atomXml, { status: 200 })));

    const [atomItem] = await parseFeed("https://example.com/atom.xml");

    expect(atomItem.publishedAt).toBe("2026-08-07T09:45:00.000Z");
    expect(atomItem.publishedTimestamp).toBe(Date.parse("2026-08-07T09:45:00Z"));
  });

  it("falls back cleanly when a feed item has no valid publish date", async () => {
    const rssXml = `<?xml version="1.0"?>
      <rss><channel>
        <item>
          <title>No date</title>
          <link>https://example.com/no-date</link>
          <pubDate>not a real date</pubDate>
        </item>
      </channel></rss>`;

    vi.stubGlobal("fetch", vi.fn(async () => new Response(rssXml, { status: 200 })));
    resetSubrequestsCount();

    const [item] = await parseFeed("https://example.com/rss.xml");

    expect(item.publishedAt).toBeUndefined();
    expect(item.publishedTimestamp).toBeUndefined();
  });

  it("throws a useful error when a feed fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404, statusText: "Not Found" })));
    resetSubrequestsCount();

    await expect(parseFeed("https://example.com/missing.xml")).rejects.toThrow(
      "Failed to fetch feed from https://example.com/missing.xml: Not Found"
    );
  });
});

describe("storage status", () => {
  it("formats processedFeeds as a single readable field without totalFeeds", async () => {
    const kv = new MemoryKV();
    const storage = new StorageService(kv as any);
    const run: HourlyRunStatus = {
      hour: "11",
      startedAt: "2026-08-07T09:00:00.000Z",
      finishedAt: "2026-08-07T09:01:00.000Z",
      status: "success",
      trigger: "manual",
      processedFeeds: 10,
      totalFeeds: 11,
      sentItems: 2,
      feeds: [
        {
          feed: "https://example.com/feed.xml",
          status: "success",
          currentItems: 5,
          newItems: 2,
          sentItems: 2,
        },
      ],
    };

    await storage.saveHourlyStatus("2026-08-07", "Europe/Bratislava", run);
    const rawStatus = kv.store.get("status:2026-08-07") || "";

    expect(rawStatus).toContain("processedFeeds 10 of 11");
    expect(rawStatus).not.toContain("totalFeeds");
  });

  it("merges newly sent links first and removes duplicates", () => {
    const storage = new StorageService(new MemoryKV() as any);

    expect(storage.mergeRecentSent(["old", "duplicate"], ["new", "duplicate"])).toEqual([
      "new",
      "duplicate",
      "old",
    ]);
  });

  it("round-trips old processedFeeds slash format", async () => {
    const kv = new MemoryKV();
    kv.store.set(
      "status:2026-08-07",
      `..
    date 2026-08-07
    timezone Europe/Bratislava
    updatedAt 2026-08-07T09:00:00.000Z
    sentItems 0
    sentPostsByFeed:
    runs:
        ..
            hour 11
            startedAt 2026-08-07T09:00:00.000Z
            status running
            trigger scheduled
            processedFeeds 10/11
            totalFeeds 11
            sentItems 0
            feeds:`
    );

    const storage = new StorageService(kv as any);
    const status = await storage.getDailyStatus("2026-08-07");

    expect(status?.runs[0].processedFeeds).toBe(10);
    expect(status?.runs[0].totalFeeds).toBe(11);
  });

  it("stores snapshots and recent links as unique Nano arrays", async () => {
    const kv = new MemoryKV();
    const storage = new StorageService(kv as any);

    await storage.saveFeedSnapshot("https://example.com/feed.xml", ["a", "a", "", "b"]);
    await storage.saveRecentSent("https://example.com/feed.xml", ["sent", "sent", "older"]);

    expect(await storage.getFeedSnapshot("https://example.com/feed.xml")).toEqual(["a", "b"]);
    expect(await storage.getRecentSent("https://example.com/feed.xml")).toEqual(["sent", "older"]);
  });

  it("keeps only the most recent 300 sent links", async () => {
    const storage = new StorageService(new MemoryKV() as any);
    const links = Array.from({ length: 301 }, (_, index) => `https://example.com/${index}`);

    await storage.saveRecentSent("https://example.com/feed.xml", links);

    const recent = await storage.getRecentSent("https://example.com/feed.xml");
    expect(recent).toHaveLength(300);
    expect(recent[0]).toBe("https://example.com/0");
    expect(recent).not.toContain("https://example.com/300");
  });

  it("replaces a status update for the same run and recalculates daily totals", async () => {
    const storage = new StorageService(new MemoryKV() as any);
    const firstRun: HourlyRunStatus = {
      hour: "11",
      startedAt: "2026-08-07T09:00:00.000Z",
      status: "running",
      trigger: "scheduled",
      processedFeeds: 1,
      totalFeeds: 2,
      sentItems: 1,
      feeds: [{ feed: "https://example.com/a", status: "success", sentItems: 1 }],
    };
    const updatedRun = { ...firstRun, status: "success" as const, processedFeeds: 2, sentItems: 3 };

    await storage.saveHourlyStatus("2026-08-07", "Europe/Bratislava", firstRun);
    await storage.saveHourlyStatus("2026-08-07", "Europe/Bratislava", updatedRun);
    const status = await storage.getDailyStatus("2026-08-07");

    expect(status?.runs).toHaveLength(1);
    expect(status?.runs[0].status).toBe("success");
    expect(status?.sentItems).toBe(3);
  });

  it("releases a lock only for its owner and permits a lock after expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T09:00:00.000Z"));
    const storage = new StorageService(new MemoryKV() as any);
    const firstToken = await storage.acquireRunLock(60);

    expect(firstToken).toBeTruthy();
    expect(await storage.acquireRunLock(60)).toBeNull();
    await storage.releaseRunLock("not-the-owner");
    expect(await storage.acquireRunLock(60)).toBeNull();

    vi.advanceTimersByTime(60_001);
    expect(await storage.acquireRunLock(60)).toBeTruthy();
    vi.useRealTimers();
  });
});

describe("feed ordering", () => {
  it("sends dated items oldest first and leaves undated items in their original order last", () => {
    const items = sortByPublishedTime([
      { title: "newer", link: "newer", publishedTimestamp: 30 },
      { title: "undated first", link: "undated-first" },
      { title: "older", link: "older", publishedTimestamp: 10 },
      { title: "undated second", link: "undated-second" },
    ]);

    expect(items.map((item) => item.link)).toEqual(["older", "newer", "undated-first", "undated-second"]);
  });
});

describe("manual worker runs", () => {
  it("waits for run completion instead of leaving the work in a short-lived background task", async () => {
    const kv = new MemoryKV();
    const waitUntil = vi.fn();
    const response = await worker.fetch(
      new Request("https://worker.example/run"),
      {
        amigo: kv as any,
        AI: {},
        TELEGRAM_TOKEN: "token",
        TELEGRAM_CHAT_ID: "chat-id",
        TIMEZONE: "Europe/Bratislava",
        // This makes the run finish through the normal skipped-status path quickly.
        START_HOUR: "24",
        END_HOUR: "24",
      },
      { waitUntil } as any
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Bot run completed");
    expect(waitUntil).not.toHaveBeenCalled();
    expect([...kv.store.values()].join("\n")).toContain("trigger manual");
    expect([...kv.store.values()].join("\n")).toContain("status skipped");
  });
});

describe("subrequest tracker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the configured safety limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    resetSubrequestsCount(2);

    await trackedFetch("https://example.com/one");
    await trackedFetch("https://example.com/two");

    expect(getSubrequestsCount()).toBe(2);
    expect(() => checkSubrequestsCapacity()).toThrow("SUBREQUESTS_LIMIT_EXCEEDED");
  });
});

describe("telegram sender", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits for Telegram retry_after and retries the same message", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 1",
            parameters: { retry_after: 1 },
          }),
          { status: 429 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);
    resetSubrequestsCount();

    const telegram = new TelegramService("token", "chat-id", [{ name_en: "news", id: "1" }]);
    const sendPromise = telegram.sendRawMessage("news", "hello");

    await vi.advanceTimersByTimeAsync(2000);
    await sendPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual(
      JSON.parse(fetchMock.mock.calls[1][1].body as string)
    );
  });

  it("formats feed posts with categories, links, translation link, and local publish time", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    resetSubrequestsCount();

    const telegram = new TelegramService("token", "chat-id", [{ name_en: "news", id: "1" }], undefined, "Europe/Bratislava");

    await telegram.sendItem(
      "news",
      {
        title: "Original title",
        link: "https://www.example.sk/post",
        description: "Summary",
        categories: ["Long Category", "News"],
        publishedAt: "2026-08-07T08:30:00.000Z",
        translatedDescription: "Translated summary",
      },
      "sk"
    );

    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(firstCall[1].body as string);

    expect(body.message_thread_id).toBe(1);
    expect(body.text).toContain("Long Category | News\n\n");
    expect(body.text).toContain("Original title\n\nTranslated summary");
    expect(body.text).toContain('<a href="https://www.example.sk/post">example.sk</a> | <a href="http://translate.google.com/translate?');
    expect(body.text).toContain("\n07.08.2026 10:30");
  });

  it("escapes translated content and URL attributes before sending Telegram HTML", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    resetSubrequestsCount();

    const telegram = new TelegramService("token", "chat-id", [{ name_en: "news", id: "1" }]);
    await telegram.sendItem(
      "news",
      {
        title: "Title",
        link: 'https://example.com/?q="unsafe"',
        translatedTitle: "<b>Not markup</b>",
      },
      "uk"
    );

    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(firstCall[1].body as string);
    expect(body.text).toContain("&lt;b&gt;Not markup&lt;/b&gt;");
    expect(body.text).toContain('href="https://example.com/?q=&quot;unsafe&quot;"');
  });

  it("routes news posts to a more specific topic when a category matches", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    resetSubrequestsCount();

    const telegram = new TelegramService("token", "chat-id", [
      { name_en: "news", id: "1" },
      { name_en: "sport", id: "7", tags: ["football"] },
    ]);

    await telegram.sendItem(
      "news",
      {
        title: "Match",
        link: "https://example.com/match",
        categories: ["football"],
      },
      "uk"
    );

    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(firstCall[1].body as string);
    expect(body.message_thread_id).toBe(7);
  });

  it("does not retry non-rate-limit Telegram failures", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: false, description: "Bad Request" }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    resetSubrequestsCount();

    const telegram = new TelegramService("token", "chat-id", [{ name_en: "news", id: "1" }]);

    await expect(telegram.sendRawMessage("news", "hello")).rejects.toThrow("Telegram send raw failed (400)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("nanomarkup", () => {
  it("parses nested status-like Nano records", () => {
    const parsed = parseNano(`..
    runs:
        ..
            hour 11
            status running
            feeds:
                ..
                    feed https://example.com/feed.xml
                    sentItems 2`);

    expect(parsed.runs[0].hour).toBe("11");
    expect(parsed.runs[0].feeds[0].sentItems).toBe("2");
  });
});
