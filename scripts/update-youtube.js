const fs = require("fs");

const SOURCE_FILE = "data/youtube-sources.json";
const OUTPUT_FILE = "youtube.json";
const MAX_ITEMS = 24;

function nowKST() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
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
  const match = xml.match(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i")
  );
  return match
    ? decodeHtml(
        match[1]
          .replace(/^<!\[CDATA\[/, "")
          .replace(/\]\]>$/, "")
          .trim()
      )
    : "";
}

function extractAttr(xml, tag, attr) {
  const match = xml.match(
    new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']+)["'][^>]*>`, "i")
  );
  return match ? decodeHtml(match[1]) : "";
}

function extractVideoId(entryXml) {
  const id = extractTag(entryXml, "yt:videoId") || extractTag(entryXml, "id");
  return id.replace("yt:video:", "").trim();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "application/xml,text/xml,text/html,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return await res.text();
}

function channelIdFromUrl(url) {
  const feed = url.match(/[?&]channel_id=(UC[\w-]+)/i);
  if (feed) return feed[1];

  const direct = url.match(/youtube\.com\/channel\/(UC[\w-]+)/i);
  if (direct) return direct[1];

  return "";
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

  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1];
  }

  throw new Error(`채널 ID 못찾음: ${url}`);
}
function uploadsPlaylistId(channelId) {
  return "UU" + channelId.replace(/^UC/, "");
}

function normalizeSources(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.sources)) return data.sources;
  return [];
}

async function fetchFeed(source) {
  const channelId = await resolveChannelId(source.url);
  const playlistId = uploadsPlaylistId(channelId);

  console.log(`${source.name} channelId=${channelId}`);
  console.log(`${source.name} playlistId=${playlistId}`);

  const feedUrl = `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistId}`;
  const xml = await fetchText(feedUrl);

  const entries = [...xml.matchAll(/<entry[\s\S]*?<\/entry>/g)].map(
    (m) => m[0]
  );

  return entries.map((entry) => {
    const videoId = extractVideoId(entry);
    const link =
      extractAttr(entry, "link", "href") ||
      (videoId ? `https://www.youtube.com/watch?v=${videoId}` : "");

    return {
      name: source.name,
      type: source.type,
      channelId,
      title: extractTag(entry, "title"),
      url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : link,
      videoId,
      thumbnail: videoId
        ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
        : "",
      publishedAt: extractTag(entry, "published"),
      updatedAt: extractTag(entry, "updated"),
    };
  });
}

async function main() {
  const raw = fs.readFileSync(SOURCE_FILE, "utf8");
  const data = JSON.parse(raw);
  const sources = normalizeSources(data);

  const allItems = [];
  const errors = [];

  for (const source of sources) {
    try {
      const items = await fetchFeed(source);
      allItems.push(...items);
      console.log(`OK ${source.name}: ${items.length}개`);
    } catch (err) {
      console.log(`FAIL ${source.name}: ${err.message}`);
      errors.push({ source, message: err.message });
    }
  }

  const unique = new Map();

  for (const item of allItems) {
    if (!item.videoId) continue;
    if (!unique.has(item.videoId)) {
      unique.set(item.videoId, item);
    }
  }

  const items = [...unique.values()]
    .sort(
      (a, b) =>
        new Date(b.publishedAt || b.updatedAt || 0) -
        new Date(a.publishedAt || a.updatedAt || 0)
    )
    .slice(0, MAX_ITEMS);

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(
      {
        checkedAt: nowKST(),
        count: items.length,
        items,
        errors,
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(`youtube.json 생성 완료: ${items.length}개`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});