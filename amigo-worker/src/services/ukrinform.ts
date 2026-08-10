import { FeedItem } from "./telegram";
import { trackedFetch } from "../utils/tracker";

export function isUkrinformUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return hostname === "ukrinform.ua";
  } catch {
    return false;
  }
}

export async function enrichUkrinformNews(items: FeedItem[]): Promise<FeedItem[]> {
  const enrichedItems: FeedItem[] = [];

  for (const item of items) {
    enrichedItems.push(await enrichUkrinformNewsItem(item));
  }

  return enrichedItems;
}

export async function enrichUkrinformNewsItem(item: FeedItem): Promise<FeedItem> {
  if (!isUkrinformUrl(item.link)) {
    return item;
  }

  const response = await trackedFetch(item.link, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AmigoTelegramBot/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Ukrinform news from ${item.link}: ${response.statusText}`);
  }

  return {
    ...item,
    imageUrl: parseUkrinformImage(await response.text()) || item.imageUrl,
  };
}

export function parseUkrinformImage(html: string): string | undefined {
  const imageTag = html.match(/<img\b[^>]*class=["'][^"']*\bnewsImage\b[^"']*["'][^>]*>/i)?.[0];
  const src = imageTag?.match(/\bsrc=["']([^"']+)["']/i)?.[1];
  return decodeHtml(src?.trim() || "") || undefined;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'");
}
