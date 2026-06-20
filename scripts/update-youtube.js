const fs = require("fs");

const SOURCE_FILE = "data/youtube-sources.json";
const OUTPUT_FILE = "youtube.json";
const MAX_ITEMS = 60;
const FETCH_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const RETRYABLE_STATUS = new Set([
  408,
  429,
  500,
  502,
  503,
  504,
]);

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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchText(url, options = {}) {
  const retries =
    options.retries ?? FETCH_RETRIES;

  let lastError = null;

  for (
    let attempt = 0;
    attempt <= retries;
    attempt++
  ) {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0 YouTube feed updater",
          "accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language":
            "ko-KR,ko;q=0.9,en-US;q=0.8",
        },
      });

      if (response.ok) {
        return await response.text();
      }

      lastError = new Error(
        `${response.status} ${response.statusText}`
      );

      if (
        !RETRYABLE_STATUS.has(
          response.status
        ) ||
        attempt === retries
      ) {
        lastError.retryable = false;
        throw lastError;
      }
    } catch (error) {
      lastError = error;

      if (
        error.retryable === false ||
        attempt === retries
      ) {
        throw lastError;
      }
    }

    console.log(
      `WARN fetch retry ${attempt + 1}/${retries}: ${url} (${lastError.message})`
    );

    await sleep(
      RETRY_DELAY_MS * (attempt + 1)
    );
  }

  throw lastError;
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

function getYoutubeVideoId(url = "") {
  const text = String(url || "");
  const patterns = [
    /youtube\.com\/watch\?v=([^&#?/]+)/i,
    /youtu\.be\/([^&#?/]+)/i,
    /youtube\.com\/shorts\/([^&#?/]+)/i,
    /youtube\.com\/embed\/([^&#?/]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match) return match[1];
  }

  try {
    const parsed = new URL(text);

    return parsed.searchParams.get("v") || "";
  } catch {
    return "";
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

function channelVideosUrl(sourceUrl, channelId) {
  try {
    const parsed = new URL(sourceUrl);

    if (
      /\/(?:videos|shorts|streams)\/?$/i.test(
        parsed.pathname
      )
    ) {
      return sourceUrl;
    }

    parsed.pathname =
      parsed.pathname.replace(/\/+$/, "") +
      "/videos";

    return parsed.toString();
  } catch {
    return channelId
      ? `https://www.youtube.com/channel/${channelId}/videos`
      : sourceUrl;
  }
}

async function fetchChannelPage(
  source,
  channelId
) {
  const pageUrl = channelVideosUrl(
    source.url,
    channelId
  );

  const html = await fetchText(pageUrl);

  const data = extractInitialData(html);

  if (!data) {
    console.log(
      `❌ ${source.name}: ytInitialData 없음`
    );

    return [];
  }

  const seen = new Set();

  const baseDate = new Date();

  const items = findVideoItems(data)
    .map((renderer, index) => {
      return itemFromPageRenderer(
        renderer,
        {
          sourceMethod: "channel-page",
          name: source.name,
          type: source.type,
          channelId,
          channelTitle: source.name,
          baseDate,
        },
        index
      );
    })
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item.videoId)) return false;
      seen.add(item.videoId);
      return true;
    });

  console.log(
    `✅ ${source.name}: 채널 페이지 ${items.length}개`
  );

  return items;
}

function mergeVideoItems(...groups) {
  const merged = [];
  const seen = new Set();

  groups.flat().forEach((item) => {
    if (!item || !item.videoId || seen.has(item.videoId)) return;

    seen.add(item.videoId);
    merged.push(item);
  });

  return merged;
}

function uploadsPlaylistIdFromChannelId(channelId = "") {
  return /^UC[\w-]+$/i.test(channelId)
    ? `UU${channelId.slice(2)}`
    : "";
}

async function fetchUploadsPlaylistPage(source, channelId) {
  const playlistId = uploadsPlaylistIdFromChannelId(channelId);

  if (!playlistId) return [];

  return await fetchPlaylist(
    {
      id: playlistId,
      title: `${source.name} 업로드`,
      method: "page",
    },
    0,
    {
      name: source.name,
      type: source.type,
      channelId,
      channelTitle: source.name,
      playlistTitle: `${source.name} 업로드`,
      method: "page",
    }
  );
}

async function fetchFeed(source) {
  const channelId = await resolveChannelId(
    source.url
  );

  const feedUrl =
    `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

  try {
    const xml = await fetchText(feedUrl);

    const entries = [
      ...xml.matchAll(/<entry[\s\S]*?<\/entry>/g),
    ].map((m) => m[0]);

    if (!entries.length) {
      console.log(
        `⚠️ ${source.name}: RSS 0개, 페이지 fallback 시도`
      );

      const pageItems = await fetchChannelPage(
        source,
        channelId
      ).catch(() => []);

      if (source.method !== "page") return pageItems;

      const uploadItems = await fetchUploadsPlaylistPage(
        source,
        channelId
      ).catch((error) => {
        console.log(
          `⚠️ ${source.name}: 업로드 플레이리스트 실패(${error.message})`
        );
        return [];
      });

      return mergeVideoItems(
        pageItems,
        uploadItems
      );
    }

    const rssItems = entries.map((entry) => {
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
    }).filter((item) => item.videoId);

    // 일반 채널 RSS는 최신 15개만 내려준다.
    // method:"page" 소스는 RSS에서 끝내지 않고 채널 탭 + 업로드 플레이리스트(UU...)까지 병합한다.
    if (source.method !== "page") return rssItems;

    const pageItems = await fetchChannelPage(
      source,
      channelId
    ).catch((error) => {
      console.log(
        `⚠️ ${source.name}: 채널 페이지 실패(${error.message})`
      );
      return [];
    });

    const uploadItems = await fetchUploadsPlaylistPage(
      source,
      channelId
    ).catch((error) => {
      console.log(
        `⚠️ ${source.name}: 업로드 플레이리스트 실패(${error.message})`
      );
      return [];
    });

    const merged = mergeVideoItems(
      rssItems,
      pageItems,
      uploadItems
    );

    console.log(
      `✅ ${source.name}: RSS ${rssItems.length} + 페이지 ${pageItems.length} + 업로드 ${uploadItems.length} → ${merged.length}개`
    );

    return merged.length ? merged : rssItems;
  } catch (error) {
    console.log(
      `⚠️ ${source.name}: RSS 실패(${error.message}), 페이지 fallback 시도`
    );

    const pageItems = await fetchChannelPage(
      source,
      channelId
    ).catch(() => []);

    if (source.method !== "page") return pageItems;

    const uploadItems = await fetchUploadsPlaylistPage(
      source,
      channelId
    ).catch((uploadError) => {
      console.log(
        `⚠️ ${source.name}: 업로드 플레이리스트 실패(${uploadError.message})`
      );
      return [];
    });

    return mergeVideoItems(
      pageItems,
      uploadItems
    );
  }
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

  if (obj.videoRenderer) {
    results.push(obj.videoRenderer);
  }

  if (obj.gridVideoRenderer) {
    results.push(obj.gridVideoRenderer);
  }

  if (obj.playlistVideoRenderer) {
    results.push(obj.playlistVideoRenderer);
  }

  if (obj.reelItemRenderer) {
    results.push(obj.reelItemRenderer);
  }

  if (
    obj.lockupViewModel &&
    obj.lockupViewModel.contentType ===
      "LOCKUP_CONTENT_TYPE_VIDEO"
  ) {
    results.push(obj.lockupViewModel);
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

function getContentText(obj) {
  if (!obj) return "";

  if (typeof obj === "string") {
    return cleanText(obj);
  }

  if (typeof obj.content === "string") {
    return cleanText(obj.content);
  }

  return getText(obj);
}

function getVideoId(renderer) {
  return (
    renderer.videoId ||
    renderer.contentId ||
    renderer.navigationEndpoint
      ?.watchEndpoint?.videoId ||
    renderer.rendererContext
      ?.commandContext?.onTap
      ?.innertubeCommand?.watchEndpoint
      ?.videoId ||
    ""
  );
}

function getRendererTitle(renderer) {
  return (
    getText(renderer.title) ||
    getContentText(renderer.title) ||
    getContentText(
      renderer.metadata
        ?.lockupMetadataViewModel?.title
    ) ||
    getText(renderer.headline) ||
    ""
  );
}

function getLockupMetadataParts(renderer) {
  const rows =
    renderer.metadata
      ?.lockupMetadataViewModel
      ?.metadata
      ?.contentMetadataViewModel
      ?.metadataRows || [];

  return rows
    .flatMap((row) => {
      return row.metadataParts || [];
    })
    .map((part) => {
      return (
        getContentText(part.text) ||
        cleanText(part.accessibilityLabel)
      );
    })
    .filter(Boolean);
}

function getPublishedText(renderer) {
  const direct =
    getText(renderer.publishedTimeText) ||
    getText(renderer.videoInfo);

  if (direct) return extractAgeText(direct);

  const metadataParts =
    getLockupMetadataParts(renderer);

  return (
    metadataParts.find((part) => {
      return /(?:방금|초|분|시간|일|주|개월|년)\s*전/.test(
        part
      );
    }) ||
    metadataParts[metadataParts.length - 1] ||
    ""
  );
}

function getRendererLengthText(renderer) {
  const direct =
    getText(renderer.lengthText) ||
    getContentText(renderer.lengthText);

  if (direct) return direct;

  const badges =
    renderer.contentImage
      ?.thumbnailViewModel?.overlays ||
    [];

  for (const overlay of badges) {
    const badge =
      overlay.thumbnailBottomOverlayViewModel
        ?.badges?.[0]
        ?.thumbnailBadgeViewModel;

    if (badge?.text) {
      return cleanText(badge.text);
    }
  }

  return "";
}

function getRendererThumbnail(
  renderer,
  videoId
) {
  const thumbnail =
    getThumbnail(
      renderer.thumbnail?.thumbnails ||
        renderer.contentImage
          ?.thumbnailViewModel?.image
          ?.sources ||
        []
    );

  if (thumbnail) return thumbnail;

  return videoId
    ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
    : "";
}

function itemFromPageRenderer(
  renderer,
  context = {},
  index = 0
) {
  const videoId = getVideoId(renderer);

  if (!videoId) return null;

  const itemName =
    context.name || "캄린이";

  const itemType =
    context.type || "kamrini";

  const channelTitle =
    context.channelTitle || itemName;

  const publishedText =
    getPublishedText(renderer);

  const displayDate =
    extractAgeText(publishedText);

  const publishedAt =
    estimatePublishedAtFromText(
      publishedText,
      context.baseDate || new Date(),
      (context.itemIndexBase || 0) + index
    );

  const playlistId =
    context.playlistId || "";

  return {
    source: "youtube",

    sourceMethod:
      context.sourceMethod || "page",

    name: itemName,

    type: itemType,

    channelId: context.channelId || "",

    channelTitle,

    playlistYear:
      context.playlistYear || "",

    playlistTitle:
      context.playlistTitle || "",

    videoId,

    title: getRendererTitle(renderer),

    publishedAt,

    updatedAt:
      new Date().toISOString(),

    publishedText,

    lengthText:
      getRendererLengthText(renderer),

    displayDate,

    displayMeta: displayDate
      ? `${channelTitle} · ${displayDate}`
      : channelTitle,

    url:
      `https://www.youtube.com/watch?v=${videoId}`,

    link: playlistId
      ? `https://www.youtube.com/watch?v=${videoId}&list=${playlistId}`
      : `https://www.youtube.com/watch?v=${videoId}`,

    embedUrl:
      `https://www.youtube.com/embed/${videoId}`,

    thumbnail:
      getRendererThumbnail(
        renderer,
        videoId
      ),
  };
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

    channelId:
      sourceMeta.channelId || "",
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

  const forcePage =
    playlist.method === "page" ||
    sourceMeta.method === "page";

  console.log(
    `📡 ${playlistTitle} 수집중...`
  );

  let feedItems = [];

  try {
    feedItems = await fetchPlaylistFeed(
      playlist,
      playlistId,
      sourceMeta
    );

    if (feedItems.length) {
      console.log(
        `✅ ${playlistTitle}: RSS ${feedItems.length}개`
      );

      if (!forcePage) {
        return feedItems;
      }

      console.log(
        `🔁 ${playlistTitle}: method=page라서 HTML 병합 시도`
      );
    } else {
      console.log(
        `⚠️ ${playlistTitle}: RSS 0개, HTML fallback 시도`
      );
    }
  } catch (error) {
    console.log(
      `⚠️ ${playlistTitle}: RSS 실패(${error.message}), HTML fallback 시도`
    );
  }

  const url =
    `https://www.youtube.com/playlist?list=${playlistId}`;

  let html = "";
  let data = null;

  try {
    html = await fetchText(url);
    data = extractInitialData(html);
  } catch (error) {
    console.log(
      `⚠️ ${playlistTitle}: HTML fetch 실패(${error.message})`
    );
  }

  if (!data) {
    console.log(
      `❌ ${playlistTitle}: ytInitialData 없음`
    );

    return feedItems;
  }

  const rawItems =
    findVideoItems(data);

  const seen = new Set();

  const baseDate = new Date();

  const pageItems = rawItems
    .map((v, index) => {
      const item = itemFromPageRenderer(
        v,
        {
          sourceMethod: "playlist-page",
          name: itemName,
          type: itemType,
          channelId:
            sourceMeta.channelId || "",
          channelTitle,
          playlistYear:
            playlist.year || "",
          playlistTitle,
          playlistId,
          baseDate,
          itemIndexBase:
            playlistIndex * 1000,
        },
        index
      );

      if (!item) {
        return null;
      }

      if (seen.has(item.videoId)) {
        return null;
      }

      seen.add(item.videoId);

      return item;
    })
    .filter(Boolean);

  const merged = mergeVideoItems(
    feedItems,
    pageItems
  );

  console.log(
    `✅ ${playlistTitle}: RSS ${feedItems.length} + HTML ${pageItems.length} → ${merged.length}개`
  );

  return merged.length ? merged : feedItems;
}
function itemFromManualVideo(
  video,
  index = 0
) {
  const videoId =
    video.videoId ||
    getYoutubeVideoId(
      video.url ||
        video.link ||
        video.embedUrl ||
        ""
    );

  if (!videoId) return null;

  const url =
    video.url ||
    video.link ||
    `https://www.youtube.com/watch?v=${videoId}`;

  const publishedAt =
    video.publishedAt ||
    video.published ||
    video.updatedAt ||
    new Date(
      Date.now() - index * 1000
    ).toISOString();

  const displayDate =
    video.displayDate ||
    video.publishedText ||
    timeAgo(publishedAt);

  const channelTitle =
    video.channelTitle ||
    video.name ||
    "캄린이";

  return {
    source: "youtube",
    sourceMethod: "manual",

    name: video.name || channelTitle,
    type: video.type || "kamrini",

    channelId: video.channelId || "",
    channelTitle,
    sourceTitle: video.sourceTitle || "",

    playlistYear: video.year || "",
    playlistTitle:
      video.playlistTitle || "",

    videoId,
    title: video.title || "",

    publishedAt,
    updatedAt:
      video.updatedAt ||
      new Date().toISOString(),

    publishedText: displayDate,
    lengthText: video.lengthText || "",
    displayDate,
    displayMeta:
      `${channelTitle} · ${displayDate}`,

    url,
    link: video.link || url,
    embedUrl:
      video.embedUrl ||
      `https://www.youtube.com/embed/${videoId}`,
    thumbnail:
      video.thumbnail ||
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
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
              channelId: source.channelId || "",
              channelTitle: source.name,
              method: source.method,
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
  // 수동 등록 영상
  //////////////////////////////////////////////////////

  const manualItems =
    (data.manualVideos || [])
      .map((video, index) => {
        return itemFromManualVideo(
          video,
          index
        );
      })
      .filter(Boolean);

  if (manualItems.length) {
    allItems.push(...manualItems);

    console.log(
      `OK manual videos: ${manualItems.length}개`
    );
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
