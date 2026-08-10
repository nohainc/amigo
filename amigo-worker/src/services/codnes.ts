import { FeedItem } from "./telegram";
import { trackedFetch } from "../utils/tracker";

export interface CodnesEventDetails {
  imageUrl?: string;
  eventPlace?: string;
  eventStartAt?: string;
  eventEndAt?: string;
}

export function isCodnesUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return hostname === "codnes.sk";
  } catch {
    return false;
  }
}

export async function enrichCodnesEvent(item: FeedItem): Promise<FeedItem> {
  if (!isCodnesUrl(item.link)) {
    return item;
  }

  const response = await trackedFetch(item.link, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AmigoTelegramBot/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Codnes event from ${item.link}: ${response.statusText}`);
  }

  const details = parseCodnesEventHtml(await response.text());
  return { ...item, ...details };
}

export function parseCodnesEventHtml(html: string): CodnesEventDetails {
  return {
    imageUrl: extractImageUrl(html),
    eventPlace: extractPlace(html),
    eventStartAt: extractTime(html, "startDate"),
    eventEndAt: extractTime(html, "endDate"),
  };
}

function extractImageUrl(html: string): string | undefined {
  const figureMatch = html.match(/<figure\b[^>]*itemprop=["']image["'][\s\S]*?<\/figure>/i);
  const source = figureMatch?.[0] || html;
  return cleanAttribute(
    matchAttribute(source, /<img\b[^>]*itemprop=["']url["'][^>]*>/i, "src") ||
      matchAttribute(source, /<img\b[^>]*src=["'][^"']+["'][^>]*itemprop=["']url["'][^>]*>/i, "src")
  );
}

function extractPlace(html: string): string | undefined {
  const locationMatch = html.match(/<[^>]+itemprop=["']location["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
  return cleanText(locationMatch?.[1]);
}

function extractTime(html: string, itemprop: "startDate" | "endDate"): string | undefined {
  const timeTag =
    html.match(new RegExp(`<time\\b[^>]*itemprop=["']${itemprop}["'][^>]*>`, "i"))?.[0] ||
    html.match(new RegExp(`<time\\b[^>]*datetime=["'][^"']+["'][^>]*itemprop=["']${itemprop}["'][^>]*>`, "i"))?.[0];

  return cleanAttribute(timeTag ? matchAttribute(timeTag, /<time\b[^>]*>/i, "datetime") : undefined);
}

function matchAttribute(source: string, tagPattern: RegExp, attribute: string): string | undefined {
  const tag = source.match(tagPattern)?.[0];
  if (!tag) return undefined;

  const attributeMatch = tag.match(new RegExp(`${attribute}=["']([^"']+)["']`, "i"));
  return attributeMatch?.[1];
}

function cleanAttribute(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return decodeHtml(value.trim()) || undefined;
}

function cleanText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = decodeHtml(value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim());
  return text || undefined;
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
