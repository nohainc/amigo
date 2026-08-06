import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outputDir = resolve(root, ".tmp-kv");

function hash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

async function readFeedsConfig() {
  const feedsNano = await readFile(resolve(root, "src/feeds.nano"), "utf8");

  const feeds = [];
  let current = null;

  for (const rawLine of feedsNano.split("\n")) {
    const line = rawLine.trim();
    if (line === "..") {
      if (current?.link) feeds.push(current);
      current = {};
      continue;
    }

    if (!current || line.startsWith("#") || !line) continue;
    const match = line.match(/^(\w+)\s+(.+)$/);
    if (!match) continue;

    const [, key, value] = match;
    current[key] = value === "true" ? true : value === "false" ? false : value;
  }

  if (current?.link) feeds.push(current);
  return feeds.filter((feed) => feed.active);
}

function extractLinks(xmlText) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  const jsonObj = parser.parse(xmlText);
  const links = [];

  if (jsonObj.rss?.channel) {
    const rawItems = Array.isArray(jsonObj.rss.channel.item)
      ? jsonObj.rss.channel.item
      : jsonObj.rss.channel.item
      ? [jsonObj.rss.channel.item]
      : [];

    for (const item of rawItems) {
      if (typeof item.link === "string" && item.link) links.push(item.link);
    }
  } else if (jsonObj.feed) {
    const rawEntries = Array.isArray(jsonObj.feed.entry)
      ? jsonObj.feed.entry
      : jsonObj.feed.entry
      ? [jsonObj.feed.entry]
      : [];

    for (const entry of rawEntries) {
      let link = "";
      if (Array.isArray(entry.link)) {
        const alternateLink = entry.link.find((candidate) => candidate["@_rel"] === "alternate");
        link = alternateLink ? alternateLink["@_href"] : entry.link[0]?.["@_href"];
      } else if (entry.link) {
        link = entry.link["@_href"] || "";
      }
      if (link) links.push(link);
    }
  }

  return [...new Set(links)];
}

function stringifyNanoArray(values) {
  const lines = [":"];
  for (const value of values) {
    lines.push(`    ${quoteNanoString(String(value))}`);
  }
  return lines.join("\n");
}

function quoteNanoString(value) {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

async function fetchFeedLinks(feed) {
  const response = await fetch(feed.link, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AmigoTelegramBot/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${feed.link}: ${response.status} ${response.statusText}`);
  }

  return extractLinks(await response.text());
}

const feeds = await readFeedsConfig();
const puts = [];

for (const feed of feeds) {
  const links = await fetchFeedLinks(feed);
  const feedHash = hash(feed.link);
  puts.push({ key: `snapshot:${feedHash}`, value: stringifyNanoArray(links) });
  puts.push({ key: `recent:${feedHash}`, value: stringifyNanoArray([]) });
  console.log(`${feed.link} -> ${links.length} snapshot links`);
}

await mkdir(outputDir, { recursive: true });
await writeFile(resolve(outputDir, "snapshot-put.json"), JSON.stringify(puts, null, 2));
console.log(`Prepared ${puts.length} KV records in ${resolve(outputDir, "snapshot-put.json")}`);
