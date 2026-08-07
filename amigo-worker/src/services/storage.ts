import { parseNano, stringifyNano } from "./nanomarkup";

export interface KVNamespaceMock {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

export type BotRunStatus = "running" | "success" | "partial" | "skipped" | "error";

export interface FeedRunStatus {
  feed: string;
  status: "success" | "initialized" | "error";
  currentItems?: number;
  newItems?: number;
  sentItems?: number;
  error?: string;
}

export interface HourlyRunStatus {
  hour: string;
  startedAt: string;
  finishedAt?: string;
  status: BotRunStatus;
  trigger: "scheduled" | "manual";
  processedFeeds: number;
  totalFeeds: number;
  sentItems: number;
  sentPostsByFeed?: Record<string, number>;
  message?: string;
  error?: string;
  feeds: FeedRunStatus[];
}

export interface DailyBotStatus {
  date: string;
  timezone: string;
  updatedAt: string;
  sentItems: number;
  sentPostsByFeed: Record<string, number>;
  runs: HourlyRunStatus[];
}

export class StorageService {
  private kv: KVNamespace | KVNamespaceMock;
  private readonly recentLimit = 300;

  constructor(kvNamespace?: KVNamespace) {
    if (kvNamespace) {
      this.kv = kvNamespace;
    } else {
      // Local memory fallback for development/testing when KV is not bound
      const store = new Map<string, string>();
      this.kv = {
        get: async (key: string) => store.get(key) || null,
        put: async (key: string, value: string) => {
          store.set(key, value);
        },
        delete: async (key: string) => {
          store.delete(key);
        },
      };
      console.warn("Using local in-memory fallback store for amigo");
    }
  }

  async acquireRunLock(ttlSeconds = 900): Promise<string | null> {
    const key = "run_lock";
    const existing = await this.kv.get(key);
    const now = Date.now();

    if (existing) {
      const lock = this.parseStoredValue(existing);
      const expiresAt = this.toNumber((lock as any)?.expiresAt, 0);
      if (expiresAt > now) {
        return null;
      }
    }

    const token = crypto.randomUUID();
    await this.kv.put(
      key,
      stringifyNano({ token, expiresAt: now + ttlSeconds * 1000 }),
      { expirationTtl: ttlSeconds }
    );
    return token;
  }

  async releaseRunLock(token: string): Promise<void> {
    const key = "run_lock";
    const existing = await this.kv.get(key);
    if (!existing) return;

    try {
      const lock = this.parseStoredValue(existing);
      if ((lock as any)?.token === token) {
        await this.kv.delete(key);
      }
    } catch {
      // Leave malformed locks to expire naturally.
    }
  }

  async getFeedSnapshot(feedLink: string): Promise<string[] | null> {
    const key = `snapshot:${this.hash(feedLink)}`;
    const value = await this.kv.get(key);
    if (!value) return null;
    try {
      const parsed = this.parseStoredValue(value);
      const normalized = this.normalizeStringArray(parsed);
      if (this.looksLikeJson(value)) {
        await this.kv.put(key, stringifyNano(normalized));
      }
      return normalized;
    } catch {
      return [];
    }
  }

  async saveFeedSnapshot(feedLink: string, links: string[]): Promise<void> {
    const key = `snapshot:${this.hash(feedLink)}`;
    await this.kv.put(key, stringifyNano(this.uniqueLinks(links)));
  }

  async getRecentSent(feedLink: string): Promise<string[]> {
    const key = `recent:${this.hash(feedLink)}`;
    const value = await this.kv.get(key);
    if (!value) return [];
    try {
      const parsed = this.parseStoredValue(value);
      const normalized = this.normalizeStringArray(parsed);
      if (this.looksLikeJson(value)) {
        await this.kv.put(key, stringifyNano(normalized.slice(0, this.recentLimit)));
      }
      return normalized;
    } catch {
      return [];
    }
  }

  async saveRecentSent(feedLink: string, links: string[]): Promise<void> {
    const key = `recent:${this.hash(feedLink)}`;
    await this.kv.put(key, stringifyNano(this.uniqueLinks(links).slice(0, this.recentLimit)));
  }

  mergeRecentSent(existing: string[], sentNow: string[]): string[] {
    return this.uniqueLinks([...sentNow, ...existing]).slice(0, this.recentLimit);
  }

  async getDailyStatus(date: string): Promise<DailyBotStatus | null> {
    const value = await this.kv.get(this.dailyStatusKey(date));
    if (!value) return null;

    try {
      const parsed = this.parseStoredValue(value);
      const normalized = this.normalizeDailyStatus(parsed);
      if (this.looksLikeJson(value)) {
        await this.kv.put(this.dailyStatusKey(date), stringifyNano(this.serializeDailyStatus(normalized)), {
          expirationTtl: 60 * 60 * 24 * 3,
        });
      }
      return normalized;
    } catch {
      return null;
    }
  }

  async saveHourlyStatus(date: string, timezone: string, run: HourlyRunStatus): Promise<void> {
    const currentStatus = await this.getDailyStatus(date);
    const runs = currentStatus?.runs ?? [];
    const runIndex = runs.findIndex((existingRun) => existingRun.startedAt === run.startedAt);

    if (runIndex >= 0) {
      runs[runIndex] = run;
    } else {
      runs.push(run);
    }

    runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

    await this.kv.put(
      this.dailyStatusKey(date),
      stringifyNano(
        this.serializeDailyStatus({
          date,
          timezone,
          updatedAt: new Date().toISOString(),
          sentItems: this.calculateDailySentItems(runs),
          sentPostsByFeed: this.calculateDailySentPostsByFeed(runs),
          runs,
        })
      ),
      { expirationTtl: 60 * 60 * 24 * 3 }
    );
  }

  formatDailyStatusNano(status: DailyBotStatus): string {
    return stringifyNano(this.serializeDailyStatus(status));
  }

  private uniqueLinks(links: string[]): string[] {
    return [...new Set(links.filter(Boolean))];
  }

  private dailyStatusKey(date: string): string {
    return `status:${date}`;
  }

  private serializeDailyStatus(status: DailyBotStatus): Record<string, unknown> {
    return {
      date: status.date,
      timezone: status.timezone,
      updatedAt: status.updatedAt,
      sentItems: status.sentItems,
      sentPostsByFeed: this.sentPostsByFeedToEntries(status.sentPostsByFeed),
      runs: status.runs.map((run) => this.serializeHourlyRun(run)),
    };
  }

  private serializeHourlyRun(run: HourlyRunStatus): Record<string, unknown> {
    return {
      hour: run.hour,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      status: run.status,
      trigger: run.trigger,
      processedFeeds: `${run.processedFeeds} of ${run.totalFeeds}`,
      sentItems: run.sentItems,
      error: run.error,
      feeds: run.feeds.map((feed) => ({
        feed: feed.feed,
        status: feed.status,
        currentItems: feed.currentItems,
        newItems: feed.newItems,
        sentItems: feed.sentItems,
        error: feed.error,
      })),
    };
  }

  private normalizeDailyStatus(value: unknown): DailyBotStatus {
    const source = this.normalizeObject(value);
    return {
      date: this.asString(source.date),
      timezone: this.asString(source.timezone),
      updatedAt: this.asString(source.updatedAt || new Date().toISOString()),
      sentItems: this.toNumber(source.sentItems, 0),
      sentPostsByFeed: this.normalizeSentPostsByFeed(source.sentPostsByFeed),
      runs: this.normalizeRuns(source.runs),
    };
  }

  private normalizeRuns(value: unknown): HourlyRunStatus[] {
    if (!Array.isArray(value)) return [];

    return value.map((runValue) => {
      const run = this.normalizeObject(runValue);
      return {
        hour: this.asString(run.hour),
        startedAt: this.asString(run.startedAt),
        finishedAt: run.finishedAt ? this.asString(run.finishedAt) : undefined,
        status: this.normalizeRunStatus(run.status),
        trigger: this.normalizeTrigger(run.trigger),
        ...this.parseProcessedFeeds(run.processedFeeds, run.totalFeeds),
        sentItems: this.toNumber(run.sentItems, 0),
        sentPostsByFeed: this.normalizeSentPostsByFeed(run.sentPostsByFeed),
        message: run.message ? this.asString(run.message) : undefined,
        error: run.error ? this.asString(run.error) : undefined,
        feeds: this.normalizeFeedStatuses(run.feeds),
      };
    });
  }

  private normalizeFeedStatuses(value: unknown): FeedRunStatus[] {
    if (!Array.isArray(value)) return [];

    return value.map((feedValue) => {
      const feed = this.normalizeObject(feedValue);
      return {
        feed: this.asString(feed.feed),
        status: this.normalizeFeedStatus(feed.status),
        currentItems: feed.currentItems !== undefined ? this.toNumber(feed.currentItems, 0) : undefined,
        newItems: feed.newItems !== undefined ? this.toNumber(feed.newItems, 0) : undefined,
        sentItems: feed.sentItems !== undefined ? this.toNumber(feed.sentItems, 0) : undefined,
        error: feed.error ? this.asString(feed.error) : undefined,
      };
    });
  }

  private normalizeSentPostsByFeed(value: unknown): Record<string, number> {
    const totals: Record<string, number> = {};

    if (Array.isArray(value)) {
      for (const entryValue of value) {
        const entry = this.normalizeObject(entryValue);
        const feed = this.asString(entry.feed);
        if (!feed) continue;
        totals[feed] = this.toNumber(entry.count ?? entry.sentItems, 0);
      }
      return totals;
    }

    if (this.isPlainObject(value)) {
      for (const [feed, count] of Object.entries(value)) {
        totals[feed] = this.toNumber(count, 0);
      }
    }

    return totals;
  }

  private sentPostsByFeedToEntries(value: Record<string, number>): Array<{ feed: string; count: number }> {
    return Object.keys(value)
      .sort()
      .map((feed) => ({
        feed,
        count: value[feed],
      }));
  }

  private normalizeObject(value: unknown): Record<string, any> {
    if (this.isPlainObject(value)) {
      return value;
    }

    return {};
  }

  private parseStoredValue(value: string): unknown {
    const trimmed = value.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return JSON.parse(value);
    }
    return parseNano(value);
  }

  private looksLikeJson(value: string): boolean {
    const trimmed = value.trimStart();
    return trimmed.startsWith("{") || trimmed.startsWith("[");
  }

  private normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.map((item) => this.asString(item)).filter(Boolean);
  }

  private normalizeRunStatus(value: unknown): BotRunStatus {
    const status = this.asString(value);
    if (status === "running" || status === "success" || status === "partial" || status === "skipped" || status === "error") {
      return status;
    }
    return "error";
  }

  private normalizeFeedStatus(value: unknown): FeedRunStatus["status"] {
    const status = this.asString(value);
    if (status === "success" || status === "initialized" || status === "error") {
      return status;
    }
    return "error";
  }

  private normalizeTrigger(value: unknown): HourlyRunStatus["trigger"] {
    const trigger = this.asString(value);
    return trigger === "manual" ? "manual" : "scheduled";
  }

  private asString(value: unknown): string {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return "";
  }

  private toNumber(value: unknown, fallback: number): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
    return fallback;
  }

  private parseProcessedFeeds(value: unknown, totalFallback: unknown): { processedFeeds: number; totalFeeds: number } {
    if (typeof value === "string") {
      const match = value.trim().match(/^(\d+)\s*(?:\/|of)\s*(\d+)$/i);
      if (match) {
        return {
          processedFeeds: this.toNumber(match[1], 0),
          totalFeeds: this.toNumber(match[2], 0),
        };
      }
      return {
        processedFeeds: this.toNumber(value, 0),
        totalFeeds: this.toNumber(totalFallback, 0),
      };
    }

    return {
      processedFeeds: this.toNumber(value, 0),
      totalFeeds: this.toNumber(totalFallback, 0),
    };
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private calculateDailySentItems(runs: HourlyRunStatus[]): number {
    return runs.reduce((total, run) => total + (run.sentItems || 0), 0);
  }

  private calculateDailySentPostsByFeed(runs: HourlyRunStatus[]): Record<string, number> {
    const totals: Record<string, number> = {};

    for (const run of runs) {
      if (run.sentPostsByFeed && Object.keys(run.sentPostsByFeed).length > 0) {
        for (const [feed, sentItems] of Object.entries(run.sentPostsByFeed)) {
          totals[feed] = (totals[feed] || 0) + sentItems;
        }
        continue;
      }

      for (const feedStatus of run.feeds || []) {
        if (feedStatus.sentItems && feedStatus.sentItems > 0) {
          totals[feedStatus.feed] = (totals[feedStatus.feed] || 0) + feedStatus.sentItems;
        }
      }
    }

    return totals;
  }

  private hash(str: string): string {
    // Simple, deterministic string hashing for KV keys (alphanumeric only)
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
  }
}
