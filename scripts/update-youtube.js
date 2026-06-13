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

function extractVideoId(entryXml) {
  const id =
    extractTag(entryXml, "yt:videoId") ||
    extractTag(entryXml, "id");

  return id.replace("yt:video:", "");
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 YouTube feed updater",
      "accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language":
        "ko-KR,ko;q=0.9,en-US;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText}`
    );
  }

  return await response.text();
}

function channelIdFromUrl(url) {
  const direct = url.match(
    /youtube\.com\/channel\/(UC[\w-]+)/i
  );

  return direct ? direct[1] : "";
}

function playlistIdFromUrl(url = "") {
  try {
    const parsed = new URL(url);

    return parsed.searchParams.get("list") || "";
  } catch {
    const match = String(url).match(
      /[?&]list=([\w-]+)/i
    );

    return match ? match[1] : "";
  }
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

  throw new Error(
    `채널 ID를 찾지 못했습니다: ${url}`
  );
}

//////////////////////////////////////////////////////
// 시간 통일용
//////////////////////////////////////////////////////

function timeAgo(dateString) {
  const date = new Date(dateString);

  if (Number.isNaN(date.getTime())) return "";

  const diff = Math.max(
    0,
    Math.floor((new Date() - date) / 1000)
  );

  const minute = 60;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;

  if (diff < minute) return "방금 전";

  if (diff < hour) {
    return `${Math.floor(diff / minute)}분 전`;
  }

  if (diff < day) {
    return `${Math.floor(diff / hour)}시간 전`;
  }

  if (diff < week) {
    return `${Math.floor(diff / day)}일 전`;
  }

  if (diff < month) {
    return `${Math.floor(diff / week)}주 전`;
  }

  if (diff < year) {
    return `${Math.floor(diff / month)}개월 전`;
  }

  return `${Math.floor(diff / year)}년 전`;
}

function extractAgeText(publishedText = "") {
  const parts = String(
    publishedText || ""
  ).split("•");

  return cleanText(
    parts[parts.length - 1] || publishedText
  );
}

//////////////////////////////////////////////////////
// RSS
//////////////////////////////////////////////////////

async function fetchFeed(source) {
  const channelId = await resolveChannelId(
    source.url
  );

  const feedUrl =
    `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

  const xml = await fetchText(feedUrl);

  const entries = [
    ...xml.matchAll(/<entry[\s\S]*?<\/entry>/g),
  ].map((m) => m[0]);

  return entries.map((entry) => {
    const videoId = extractVideoId(entry);

    const channelTitle =
      extractTag(entry, "name") ||
      source.name;

    const publishedAt =
      extractTag(entry, "published");

    const displayDate =
      timeAgo(publishedAt);

    return {
      source: "youtube",
      sourceMethod: "rss",

      name: source.name,
      type: source.type,

      channelId,
      channelTitle,

      title: extractTag(entry, "title"),

      url: videoId
        ? `https://www.youtube.com/watch?v=${videoId}`
        : extractTag(entry, "link"),

      videoId,

      thumbnail: videoId
        ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
        : "",

      publishedAt,

      updatedAt: extractTag(
        entry,
        "updated"
      ),

      displayDate,

      displayMeta:
        `${channelTitle} · ${displayDate}`,
    };
  });
}

//////////////////////////////////////////////////////
// 캄린이
//////////////////////////////////////////////////////

function parseBalancedJsonFrom(html, startIndex) {
  const openIndex = html.indexOf("{", startIndex);

  if (openIndex < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = openIndex; i < html.length; i++) {
    const ch = html[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") depth++;

    if (ch === "}") {
      depth--;

      if (depth === 0) {
        return html.slice(openIndex, i + 1);
      }
    }
  }

  return null;
}

function extractInitialData(html) {
  const markers = [
    "var ytInitialData =",
    "window[\"ytInitialData\"] =",
    "window['ytInitialData'] =",
    "ytInitialData =",
  ];

  for (const marker of markers) {
    const index = html.indexOf(marker);

    if (index < 0) continue;

    const jsonText = parseBalancedJsonFrom(html, index + marker.length);

    if (!jsonText) continue;

    try {
      return JSON.parse(jsonText);
    } catch {
      // 다음 패턴 계속 시도
    }
  }

  return null;
}

function findVideoItems(
  obj,
  results = []
) {
  if (!obj || typeof obj !== "object") {
    return results;
  }

  if (obj.playlistVideoRenderer) {
    results.push(obj.playlistVideoRenderer);
  }

  for (const value of Object.values(obj)) {
    if (
      value &&
      typeof value === "object"
    ) {
      findVideoItems(value, results);
    }
  }

  return results;
}

function getText(obj) {
  if (!obj) return "";

  if (
    typeof obj.simpleText === "string"
  ) {
    return cleanText(obj.simpleText);
  }

  if (Array.isArray(obj.runs)) {
    return cleanText(
      obj.runs
        .map((r) => r.text || "")
        .join("")
    );
  }

  return "";
}

function getThumbnail(
  thumbnails = []
) {
  if (!thumbnails.length) return "";

  return (
    thumbnails[thumbnails.length - 1]
      ?.url || ""
  );
}

function itemFromFeedEntry(entry, playlist, playlistId, sourceMeta = {}) {
  const videoId = extractVideoId(entry);

  if (!videoId) return null;

  const channelTitle =
    extractTag(entry, "name") ||
    sourceMeta.channelTitle ||
    sourceMeta.name ||
    "캄린이";

  const itemName =
    sourceMeta.name ||
    playlist.name ||
    "캄린이";

  const itemType =
    sourceMeta.type ||
    playlist.type ||
    "kamrini";

  const playlistTitle =
    playlist.title ||
    sourceMeta.playlistTitle ||
    sourceMeta.name ||
    playlistId;

  const publishedAt = extractTag(entry, "published");
  const displayDate = timeAgo(publishedAt);

  return {
    source: "youtube",
    sourceMethod: "playlist-rss",

    name: itemName,
    type: itemType,

    channelTitle,
    playlistYear: playlist.year || "",
    playlistTitle,

    videoId,
    title: extractTag(entry, "title"),

    publishedAt,
    updatedAt: extractTag(entry, "updated"),

    publishedText: displayDate,
    lengthText: "",
    displayDate,
    displayMeta: `${channelTitle} · ${displayDate}`,

    url: `https://www.youtube.com/watch?v=${videoId}`,
    link: `https://www.youtube.com/watch?v=${videoId}&list=${playlistId}`,
    embedUrl: `https://www.youtube.com/embed/${videoId}`,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}

async function fetchPlaylistFeed(playlist, playlistId, sourceMeta = {}) {
  const feedUrl =
    `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistId}`;

  const xml = await fetchText(feedUrl);

  const entries = [
    ...xml.matchAll(/<entry[\s\S]*?<\/entry>/g),
  ].map((m) => m[0]);

  const seen = new Set();

  return entries
    .map((entry) => itemFromFeedEntry(entry, playlist, playlistId, sourceMeta))
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item.videoId)) return false;
      seen.add(item.videoId);
      return true;
    });
}

function estimatePublishedAtFromText(
  publishedText = "",
  baseDate = new Date(),
  index = 0
) {
  const date = new Date(baseDate);

  const match = String(
    publishedText || ""
  ).match(
    /(\d+(?:\.\d+)?)\s*(초|분|시간|일|주|개월|년)\s*전/
  );

  if (match) {
    const amount = Number(match[1]);

    const unit = match[2];

    if (unit === "초") {
      date.setSeconds(
        date.getSeconds() - amount
      );
    }

    if (unit === "분") {
      date.setMinutes(
        date.getMinutes() - amount
      );
    }

    if (unit === "시간") {
      date.setHours(
        date.getHours() - amount
      );
    }

    if (unit === "일") {
      date.setDate(
        date.getDate() - amount
      );
    }

    if (unit === "주") {
      date.setDate(
        date.getDate() - amount * 7
      );
    }

    if (unit === "개월") {
      date.setMonth(
        date.getMonth() - amount
      );
    }

    if (unit === "년") {
      date.setFullYear(
        date.getFullYear() - amount
      );
    }
  }

  date.setSeconds(
    date.getSeconds() - index
  );

  return date.toISOString();
}

async function fetchPlaylist(
  playlist,
  playlistIndex = 0,
  sourceMeta = {}
) {
  const playlistId =
    playlist.id ||
    playlist.playlistId ||
    playlistIdFromUrl(playlist.url);

  if (!playlistId) {
    throw new Error(
      `플레이리스트 ID를 찾지 못했습니다: ${playlist.url || playlist.title || "unknown"}`
    );
  }

  const playlistTitle =
    playlist.title ||
    sourceMeta.playlistTitle ||
    sourceMeta.name ||
    playlistId;

  const itemName =
    sourceMeta.name || "캄린이";

  const itemType =
    sourceMeta.type || "kamrini";

  const channelTitle =
    sourceMeta.channelTitle ||
    itemName;

  console.log(
    `📡 ${playlistTitle} 수집중...`
  );

  try {
    const feedItems = await fetchPlaylistFeed(
      playlist,
      playlistId,
      sourceMeta
    );

    if (feedItems.length) {
      console.log(
        `✅ ${playlistTitle}: RSS ${feedItems.length}개`
      );

      return feedItems;
    }

    console.log(
      `⚠️ ${playlistTitle}: RSS 0개, HTML fallback 시도`
    );
  } catch (error) {
    console.log(
      `⚠️ ${playlistTitle}: RSS 실패(${error.message}), HTML fallback 시도`
    );
  }

  const url =
    `https://www.youtube.com/playlist?list=${playlistId}`;

  const html = await fetchText(url);

  const data =
    extractInitialData(html);

  if (!data) {
    console.log(
      `❌ ${playlistTitle}: ytInitialData 없음`
    );

    return [];
  }

  const rawItems =
    findVideoItems(data);

  const seen = new Set();

  const baseDate = new Date();

  const items = rawItems
    .map((v, index) => {
      const videoId = v.videoId;

      if (
        !videoId ||
        seen.has(videoId)
      ) {
        return null;
      }

      seen.add(videoId);

      const title = getText(v.title);

      const publishedText =
        getText(v.videoInfo) || "";

      const lengthText =
        getText(v.lengthText);

      const thumbnail =
        getThumbnail(
          v.thumbnail?.thumbnails || []
        );

      const displayDate =
        extractAgeText(
          publishedText
        );

      return {
        source: "youtube",

        sourceMethod: "playlist",

        name: itemName,

        type: itemType,

        channelTitle,

        playlistYear:
          playlist.year || "",

        playlistTitle,

        videoId,

        title,

        publishedAt:
          estimatePublishedAtFromText(
            publishedText,
            baseDate,
            playlistIndex * 1000 +
              index
          ),

        updatedAt:
          new Date().toISOString(),

        publishedText,

        lengthText,

        displayDate,

        displayMeta:
          `${channelTitle} · ${displayDate}`,

        url:
          `https://www.youtube.com/watch?v=${videoId}`,

        link:
          `https://www.youtube.com/watch?v=${videoId}&list=${playlistId}`,

        embedUrl:
          `https://www.youtube.com/embed/${videoId}`,

        thumbnail:
          thumbnail ||
          `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      };
    })
    .filter(Boolean);

  console.log(
    `✅ ${playlistTitle}: ${items.length}개`
  );

  return items;
}

//////////////////////////////////////////////////////
// MAIN
//////////////////////////////////////////////////////

async function main() {
  const data = JSON.parse(
    fs.readFileSync(
      SOURCE_FILE,
      "utf8"
    )
  );

  const allItems = [];

  const errors = [];

  //////////////////////////////////////////////////////
  // RSS
  //////////////////////////////////////////////////////

  for (
    let i = 0;
    i < (data.sources || []).length;
    i++
  ) {
    const source = data.sources[i];

    try {
      const playlistId =
        source.playlistId ||
        playlistIdFromUrl(source.url);

      const items = playlistId
        ? await fetchPlaylist(
            {
              ...source,
              id: playlistId,
              title: source.name,
            },
            i,
            {
              name: source.name,
              type: source.type,
              channelTitle: source.name,
            }
          )
        : await fetchFeed(source);

      allItems.push(...items);

      console.log(
        `OK ${source.name} ${source.type}: ${items.length}개`
      );
    } catch (error) {
      console.log(
        `FAIL ${source.name} ${source.type}: ${error.message}`
      );

      errors.push({
        source,
        message: error.message,
      });
    }
  }

  //////////////////////////////////////////////////////
  // 캄린이
  //////////////////////////////////////////////////////

  for (
    let i = 0;
    i <
    (data.kamriniPlaylists ||
      []).length;
    i++
  ) {
    const playlist =
      data.kamriniPlaylists[i];

    try {
      const items =
        await fetchPlaylist(
          playlist,
          i
        );

      allItems.push(...items);
    } catch (error) {
      console.log(
        `FAIL KAMRINI ${playlist.title}: ${error.message}`
      );

      errors.push({
        source: playlist,
        message: error.message,
      });
    }
  }

  //////////////////////////////////////////////////////
  // 중복 제거
  //////////////////////////////////////////////////////

  const unique = new Map();

  for (const item of allItems) {
    if (!item.videoId) continue;

    if (!unique.has(item.videoId)) {
      unique.set(
        item.videoId,
        item
      );
    }
  }

  //////////////////////////////////////////////////////
  // 정렬
  //////////////////////////////////////////////////////

  const items = [
    ...unique.values(),
  ]
    .sort((a, b) => {
      return (
        new Date(
          b.publishedAt ||
            b.updatedAt
        ) -
        new Date(
          a.publishedAt ||
            a.updatedAt
        )
      );
    })
    .slice(0, MAX_ITEMS);

  //////////////////////////////////////////////////////
  // 저장
  //////////////////////////////////////////////////////

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

  console.log(
    `youtube.json 생성 완료: ${items.length}개`
  );
}

main().catch((error) => {
  console.error(error);

  process.exit(1);
});
