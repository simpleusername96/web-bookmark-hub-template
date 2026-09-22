((root) => {
  // Keep site support data-oriented so most extraction tweaks live here rather
  // than expanding the control flow inside `content-script.js`.
  const PINTEREST_TEMPLATE = {
    id: "pinterest-pin-grid",
    label: "Pinterest pin grid",
    hostSuffixes: ["pinterest.com"],
    unsupportedMessage: "이 페이지는 아직 사용할 수 있는 Pinterest 템플릿이 없어요.",
    reservedPathPrefixes: [
      "_",
      "pin",
      "ideas",
      "business"
    ],
    gridPathRegex: /^\/search\/pins\/?$/,
    detailPathRegex: /^\/pin\/\d+\/?$/,
    cardSelectors: [
      "a[href*='/pin/'][aria-label]",
      "[data-test-id='pin'] a[href*='/pin/'][aria-label]",
      "[data-test-id='pinWrapper'] a[href*='/pin/'][aria-label]",
      "[role='group'][aria-label='Pin card'] a[href*='/pin/'][aria-label]",
      "[aria-label='Pin card'] a[href*='/pin/'][aria-label]"
    ],
    cardContainerSelectors: [
      "[data-test-id='pin']",
      "[data-test-id='pinWrapper']",
      "[data-test-id='pin-with-alt-text']",
      "[data-test-id='deeplink-wrapper']",
      "[role='group'][aria-label='Pin card']",
      "[aria-label='Pin card']",
      "[role='listitem']"
    ],
    cardDateSelectors: [],
    cardMediaSelectors: [
      "img[src*='pinimg.com']",
      "video"
    ],
    detailRootSelectors: [
      "main [data-test-id='pin']",
      "div[role='dialog'] [data-test-id='pin']",
      "main"
    ],
    detailPermalinkSelectors: [
      "a[href*='/pin/']"
    ],
    detailAccountSelectors: [],
    detailDateSelectors: [],
    detailMediaSelectors: [
      "img[src*='pinimg.com']",
      "video"
    ]
  };

  const X_MEDIA_TEMPLATE = {
    id: "x-media",
    label: "X media",
    hostSuffixes: ["x.com", "twitter.com"],
    unsupportedMessage: "X에서 media 카드가 아직 안 보이거나 `/media` 경로가 현재 세션에서 막혀 있어요. 프로필 메인에서 다시 Start 하거나 잠시 기다린 뒤 Scan now를 눌러보세요.",
    reservedPathPrefixes: [
      "compose",
      "explore",
      "home",
      "i",
      "intent",
      "login",
      "messages",
      "notifications",
      "search",
      "settings",
      "signup"
    ],
    gridPathRegex: /^\/([^/?#]+)(?:\/media)?\/?$/,
    detailPathRegex: /^\/([^/?#]+)\/status\/\d+(?:\/(?:photo|video)\/\d+)?\/?$/,
    strictGridPath: true,
    requireCardsForGrid: true,
    allowGridPathWithoutCards: true,
    cardSelectors: [
      "article[data-testid='tweet'] a[href*='/photo/']",
      "article[data-testid='tweet'] a[href*='/video/']",
      "article[data-testid='tweet'] a[href*='/status/']:not([href*='/analytics'])",
      "article[role='article'] a[href*='/photo/']",
      "article[role='article'] a[href*='/video/']",
      "article[role='article'] a[href*='/status/']:not([href*='/analytics'])"
    ],
    cardContainerSelectors: [
      "article[data-testid='tweet']",
      "article[role='article']"
    ],
    cardDateSelectors: [
      "time[datetime]",
      "time"
    ],
    cardMediaSelectors: [
      "a[href*='/photo/'] img",
      "img[src*='pbs.twimg.com/media/']",
      "img[src*='twimg.com/media/']",
      "img[src*='amplify_video_thumb']",
      "video"
    ],
    detailRootSelectors: [
      "[aria-label='Timeline: Conversation'] article[data-testid='tweet']"
    ],
    detailPermalinkSelectors: [
      "time[datetime]",
      "a[href*='/status/'][aria-label]"
    ],
    detailAccountSelectors: [
      "a[href^='/']:not([href*='/status/']):not([href*='/photo/']):not([href*='/video/']):not([href*='/analytics'])"
    ],
    detailDateSelectors: [
      "time[datetime]",
      "time"
    ],
    detailMediaSelectors: [
      "a[href*='/photo/'] img",
      "img[src*='pbs.twimg.com/media/']",
      "img[src*='twimg.com/media/']",
      "img[src*='amplify_video_thumb']",
      "video"
    ]
  };

  // Repo-local experiments can append templates without modifying the shipped
  // defaults above.
  const customTemplates = Array.isArray(root.ACCUM_CAPTURE_CUSTOM_TEMPLATES)
    ? root.ACCUM_CAPTURE_CUSTOM_TEMPLATES
    : [];

  root.ACCUM_CAPTURE_TEMPLATES = [
    PINTEREST_TEMPLATE,
    X_MEDIA_TEMPLATE,
    ...customTemplates
  ];
})(globalThis);
