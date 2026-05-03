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

function cleanUrl(url) {
  return String(url || "").split("?")[0].replace(/\/$/, "");
}

function decodeHtml(text = "") {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml,text/xml,*/*;q=0.8",
      "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });

  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return await res.text();
}

function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m
    ? decodeHtml(m[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim())
    : "";
}

function extractAttr(xml, tag, attr) {
  const m = xml.match(
    new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']+)["'][^>]*>`, "i")
  );
  return m ? decodeHtml(m[1]) : "";
}

function extractVideoId(entryXml) {
  const id = extractTag(entryXml, "yt:videoId") || extractTag(entryXml, "id");
  return id.replace("yt:video:", "").trim();
}

function channelIdFromUrl(url) {
  const feed = url.match(/[?&]channel_id=(UC[\w-]+)/i);
  if (feed) return feed[1];

  const direct = url.match(/youtube\.com\/channel\/(UC[\w-]+)/i);
  if (direct) return direct[1];

  return "";
}

function firstMatch(html, patterns) {
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1]) return m[1];
  }
  return "";
}

async function resolveChannelId(url) {
  const cleaned = cleanUrl(url);

  const direct = channelIdFromUrl(cleaned);
  if (direct) return direct;

  const html = await fetchText(cleaned);

  const channelId = firstMatch(html, [
    /"externalId":"(UC[\w-]+)"/,
    /"browseId":"(UC[\w-]+)"/,
    /<meta itemprop="channelId" content="(UC[\w-]+)">/,
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]+)">/,
    /"canonicalBaseUrl":"\/channel\/(UC[\w-]+)"/,
    /"channelId":"(UC[\w-]+)"/,
    /\/channel\/(UC[\w-]+)/,
  ]);

  if (channelId) return channelId;

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

async function fetchRssFeed(source, channelId) {
  const urls = [
    `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
    `https://www.youtube.com/feeds/videos.xml?playlist_id=${uploadsPlaylistId(channelId)}`,
  ];

  let lastError = null;

  for (const feedUrl of urls) {
    try {
      const xml = await fetchText(feedUrl);
      const entries = [...xml.matchAll(/<entry[\s\S]*?<\/entry>/g)].map((m) => m[0]);

      if (!entries.length) throw new Error("RSS entry 0개");

      return entries.map((entry) => {
        const videoId = extractVideoId(entry);
        const link =
          extractAttr(entry, "link", "href") ||
          (videoId ? `https://www.youtube.com/watch?v=${videoId}` : "");

        return {
          name: source.name,
          type: source.type,
          channelId,
          channelTitle: extractTag(entry, "name") || source.name,
          title: extractTag(entry, "title"),
          url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : link,
          videoId,
          thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "",
          publishedAt: extractTag(entry, "published"),
          updatedAt: extractTag(entry, "updated"),
          sourceMethod: "rss",
        };
      });
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error("RSS 실패");
}

function extractJsonObjectFromHtml(html, marker) {
  const idx = html.indexOf(marker);
  if (idx < 0) return null;

  const start = html.indexOf("{", idx);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < html.length; i++) {
    const ch = html[i];

    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }

  return null;
}

function textFromRuns(obj) {
  if (!obj) return "";
  if (obj.simpleText) return obj.simpleText;
  if (Array.isArray(obj.runs)) return obj.runs.map((r) => r.text || "").join("");
  return "";
}

function walkVideoRenderers(obj, out = []) {
  if (!obj || typeof obj !== "object") return out;

  const keys = [
    "videoRenderer",
    "gridVideoRenderer",
    "compactVideoRenderer",
    "playlistVideoRenderer",
    "reelItemRenderer",
  ];

  for (const key of keys) {
    if (obj[key] && obj[key].videoId) {
      out.push(obj[key]);
    }
  }

  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) {
      for (const item of v) walkVideoRenderers(item, out);
    } else if (v && typeof v === "object") {
      walkVideoRenderers(v, out);
    }
  }

  return out;
}

function titleFromRenderer(v) {
  return (
    textFromRuns(v.title) ||
    textFromRuns(v.headline) ||
    textFromRuns(v.accessibility?.accessibilityData) ||
    ""
  );
}

function publishedTextFromRenderer(v) {
  return (
    textFromRuns(v.publishedTimeText) ||
    textFromRuns(v.shortBylineText) ||
    ""
  );
}

function addHtmlRegexVideos(html, source, channelId, unique) {
  const ids = [...html.matchAll(/"videoId":"([^"]{11})"/g)].map((m) => m[1]);
  const seen = new Set();

  for (const videoId of ids) {
    if (seen.has(videoId)) continue;
    seen.add(videoId);
    if (unique.has(videoId)) continue;

    unique.set(videoId, {
      name: source.name,
      type: source.type,
      channelId,
      channelTitle: source.name,
      title: "",
      url: `https://www.youtube.com/watch?v=${videoId}`,
      videoId,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      publishedAt: "",
      updatedAt: "",
      publishedText: "",
      sourceMethod: "videos-page-regex",
    });
  }
}

async function fetchVideosPage(source, channelId) {
  const base = cleanUrl(source.url);
  const videosUrl = base.includes("/videos") ? base : `${base}/videos`;

  const html = await fetchText(videosUrl);
  const jsonText = extractJsonObjectFromHtml(html, "ytInitialData");
  const unique = new Map();

  if (jsonText) {
    const data = JSON.parse(jsonText);
    const renderers = walkVideoRenderers(data);

    for (const v of renderers) {
      const videoId = v.videoId;
      if (!videoId || unique.has(videoId)) continue;

      const title = titleFromRenderer(v);
      const thumbs = v.thumbnail?.thumbnails || [];
      const thumbnail =
        thumbs.length > 0
          ? thumbs[thumbs.length - 1].url
          : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

      unique.set(videoId, {
        name: source.name,
        type: source.type,
        channelId,
        channelTitle: source.name,
        title,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        videoId,
        thumbnail,
        publishedAt: "",
        updatedAt: "",
        publishedText: publishedTextFromRenderer(v),
        sourceMethod: "videos-page",
      });
    }
  }

  if (!unique.size) {
    addHtmlRegexVideos(html, source, channelId, unique);
  }

  const items = [...unique.values()];
  if (!items.length) throw new Error("/videos 페이지에서 영상 0개");

  return items;
}

async function fetchFeed(source) {
  const channelId = await resolveChannelId(source.url);
  const playlistId = uploadsPlaylistId(channelId);

  console.log(`${source.name} url=${cleanUrl(source.url)}`);
  console.log(`${source.name} channelId=${channelId}`);
  console.log(`${source.name} playlistId=${playlistId}`);

  try {
    const items = await fetchRssFeed(source, channelId);
    console.log(`${source.name} RSS 성공: ${items.length}개`);
    return items;
  } catch (rssError) {
    console.log(`${source.name} RSS 실패, videos 페이지 fallback: ${rssError.message}`);
    const items = await fetchVideosPage(source, channelId);
    console.log(`${source.name} videos 페이지 성공: ${items.length}개`);
    return items;
  }
}

function readPreviousItems() {
  if (!fs.existsSync(OUTPUT_FILE)) return [];

  try {
    const prev = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf8"));
    return Array.isArray(prev.items) ? prev.items : [];
  } catch {
    return [];
  }
}

async function main() {
  const raw = fs.readFileSync(SOURCE_FILE, "utf8");
  const data = JSON.parse(raw);
  const sources = normalizeSources(data);

  const previousItems = readPreviousItems();
  const allItems = [];
  const errors = [];

  if (!sources.length) {
    errors.push({ message: "youtube-sources.json에서 소스를 찾지 못했습니다." });
  }

  for (const source of sources) {
    try {
      const items = await fetchFeed(source);

      if (!items.length) throw new Error("영상 0개");

      allItems.push(...items);
      console.log(`OK ${source.name}: ${items.length}개`);
    } catch (err) {
      console.log(`FAIL ${source.name}: ${err.message}`);

      const oldItems = previousItems.filter((item) => item.name === source.name);

      if (oldItems.length) {
        allItems.push(...oldItems);
        console.log(`KEEP ${source.name}: 기존 데이터 ${oldItems.length}개 유지`);
      } else {
        errors.push({ source, message: err.message });
      }
    }
  }

  const unique = new Map();

  for (const item of allItems) {
    if (!item.videoId) continue;
    if (!unique.has(item.videoId)) unique.set(item.videoId, item);
  }

  const items = [...unique.values()].slice(0, MAX_ITEMS);

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