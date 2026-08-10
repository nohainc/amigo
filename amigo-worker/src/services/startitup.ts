import { FeedItem } from "./telegram";
import { trackedFetch } from "../utils/tracker";

export function isStartitupUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return hostname === "startitup.sk";
  } catch {
    return false;
  }
}

export async function enrichStartitupNews(items: FeedItem[]): Promise<FeedItem[]> {
  const enrichedItems: FeedItem[] = [];

  for (const item of items) {
    enrichedItems.push(await enrichStartitupNewsItem(item));
  }

  return enrichedItems;
}

export async function enrichStartitupNewsItem(item: FeedItem): Promise<FeedItem> {
  if (!isStartitupUrl(item.link)) {
    return item;
  }

  const response = await trackedFetch(item.link, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AmigoTelegramBot/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Startitup news from ${item.link}: ${response.statusText}`);
  }

  return {
    ...item,
    imageUrl: parseStartitupImage(await response.text()) || item.imageUrl,
  };
}

export function parseStartitupImage(html: string): string | undefined {
  const figure = html.match(/<figure\b[^>]*class=["'][^"']*\barticle__featured-image\b[^"']*["'][^>]*>[\s\S]*?<\/figure>/i)?.[0];
  const imageTag = figure?.match(/<img\b[^>]*>/i)?.[0];
  const srcset = getAttribute(imageTag, "srcset");
  return pickLargestSrcsetUrl(srcset) || getAttribute(imageTag, "src");
}

function pickLargestSrcsetUrl(srcset: string | undefined): string | undefined {
  if (!srcset) return undefined;

  const candidates = srcset
    .split(",")
    .map((entry) => {
      const [url, width] = entry.trim().split(/\s+/);
      return {
        url: decodeHtml(url || ""),
        width: Number.parseInt((width || "").replace(/\D/g, ""), 10) || 0,
      };
    })
    .filter((candidate) => candidate.url);

  candidates.sort((a, b) => b.width - a.width);
  return candidates[0]?.url;
}

function getAttribute(tag: string | undefined, attribute: string): string | undefined {
  const value = tag?.match(new RegExp(`\\b${attribute}=["']([^"']+)["']`, "i"))?.[1];
  return decodeHtml(value?.trim() || "") || undefined;
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
