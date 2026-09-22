(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.WBHCaptureTagSuggestions = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Add optional URL-derived tag suggestions for your own workflow here.
  function fromUrl() { return []; }
  return { fromUrl };
}));
