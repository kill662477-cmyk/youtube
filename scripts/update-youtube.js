const fs = require("fs");

const SOURCE_FILE = "data/youtube-sources.json";
const OUTPUT_FILE = "youtube.json";
const MAX_ITEMS = 9;

function nowKST() {
  const date = new Date();
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
  return parts;
}

function decodeHtml(text = "") {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeHtml(match[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim()) : "";
}

function extractVideoId(entryXml) {
  const id = extractTag(entryXml, "yt:videoId") || extractTag(entryXml, "id");
  return id.replace("yt:video:", "");
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 YouTube feed updater",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return await response.text();
}

function channelIdFromUrl(url) {
  const direct = url.match(/youtube\.com\/channel\/(UC[\w-]+)/i);
  return direct ? direct[1] : "";
}

async function resolveChannelId(url) {
  const direct = channelIdFromUrl(url);
  if (direct) return direct;

  const html = await fetchText(url);
  const patterns = [
    /"channelId":"(UC[\w-]+)"/,
    /"externalId":"(UC[\w-]+)"/,
    /<meta itemprop="channelId" content="(UC[\w-]+)">/,
    /\/channel\/(UC[\w-]+)/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }

  throw new Error(`채널 ID를 찾지 못했습니다: ${url}`);
}

async function fetchFeed(source) {
  const channelId = await resolveChannelId(source.url);
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const xml = await fetchText(feedUrl);
  const entries = [...xml.matchAll(/<entry[\s\S]*?<\/entry>/g)].map(m => m[0]);

  return entries.map((entry) => {
    const videoId = extractVideoId(entry);
    return {
      name: source.name,
      type: source.type,
      channelId,
      channelTitle: extractTag(entry, "name") || source.name,
      title: extractTag(entry, "title"),
      url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : extractTag(entry, "link"),
      videoId,
      thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "",
      publishedAt: extractTag(entry, "published"),
      updatedAt: extractTag(entry, "updated"),
    };
  });
}

async function main() {
  const data = JSON.parse(fs.readFileSync(SOURCE_FILE, "utf8"));
  const allItems = [];
  const errors = [];

  for (const source of data.sources || []) {
    try {
      const items = await fetchFeed(source);
      allItems.push(...items);
      console.log(`OK ${source.name} ${source.type}: ${items.length}개`);
    } catch (error) {
      console.log(`FAIL ${source.name} ${source.type}: ${error.message}`);
      errors.push({ source, message: error.message });
    }
  }

  const unique = new Map();
  for (const item of allItems) {
    if (!item.videoId) continue;
    if (!unique.has(item.videoId)) unique.set(item.videoId, item);
  }

  const items = [...unique.values()]
    .sort((a, b) => new Date(b.publishedAt || b.updatedAt) - new Date(a.publishedAt || a.updatedAt))
    .slice(0, MAX_ITEMS);

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
    checkedAt: nowKST(),
    count: items.length,
    items,
    errors,
  }, null, 2), "utf8");

  console.log(`youtube.json 생성 완료: ${items.length}개`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
