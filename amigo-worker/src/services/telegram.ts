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
  private topicThreadMap: Record<string, number>;

  constructor(token: string, chatId: string) {
    this.token = token;
    this.chatId = chatId;
    // Map topics to their respective Telegram thread IDs
    this.topicThreadMap = {
      news: 1, // Default topic thread IDs
      immigration: 2,
      charity: 3,
      travel: 11,
      events: 12,
      ukraine: 301,
      health: 8,
      // User can add more topic -> thread ID mapping here
    };
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
          translatedBody = await translateMessage(body, srcLang, "uk");
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
      const contentType = response.headers.get("content-type") || "";
      return contentType.includes("text/html") || contentType.includes("text/xhtml");
    } catch {
      return false;
    }
  }
}
