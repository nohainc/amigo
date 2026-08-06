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
  sentPostsByFeed: Record<string, number>;
  message: string;
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
      try {
        const lock = JSON.parse(existing);
        if (typeof lock?.expiresAt === "number" && lock.expiresAt > now) {
          return null;
        }
      } catch {
        return null;
      }
    }

    const token = crypto.randomUUID();
    await this.kv.put(
      key,
      JSON.stringify({ token, expiresAt: now + ttlSeconds * 1000 }),
      { expirationTtl: ttlSeconds }
    );
    return token;
  }

  async releaseRunLock(token: string): Promise<void> {
    const key = "run_lock";
    const existing = await this.kv.get(key);
    if (!existing) return;

    try {
      const lock = JSON.parse(existing);
      if (lock?.token === token) {
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
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((link) => typeof link === "string") : [];
    } catch {
      return [];
    }
  }

  async saveFeedSnapshot(feedLink: string, links: string[]): Promise<void> {
    const key = `snapshot:${this.hash(feedLink)}`;
    await this.kv.put(key, JSON.stringify(this.uniqueLinks(links)));
  }

  async getRecentSent(feedLink: string): Promise<string[]> {
    const key = `recent:${this.hash(feedLink)}`;
    const value = await this.kv.get(key);
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((link) => typeof link === "string") : [];
    } catch {
      return [];
    }
  }

  async saveRecentSent(feedLink: string, links: string[]): Promise<void> {
    const key = `recent:${this.hash(feedLink)}`;
    await this.kv.put(key, JSON.stringify(this.uniqueLinks(links).slice(0, this.recentLimit)));
  }

  mergeRecentSent(existing: string[], sentNow: string[]): string[] {
    return this.uniqueLinks([...sentNow, ...existing]).slice(0, this.recentLimit);
  }

  async getDailyStatus(date: string): Promise<DailyBotStatus | null> {
    const value = await this.kv.get(this.dailyStatusKey(date));
    if (!value) return null;

    try {
      const parsed = JSON.parse(value);
      return parsed && Array.isArray(parsed.runs) ? parsed : null;
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
      JSON.stringify({
        date,
        timezone,
        updatedAt: new Date().toISOString(),
        sentItems: this.calculateDailySentItems(runs),
        sentPostsByFeed: this.calculateDailySentPostsByFeed(runs),
        runs,
      }),
      { expirationTtl: 60 * 60 * 24 * 3 }
    );
  }

  private uniqueLinks(links: string[]): string[] {
    return [...new Set(links.filter(Boolean))];
  }

  private dailyStatusKey(date: string): string {
    return `status:${date}`;
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
