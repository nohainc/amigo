import { translateMessage } from "./translate";
import { trackedFetch } from "../utils/tracker";

export interface FeedItem {
  title: string;
  link: string;
  description?: string;
  categories?: string[];
  publishedAt?: string;
  publishedTimestamp?: number;
  translatedTitle?: string;
  translatedDescription?: string;
}

interface TelegramErrorResponse {
  ok?: boolean;
  error_code?: number;
  description?: string;
  parameters?: {
    retry_after?: number;
  };
}

export class TelegramService {
  private token: string;
  private chatId: string;
  private ai?: any;
  private timezone: string;
  private topicThreadMap: Record<string, number>;

  constructor(token: string, chatId: string, topicsConfig: any[], ai?: any, timezone = "Europe/Bratislava") {
    this.token = token;
    this.chatId = chatId;
    this.ai = ai;
    this.timezone = timezone;
    
    // Dynamically build map of topic name/tag -> Telegram thread ID from config
    this.topicThreadMap = {};
    for (const t of topicsConfig) {
      const id = parseInt(t.id, 10);
      if (isNaN(id)) continue;
      
      // Map English name
      if (t.name_en) {
        this.topicThreadMap[t.name_en.toLowerCase()] = id;
      }
      // Map Ukrainian name
      if (t.name_uk) {
        this.topicThreadMap[t.name_uk.toLowerCase()] = id;
      }
      // Map all tags associated with this topic
      if (Array.isArray(t.tags)) {
        for (const tag of t.tags) {
          this.topicThreadMap[tag.toLowerCase()] = id;
        }
      }
    }
  }

  /**
   * Sends the parsed feed item to the Telegram chat thread.
   */
  async sendItem(topic: string, item: FeedItem, lang: string): Promise<void> {
    let threadId = this.topicThreadMap[topic] || 0;

    // If the feed topic is news, try to route to a more specific topic based on item categories
    if (topic === "news" && item.categories && item.categories.length > 0) {
      const newsThreadId = this.topicThreadMap["news"];
      for (const cat of item.categories) {
        const cleanedCat = cat.trim().toLowerCase();
        
        // Try direct match
        let matchedThreadId = this.topicThreadMap[cleanedCat];
        if (matchedThreadId && matchedThreadId !== newsThreadId) {
          console.log(`Routing item "${item.title}" from news to specific topic matching category "${cat}" (thread ID: ${matchedThreadId})`);
          threadId = matchedThreadId;
          break;
        }
        
        // Try word-by-word match
        const words = cleanedCat.split(/[\s,]+/);
        for (const word of words) {
          const wordThreadId = this.topicThreadMap[word];
          if (wordThreadId && wordThreadId !== newsThreadId) {
            console.log(`Routing item "${item.title}" from news to specific topic matching word "${word}" (thread ID: ${wordThreadId})`);
            threadId = wordThreadId;
            break;
          }
        }
        if (threadId !== newsThreadId) {
          break;
        }
      }
    }

    const message = await this.formatMessage(item, lang);
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;

    await this.sendMessageWithRetry(url, {
      chat_id: this.chatId,
      message_thread_id: threadId,
      parse_mode: "HTML",
      text: message,
    }, "Telegram send failed");
  }
  /**
   * Sends a raw HTML formatted string to the Telegram chat thread.
   */
  async sendRawMessage(topic: string, text: string): Promise<void> {
    const threadId = this.topicThreadMap[topic] || 0;
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;

    await this.sendMessageWithRetry(url, {
      chat_id: this.chatId,
      message_thread_id: threadId,
      parse_mode: "HTML",
      text: text,
    }, "Telegram send raw failed");
  }

  private async sendMessageWithRetry(url: string, body: Record<string, unknown>, errorPrefix: string): Promise<void> {
    const maxAttempts = 5;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await trackedFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        return;
      }

      const errorText = await response.text();
      const retryAfter = this.getRetryAfterSeconds(response.status, errorText);
      if (retryAfter && attempt < maxAttempts) {
        const delayMs = (retryAfter + 1) * 1000;
        console.warn(`${errorPrefix} (${response.status}), retrying after ${retryAfter}s (attempt ${attempt}/${maxAttempts}).`);
        await this.sleep(delayMs);
        continue;
      }

      throw new Error(`${errorPrefix} (${response.status}): ${errorText}`);
    }

    throw new Error(`${errorPrefix}: retry attempts exhausted`);
  }

  private getRetryAfterSeconds(status: number, errorText: string): number | null {
    if (status !== 429) {
      return null;
    }

    try {
      const parsed = JSON.parse(errorText) as TelegramErrorResponse;
      const retryAfter = parsed.parameters?.retry_after;
      return typeof retryAfter === "number" && retryAfter > 0 ? retryAfter : null;
    } catch {
      return null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async formatMessage(item: FeedItem, lang: string): Promise<string> {
    const isUkrainian = lang === "uk";
    const isWeb = isUkrainian ? false : this.isLikelyWebsite(item.link);
    
    // 1. Category line
    let message = "";
    if (item.categories && item.categories.length > 0) {
      message += `${item.categories.map(c => this.cleanText(c)).join(" | ")}\n\n`;
    }

    // 2. Title without link
    let title = this.cleanText(item.translatedTitle || item.title);

    // 3. Summary (if present)
    let summary = "";
    if (item.description) {
      summary = item.translatedDescription
        ? this.cleanText(item.translatedDescription)
        : this.cleanDescription(item.description);
    }

    // Translate summary if needed, or translate title if summary is missing (only if not already batch-translated)
    if (!isUkrainian && !item.translatedTitle && !item.translatedDescription) {
      const srcLang = lang || "sk";
      if (summary.trim()) {
        try {
          summary = this.cleanText(await this.translateText(summary, srcLang));
        } catch (err) {
          console.error("Translation error (summary):", err);
        }
      } else {
        try {
          title = this.cleanText(await this.translateText(title, srcLang));
        } catch (err) {
          console.error("Translation error (title):", err);
        }
      }
    }

    message += title;

    if (summary.trim()) {
      message += `\n\n${summary}`;
    }

    // 4. Links line
    let domain = "";
    try {
      domain = new URL(item.link).hostname.replace(/^www\./, "");
    } catch {
      domain = item.link;
    }

    let linksLine = `<a href="${this.escapeHtmlAttribute(item.link)}">${this.cleanText(domain)}</a>`;

    if (!isUkrainian && isWeb) {
      const srcLang = lang || "sk";
      const translateUrl = `http://translate.google.com/translate?sl=${srcLang}&tl=uk&u=${encodeURIComponent(
        item.link
      )}&client=webapp/`;
      linksLine += ` | <a href="${this.escapeHtmlAttribute(translateUrl)}">Переклад</a>`;
    }

    message += `\n\n${linksLine}`;

    const publishedTime = this.formatPublishedTime(item);
    if (publishedTime) {
      message += `\n${publishedTime}`;
    }

    return message;
  }

  private formatPublishedTime(item: FeedItem): string {
    const date = item.publishedTimestamp !== undefined
      ? new Date(item.publishedTimestamp)
      : item.publishedAt
      ? new Date(item.publishedAt)
      : null;

    if (!date || Number.isNaN(date.getTime())) {
      return "";
    }

    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: this.timezone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date);

    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
    return `${value("day")}.${value("month")}.${value("year")} ${value("hour")}:${value("minute")}`;
  }

  private isLikelyWebsite(url: string): boolean {
    const lowercaseUrl = url.toLowerCase();
    const binaryExtensions = [
      ".jpg", ".jpeg", ".png", ".gif", ".pdf", ".zip", ".rar", ".mp3", ".mp4", 
      ".avi", ".mov", ".docx", ".xlsx", ".pptx", ".epub", ".dmg", ".exe"
    ];
    return !binaryExtensions.some(ext => lowercaseUrl.endsWith(ext) || lowercaseUrl.includes(ext + "?"));
  }

  private cleanText(text: string): string {
    if (!text) return "";
    // Decode common entities first to avoid double encoding, then escape HTML chars
    return text
      .replace(/&nbsp;/g, " ")
      .replace(/&#160;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  private cleanDescription(text: string): string {
    if (!text) return "";
    // 1. Strip all HTML tags
    let cleaned = text.replace(/<[^>]*>/g, "");
    // 2. Escape HTML special characters for Telegram compatibility
    return this.cleanText(cleaned);
  }

  private escapeHtmlAttribute(value: string): string {
    return this.cleanText(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  private async translateText(text: string, srcLang: string): Promise<string> {
    if (this.ai) {
      try {
        console.log(`Translating using Cloudflare Workers AI...`);
        const response = await this.ai.run("@cf/meta/m2m100-1.2b", {
          text: text,
          source_lang: srcLang,
          target_lang: "uk",
        });
        if (response?.translated_text) {
          return response.translated_text;
        }
      } catch (err) {
        console.error("Cloudflare Workers AI translation failed, falling back to Google Translate:", err);
      }
    }
    // Fallback to Google Translate
    return translateMessage(text, srcLang, "uk");
  }

  /**
   * Translates multiple feed items in a single request using a separator.
   */
  async batchTranslate(items: FeedItem[], srcLang: string): Promise<FeedItem[]> {
    if (items.length === 0) return items;

    const separator = "\n\n===TR_SEP===\n\n";
    const textsToTranslate = items.map(item => {
      if (item.description && item.description.trim()) {
        return this.cleanDescription(item.description);
      }
      return this.cleanText(item.title);
    });

    const combined = textsToTranslate.join(separator);
    try {
      console.log(`[Batch Translation] Translating ${items.length} items in a single request...`);
      const translated = await this.translateText(combined, srcLang);
      
      // Split using regex to ignore case on TR_SEP
      const translations = translated.split(/===TR_SEP===/i).map(s => s.trim());
      
      if (translations.length === items.length) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.description && item.description.trim()) {
            item.translatedDescription = translations[i];
          } else {
            item.translatedTitle = translations[i];
          }
        }
        console.log(`[Batch Translation] Successfully batch-translated all ${items.length} items.`);
      } else {
        console.warn(`[Batch Translation] Expected ${items.length} translations, but got ${translations.length}. Falling back to individual translation.`);
      }
    } catch (err) {
      console.error("[Batch Translation] Failed:", err);
    }

    return items;
  }
}
