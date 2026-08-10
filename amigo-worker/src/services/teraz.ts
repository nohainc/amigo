import { FeedItem } from "./telegram";
import { trackedFetch } from "../utils/tracker";

export function isTerazUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return hostname === "teraz.sk";
  } catch {
    return false;
  }
}

export async function enrichTerazNews(items: FeedItem[]): Promise<FeedItem[]> {
  const enrichedItems: FeedItem[] = [];

  for (const item of items) {
    enrichedItems.push(await enrichTerazNewsItem(item));
  }

  return enrichedItems;
}

export async function enrichTerazNewsItem(item: FeedItem): Promise<FeedItem> {
  if (!isTerazUrl(item.link)) {
    return item;
  }

  const response = await trackedFetch(item.link, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AmigoTelegramBot/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Teraz news from ${item.link}: ${response.statusText}`);
  }

  return {
    ...item,
    imageUrl: parseTerazImage(await response.text()) || item.imageUrl,
  };
}

export function parseTerazImage(html: string): string | undefined {
  const articleImage = html.match(/<div\b[^>]*class=["'][^"']*\barticleImage\b[^"']*["'][^>]*>[\s\S]*?<\/div>/i)?.[0];
  const imageTag = articleImage?.match(/<img\b[^>]*>/i)?.[0];
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
