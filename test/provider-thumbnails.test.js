"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { deriveProviderThumbnail, youtubeVideoId } = require("../registry/provider-thumbnails.js");

const VIDEO_ID = "7lCDEYXw3mM";

test("supported YouTube video URLs derive one documented high thumbnail", () => {
  const urls = [
    `https://www.youtube.com/watch?v=${VIDEO_ID}&list=synthetic#player`,
    `https://music.youtube.com/watch?v=${VIDEO_ID}`,
    `https://youtu.be/${VIDEO_ID}?t=30`,
    `https://www.youtube.com/shorts/${VIDEO_ID}?feature=share`,
    `https://www.youtube.com/embed/${VIDEO_ID}`,
    `https://www.youtube.com/live/${VIDEO_ID}`
  ];
  for (const url of urls) {
    assert.equal(youtubeVideoId(url), VIDEO_ID);
    assert.deepEqual(deriveProviderThumbnail(url), {
      provider: "youtube",
      sourceKind: "provider_thumbnail",
      sourceUrl: `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`
    });
  }
});

test("ambiguous, invalid, credential-bearing, and non-YouTube URLs stay image-free", () => {
  for (const url of [
    "https://www.youtube.com/",
    "https://www.youtube.com/feed/subscriptions",
    "https://www.youtube.com/playlist?list=synthetic",
    "https://www.youtube.com/watch?list=synthetic",
    "https://www.youtube.com/watch?v=too-short",
    `https://www.youtube.com/watch?v=${VIDEO_ID}&v=abcdefghijk`,
    `https://youtu.be/${VIDEO_ID}/extra`,
    `https://www.youtube.com/channel/${VIDEO_ID}`,
    `https://www.youtube.com/v/${VIDEO_ID}`,
    `https://user:pass@www.youtube.com/watch?v=${VIDEO_ID}`,
    `https://youtube.example.test/watch?v=${VIDEO_ID}`,
    `https://example.test/watch?v=${VIDEO_ID}`,
    "not a URL"
  ]) {
    assert.equal(youtubeVideoId(url), null);
    assert.equal(deriveProviderThumbnail(url), null);
  }
});
