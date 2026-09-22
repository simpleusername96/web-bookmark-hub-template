"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { routeEvidence } = require("../enrichment/evidence-route.js");
const { extractPublicEvidence, fetchPublicEvidence } = require("../enrichment/public-evidence.js");

test("exact URL shapes route to one saved object without trusting lookalike hosts", () => {
  assert.equal(routeEvidence("https://x.com/artist/status/123/photo/2").kind, "x_post");
  assert.equal(routeEvidence("https://x.com.evil.test/artist/status/123").kind, "generic");
  assert.equal(routeEvidence("https://www.coupang.com/vp/products/123?itemId=9").kind, "product");
  assert.equal(routeEvidence("https://arxiv.org/pdf/2501.12345.pdf").fetchUrl, "https://arxiv.org/abs/2501.12345");
  assert.equal(routeEvidence("https://www.youtube.com/watch?v=dQw4w9WgXcQ").kind, "youtube");
  assert.equal(routeEvidence("https://chatgpt.com/share/example").kind, "chat_share");
  assert.equal(routeEvidence("https://chatgpt.com/c/private").kind, "chat_private");
  assert.equal(routeEvidence("https://bsky.app/profile/artist.test/post/abc").kind, "social_post");
});

test("X original post yields its first image, not avatar or reply and not a tab title", () => {
  const evidence = extractPublicEvidence(`
    <meta property="og:url" content="https://x.com/artist/status/123">
    <meta property="og:title" content="X">
    <img src="https://cdn.test/site-logo.jpg">
    <article><a href="/artist/status/123">Original</a>
      <p data-testid="tweetText">짧은 원글 내용</p>
      <img alt="Profile avatar" src="https://cdn.test/avatar.jpg">
      <img src="https://cdn.test/first.jpg"><img src="https://cdn.test/second.jpg">
    </article>
    <article><a href="/other/status/456">Reply</a><img src="https://cdn.test/reply.jpg"></article>
  `, "https://x.com/artist/status/123");
  assert.equal(evidence.kind, "x_post");
  assert.equal(evidence.sufficient, true);
  assert.match(evidence.content, /짧은 원글 내용/);
  assert.doesNotMatch(evidence.content, /Reply/);
  assert.equal(evidence.image_url, "https://cdn.test/first.jpg");
  assert.equal(evidence.title, null);
});

test("GIF-as-video uses the original post poster and never a video URL", () => {
  const evidence = extractPublicEvidence(`
    <meta property="og:description" content="Animated scene in a saved post">
    <article><a href="/artist/status/123">Post</a>
      <video src="https://cdn.test/clip.mp4" poster="https://cdn.test/first-poster.jpg"></video>
      <img src="https://cdn.test/later.jpg">
    </article>
  `, "https://x.com/artist/status/123");
  assert.equal(evidence.image_url, "https://cdn.test/first-poster.jpg");
  assert.equal(evidence.media_kind, "video");
});

test("a lone unrelated article and unverified social metadata never become saved-post evidence", () => {
  const evidence = extractPublicEvidence(`
    <meta property="og:title" content="A different post">
    <meta property="og:description" content="Unverified text">
    <meta property="og:image" content="https://cdn.test/unrelated.jpg">
    <article><a href="/other/status/456">Other post</a><img src="https://cdn.test/reply.jpg"></article>
  `, "https://x.com/artist/status/123");
  assert.equal(evidence.sufficient, false);
  assert.equal(evidence.image_url, null);
});

test("an unrelated social article is not treated as the saved post", () => {
  const evidence = extractPublicEvidence(`
    <meta property="og:title" content="A social site">
    <article><a href="/other/post/456">Other post</a><img src="https://cdn.test/other.jpg"></article>
  `, "https://bsky.app/profile/artist.test/post/abc");
  assert.equal(evidence.sufficient, false);
  assert.equal(evidence.image_url, null);
});

test("exact post metadata permits a single GIF/video poster without article markup", () => {
  const evidence = extractPublicEvidence(`
    <meta property="og:url" content="https://x.com/artist/status/123">
    <meta property="og:description" content="A short animated scene">
    <video poster="https://cdn.test/first.jpg" src="https://cdn.test/video.mp4"></video>
  `, "https://x.com/artist/status/123");
  assert.equal(evidence.sufficient, true);
  assert.equal(evidence.image_url, "https://cdn.test/first.jpg");
});

test("profile-only metadata is not treated as exact-post text", () => {
  const evidence = extractPublicEvidence(`
    <meta property="og:url" content="https://x.com/artist/status/123">
    <meta property="og:title" content="Artist (@artist) on X">
    <meta property="og:description" content="Artist (@artist) on X">
    <meta property="og:image" content="https://cdn.test/post-art.jpg">
  `, "https://x.com/artist/status/123");
  assert.equal(evidence.sufficient, false);
  assert.equal(evidence.reason, "AI_EVIDENCE_INSUFFICIENT");
  assert.equal(evidence.content, null);
  assert.equal(evidence.image_url, "https://cdn.test/post-art.jpg");
});

test("X video thumbnail metadata remains a still image reference with video provenance", () => {
  const evidence = extractPublicEvidence(`
    <meta property="og:url" content="https://x.com/artist/status/123">
    <meta property="og:description" content="A short video post">
    <meta property="og:image" content="https://pbs.twimg.com/amplify_video_thumb/456/img/preview?format=webp">
  `, "https://x.com/artist/status/123");
  assert.equal(evidence.image_url, "https://pbs.twimg.com/amplify_video_thumb/456/img/preview?format=webp");
  assert.equal(evidence.media_kind, "video");
});

test("selected product variants require an exact structured entity", () => {
  const url = "https://www.coupang.com/vp/products/123?itemId=9";
  const generic = extractPublicEvidence('<meta property="og:title" content="Product in another variant">', url);
  assert.equal(generic.sufficient, false);
  const verified = extractPublicEvidence(`
    <script type="application/ld+json">{"@type":"Product","url":"${url}","name":"Exact variant"}</script>
  `, url);
  assert.equal(verified.sufficient, true);
  assert.equal(verified.title, "Exact variant");
});

test("arXiv abstract and a public chat main body stay bounded", () => {
  const paper = extractPublicEvidence(`
    <h1 class="title mathjax">Title: Concrete paper</h1>
    <blockquote class="abstract mathjax"><span>Abstract:</span> A method with a measured result.</blockquote>
  `, "https://arxiv.org/abs/2501.12345");
  assert.equal(paper.kind, "arxiv");
  assert.equal(paper.title, "Concrete paper");
  assert.match(paper.content, /method with a measured result/);

  const chat = extractPublicEvidence("<title>Shared chat</title><main><p>A concrete question and answer.</p></main>",
    "https://chatgpt.com/share/example");
  assert.equal(chat.kind, "chat_share");
  assert.match(chat.content, /concrete question/);
});

test("a guarded PDF response supplies only bounded transient bytes for page-one reading", async () => {
  const bytes = Buffer.from("%PDF-1.7\nsynthetic first-page fixture\n");
  const response = (body, type = "application/pdf") => Object.assign(Readable.from([body]), {
    statusCode: 200, headers: { "content-type": type, "content-length": String(body.length) }
  });
  const options = {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async () => response(bytes)
  };
  const evidence = await fetchPublicEvidence("https://papers.example.test/work.pdf", options);
  assert.equal(evidence.kind, "pdf");
  assert.equal(evidence.content_source, "pdf_first_page");
  assert.equal(evidence.content, null);
  assert.deepEqual(evidence.pdf_bytes, bytes);
  await assert.rejects(fetchPublicEvidence("https://papers.example.test/work.pdf", {
    ...options, request: async () => response(Buffer.from("not a PDF"))
  }), { code: "AI_EVIDENCE_PDF_INVALID" });
});
