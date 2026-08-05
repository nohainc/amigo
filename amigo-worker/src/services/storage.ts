export interface KVNamespaceMock {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export class StorageService {
  private kv: KVNamespace | KVNamespaceMock;

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
      };
      console.warn("Using local in-memory fallback store for amigo");
    }
  }

  /**
   * Checks if an RSS link has already been sent to Telegram.
   */
  async isSent(link: string): Promise<boolean> {
    const key = `sent:${this.hash(link)}`;
    const value = await this.kv.get(key);
    return value !== null;
  }

  /**
   * Marks an RSS link as sent.
   */
  async markAsSent(link: string): Promise<void> {
    const key = `sent:${this.hash(link)}`;
    await this.kv.put(key, new Date().toISOString());
  }

  /**
   * Check if feed is active in DB.
   */
  async isFeedActivated(link: string): Promise<boolean> {
    const key = `feed:${this.hash(link)}`;
    const value = await this.kv.get(key);
    return value === "active";
  }

  /**
   * Activate feed (mark all its current items as processed to prevent posting historical feed data on activation).
   */
  async activateFeed(link: string): Promise<void> {
    const key = `feed:${this.hash(link)}`;
    await this.kv.put(key, "active");
  }

  /**
   * Gets the list of processed item link hashes for a specific feed.
   */
  async getFeedHistory(feedLink: string): Promise<string[] | null> {
    const key = `history:${this.hash(feedLink)}`;
    const value = await this.kv.get(key);
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }

  /**
   * Saves the list of processed item link hashes for a specific feed.
   */
  async saveFeedHistory(feedLink: string, history: string[]): Promise<void> {
    const key = `history:${this.hash(feedLink)}`;
    await this.kv.put(key, JSON.stringify(history));
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
