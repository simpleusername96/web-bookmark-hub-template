"use strict";

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function deriveProviderThumbnail(value) {
  const videoId = youtubeVideoId(value);
  if (!videoId) return null;
  return {
    provider: "youtube",
    sourceKind: "provider_thumbnail",
    sourceUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
  };
}

function youtubeVideoId(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  let candidate = "";
  if (hostname === "youtu.be") {
    const segments = url.pathname.split("/").filter(Boolean);
    candidate = segments.length === 1 ? segments[0] : "";
  } else if (hostname === "youtube.com" || hostname.endsWith(".youtube.com")) {
    if (/^\/watch\/?$/iu.test(url.pathname)) {
      const videoIds = url.searchParams.getAll("v");
      candidate = videoIds.length === 1 ? videoIds[0] : "";
    } else {
      const match = /^\/(?:shorts|embed|live)\/([^/]+)\/?$/iu.exec(url.pathname);
      candidate = match?.[1] || "";
    }
  }
  return YOUTUBE_VIDEO_ID.test(candidate) ? candidate : null;
}

module.exports = { deriveProviderThumbnail, youtubeVideoId };
