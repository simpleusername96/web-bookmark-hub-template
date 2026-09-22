(function exposeIcons(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBHIcons = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createIcons(root) {
  'use strict';
  const paths = {
    "close": [
      "M6 6l12 12M18 6 6 18"
    ],
    "remove": [
      "M6 6l12 12M18 6 6 18"
    ],
    "previous": [
      "m14 6-6 6 6 6"
    ],
    "next": [
      "m10 6 6 6-6 6"
    ],
    "chevron": [
      "m9 5 7 7-7 7"
    ],
    "down": [
      "m6 9 6 6 6-6"
    ],
    "external": [
      "M14 4h6v6M20 4l-9 9",
      "M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"
    ],
    "edit": [
      "m15 4 5 5-11 11H4v-5L15 4Z",
      "m12 7 5 5"
    ],
    "done": [
      "m5 12 4 4L19 6"
    ],
    "delete": [
      "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"
    ],
    "cover": [
      "M4 5h16v14H4z",
      "m7 15 3-3 3 3 2-2 3 3"
    ],
    "clearCover": [
      "M4 5h16v14H4z",
      "M5 19 19 5"
    ],
    "folder": [
      "M3 7V5h6l2 2h10v12H3V7Z"
    ],
    "tags": [
      "M3 4h8l10 10-7 7L3 10V4Z",
      "M7 8h.01"
    ],
    "more": [
      "M5 12h.01M12 12h.01M19 12h.01"
    ],
    "type": [
      "M4 5h16M12 5v15M8 20h8"
    ],
    "lock": [
      "M5 10h14v11H5V10Z",
      "M8 10V7a4 4 0 0 1 8 0v3"
    ],
    "ai": [
      "M4 6h16M4 12h16M4 18h10"
    ],
    "filter": [
      "M4 6h16M7 12h10M10 18h4"
    ],
    "home": [
      "m3 11 9-8 9 8M5 9v12h14V9M10 21v-7h4v7"
    ],
    "sidebar": [
      "M3 4h18v16H3V4ZM9 4v16"
    ],
    "settings": [
      "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8",
      "M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z"
    ],
    "collapse": [
      "m8 4 4 4 4-4M5 12h14m-11 8 4-4 4 4"
    ],
    "search": [
      "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14",
      "m15 15 6 6"
    ],
    "up": [
      "m6 15 6-6 6 6"
    ]
  };

  function create(name, documentRef) {
    const doc = documentRef || root.document;
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    (paths[name] || paths.more).forEach(function appendPath(data) {
      const path = doc.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', data);
      svg.append(path);
    });
    return svg;
  }

  function mount(documentRef) {
    documentRef.querySelectorAll('[data-icon]').forEach(function replaceIcon(node) {
      node.replaceChildren(create(node.dataset.icon, documentRef));
    });
  }
  return { create, mount };
}));
