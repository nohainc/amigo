import { XMLParser } from "fast-xml-parser";
import { FeedItem } from "./telegram";
import { trackedFetch } from "../utils/tracker";

export async function parseFeed(url: string): Promise<FeedItem[]> {
  const response = await trackedFetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AmigoTelegramBot/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch feed from ${url}: ${response.statusText}`);
  }

  const xmlText = await response.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  
  const jsonObj = parser.parse(xmlText);
  const items: FeedItem[] = [];

  // Parse RSS 2.0
  if (jsonObj.rss?.channel) {
    const channel = jsonObj.rss.channel;
    const rawItems = Array.isArray(channel.item)
      ? channel.item
      : channel.item
      ? [channel.item]
      : [];

    for (const item of rawItems) {
      let categories: string[] = [];
      if (item.category) {
        categories = Array.isArray(item.category)
          ? item.category.map((c: any) => typeof c === "string" ? c : c["#text"] || "")
          : [typeof item.category === "string" ? item.category : item.category["#text"] || ""];
      }

      const published = parsePublishedDate(item.pubDate || item["dc:date"] || item.date);

      items.push({
        title: typeof item.title === "string" ? item.title : item.title?.["#text"] || "Untitled",
        link: item.link || "",
        description: item.description || "",
        categories: categories.filter(Boolean),
        publishedAt: published?.publishedAt,
        publishedTimestamp: published?.publishedTimestamp,
      });
    }
  } 
  // Parse Atom
  else if (jsonObj.feed) {
    const rawEntries = Array.isArray(jsonObj.feed.entry)
      ? jsonObj.feed.entry
      : jsonObj.feed.entry
      ? [jsonObj.feed.entry]
      : [];

    for (const entry of rawEntries) {
      let link = "";
      if (entry.link) {
        if (Array.isArray(entry.link)) {
          const alternateLink = entry.link.find((l: any) => l["@_rel"] === "alternate");
          link = alternateLink ? alternateLink["@_href"] : entry.link[0]["@_href"];
        } else {
          link = entry.link["@_href"] || "";
        }
      }

      let categories: string[] = [];
      if (entry.category) {
        categories = Array.isArray(entry.category)
          ? entry.category.map((c: any) => c["@_term"] || "")
          : [entry.category["@_term"] || ""];
      }

      const published = parsePublishedDate(entry.published || entry.updated || entry["dc:date"]);

      items.push({
        title: typeof entry.title === "string" ? entry.title : entry.title?.["#text"] || "Untitled",
        link: link,
        description: entry.summary || entry.content || "",
        categories: categories.filter(Boolean),
        publishedAt: published?.publishedAt,
        publishedTimestamp: published?.publishedTimestamp,
      });
    }
  }

  return items;
}

function parsePublishedDate(value: unknown): { publishedAt: string; publishedTimestamp: number } | undefined {
  const rawDate = typeof value === "string" ? value : (value as any)?.["#text"];
  if (!rawDate) return undefined;

  const timestamp = Date.parse(rawDate);
  if (!Number.isFinite(timestamp)) return undefined;

  return {
    publishedAt: new Date(timestamp).toISOString(),
    publishedTimestamp: timestamp,
  };
}

export async function isLinkValid(url: string): Promise<boolean> {
  try {
    const response = await trackedFetch(url, {
      method: "HEAD",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });
    return response.status >= 200 && response.status < 400;
  } catch {
    try {
      const getResponse = await trackedFetch(url, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });
      return getResponse.status >= 200 && getResponse.status < 400;
    } catch {
      return false;
    }
  }
}
