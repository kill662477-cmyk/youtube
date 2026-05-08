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

function cleanText(text = "") {
  return String(text)
    .replace(/\\u0026/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
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
      "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

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

  const entries = [...xml.matchAll(/<entry[\s\S]*?<\/entry>/g)].map((m) => m[0]);

  return entries.map((entry) => {
    const videoId = extractVideoId(entry);

    return {
      source: "youtube",
      sourceMethod: "rss",
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

function extractInitialData(html) {
  const match = html.match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/);
  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function findVideoItems(obj, results = []) {
  if (!obj || typeof obj !== "object") return results;

  if (obj.playlistVideoRenderer) {
    results.push(obj.playlistVideoRenderer);
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      findVideoItems(value, results);
    }
  }

  return results;
}

function getText(obj) {
  if (!obj) return "";
  if (typeof obj.simpleText === "string") return cleanText(obj.simpleText);
  if (Array.isArray(obj.runs)) return cleanText(obj.runs.map((r) => r.text || "").join(""));
  return "";
}

function getThumbnail(thumbnails = []) {
  if (!thumbnails.length) return "";
  return thumbnails[thumbnails.length - 1]?.url || "";
}

function estimatePublishedAtFromText(publishedText = "", baseDate = new Date(), index = 0) {
  const date = new Date(baseDate);
  const match = String(publishedText || "").match(/(\d+(?:\.\d+)?)\s*(초|분|시간|일|주|개월|년)\s*전/);

  if (match) {
    const amount = Number(match[1]);
    const unit = match[2];

    if (unit === "초") date.setSeconds(date.getSeconds() - amount);
    if (unit === "분") date.setMinutes(date.getMinutes() - amount);
    if (unit === "시간") date.setHours(date.getHours() - amount);
    if (unit === "일") date.setDate(date.getDate() - amount);
    if (unit === "주") date.setDate(date.getDate() - amount * 7);
    if (unit === "개월") date.setMonth(date.getMonth() - amount);
    if (unit === "년") date.setFullYear(date.getFullYear() - amount);
  }

  date.setSeconds(date.getSeconds() - index);
  return date.toISOString();
}

async function fetchKamriniPlaylist(playlist, playlistIndex) {
  const url = `https://www.youtube.com/playlist?list=${playlist.id}`;

  console.log(`📡 ${playlist.title} 수집중...`);

  const html = await fetchText(url);
  const data = extractInitialData(html);

  if (!data) {
    console.log(`❌ ${playlist.title}: ytInitialData 없음`);
    return [];
  }

  const rawItems = findVideoItems(data);
  const seen = new Set();
  const baseDate = new Date();

  const items = rawItems
    .map((v, index) => {
      const videoId = v.videoId;
      if (!videoId || seen.has(videoId)) return null;

      seen.add(videoId);

      const title = getText(v.title);
      const publishedText = getText(v.videoInfo) || "";
      const lengthText = getText(v.lengthText);
      const thumbnail = getThumbnail(v.thumbnail?.thumbnails || []);

      return {
        source: "kamrini",
        sourceMethod: "playlist",
        name: "캄린이",
        type: "kamrini",
        channelTitle: "캄린이",
        playlistYear: playlist.year,
        playlistTitle: playlist.title,
        videoId,
        title,
        publishedAt: estimatePublishedAtFromText(
          publishedText,
          baseDate,
          playlistIndex * 1000 + index
        ),
        updatedAt: new Date().toISOString(),
        publishedText,
        lengthText,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        link: `https://www.youtube.com/watch?v=${videoId}&list=${playlist.id}`,
        embedUrl: `https://www.youtube.com/embed/${videoId}`,
        thumbnail: thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      };
    })
    .filter(Boolean);

  console.log(`✅ ${playlist.title}: ${items.length}개`);
  return items;
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

  for (let i = 0; i < (data.kamriniPlaylists || []).length; i++) {
    const playlist = data.kamriniPlaylists[i];

    try {
      const items = await fetchKamriniPlaylist(playlist, i);
      allItems.push(...items);
    } catch (error) {
      console.log(`FAIL KAMRINI ${playlist.title}: ${error.message}`);
      errors.push({ source: playlist, message: error.message });
    }
  }

  const unique = new Map();

  for (const item of allItems) {
    if (!item.videoId) continue;
    if (!unique.has(item.videoId)) unique.set(item.videoId, item);
  }

  const items = [...unique.values()]
    .sort((a, b) => {
      return new Date(b.publishedAt || b.updatedAt) - new Date(a.publishedAt || a.updatedAt);
    })
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
