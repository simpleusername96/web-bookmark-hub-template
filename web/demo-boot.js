(function configureDemo(root) {
  "use strict";
  root.WBH_CREATE_SOURCE = function createSyntheticSource() {
    if (!Array.isArray(root.WBH_DEMO_ENTRIES) || typeof root.createDemoSource !== "function") {
      throw new Error("Synthetic demo files are unavailable.");
    }
    return root.createDemoSource(root.WBH_DEMO_ENTRIES);
  };
}(typeof globalThis !== "undefined" ? globalThis : this));
