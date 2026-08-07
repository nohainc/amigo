import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseFeed } from "./services/feed";
import { StorageService, type HourlyRunStatus, type KVNamespaceMock } from "./services/storage";
import { TelegramService } from "./services/telegram";
import { checkSubrequestsCapacity, getSubrequestsCount, resetSubrequestsCount, trackedFetch } from "./utils/tracker";

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
});
