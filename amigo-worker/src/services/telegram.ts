import { translateMessage } from "./translate";

export interface FeedItem {
  title: string;
  link: string;
  description?: string;
  categories?: string[];
}

export class TelegramService {
  private token: string;
  private chatId: string;
  private ai?: any;
  private topicThreadMap: Record<string, number>;

  constructor(token: string, chatId: string, topicsConfig: any[], ai?: any) {
    this.token = token;
    this.chatId = chatId;
    this.ai = ai;
    
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
    const threadId = this.topicThreadMap[topic] || 0;
    const message = await this.formatMessage(item, lang);
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: this.chatId,
        message_thread_id: threadId,
        parse_mode: "HTML",
        text: message,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Telegram send failed (${response.status}): ${errorText}`);
    }
  }
  /**
   * Sends a raw HTML formatted string to the Telegram chat thread.
   */
  async sendRawMessage(topic: string, text: string): Promise<void> {
    const threadId = this.topicThreadMap[topic] || 0;
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: this.chatId,
        message_thread_id: threadId,
        parse_mode: "HTML",
        text: text,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Telegram send raw failed (${response.status}): ${errorText}`);
    }
  }

  private async formatMessage(item: FeedItem, lang: string): Promise<string> {
    const isWeb = await this.isWebsite(item.link);
    let titleHtml = `<a href="${item.link}">${item.title}</a>`;
    let body = "";

    if (item.description) {
      body += `${item.description}\n\n`;
    }

    if (item.categories && item.categories.length > 0) {
      body += `Категорія: ${item.categories.join(" | ")}\n\n`;
    }

    if (lang !== "uk") {
      const srcLang = lang || "sk";
      // Translate the body content
      let translatedBody = body;
      try {
        if (body.trim()) {
          translatedBody = await this.translateText(body, srcLang);
        }
      } catch (err) {
        console.error("Translation error:", err);
      }

      if (isWeb) {
        const translateUrl = `http://translate.google.com/translate?sl=${srcLang}&tl=uk&u=${encodeURIComponent(
          item.link
        )}&client=webapp/`;
        return `${titleHtml}\n\n<a href="${translateUrl}">${translatedBody || item.title}</a>`;
      } else {
        return `${titleHtml}\n\n${translatedBody}`;
      }
    }

    return `${titleHtml}\n\n${body}`;
  }

  private async isWebsite(url: string): Promise<boolean> {
    try {
      const response = await fetch(url, {
        method: "HEAD",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });
      if (response.ok) {
        const contentType = response.headers.get("content-type") || "";
        return contentType.includes("text/html") || contentType.includes("text/xhtml");
      }
    } catch (err) {
      console.warn(`isWebsite HEAD request failed for ${url}:`, err);
    }

    // Fallback: Check URL structure. If it has no typical binary extension, assume it is a webpage.
    const lowercaseUrl = url.toLowerCase();
    const binaryExtensions = [
      ".jpg", ".jpeg", ".png", ".gif", ".pdf", ".zip", ".rar", ".mp3", ".mp4", 
      ".avi", ".mov", ".docx", ".xlsx", ".pptx", ".epub", ".dmg", ".exe"
    ];
    return !binaryExtensions.some(ext => lowercaseUrl.endsWith(ext) || lowercaseUrl.includes(ext + "?"));
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
}
