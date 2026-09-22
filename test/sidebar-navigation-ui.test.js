"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const SidebarNavigation = require("../web/sidebar-navigation.js");

test("sidebar navigation defaults keep the first Folder level visible and URL roots compact", () => {
  assert.equal(SidebarNavigation.defaultExpanded("folder", 0), true);
  assert.equal(SidebarNavigation.defaultExpanded("folder", 1), false);
  assert.equal(SidebarNavigation.defaultExpanded("url_group", 0), false);
  assert.equal(
    SidebarNavigation.compactUrlLabel("github.com/openai/openai-node/issues?state=*"),
    "/openai-node/issues?state=*"
  );
});

test("empty structural sections default closed without overriding a later user choice", () => {
  const emptySection = { dataset: {}, open: true };
  SidebarNavigation.syncSectionDefault({ closest: () => emptySection }, false);
  assert.equal(emptySection.open, false);
  SidebarNavigation.syncSectionDefault({ closest: () => emptySection }, true);
  assert.equal(emptySection.open, false);

  const populatedSection = { dataset: {}, open: false };
  SidebarNavigation.syncSectionDefault({ closest: () => populatedSection }, true);
  assert.equal(populatedSection.open, true);
});

test("production and demo shells load the split-target sidebar implementation", () => {
  for (const file of ["index.html", "demo.html"]) {
    const html = fs.readFileSync(path.join(__dirname, "..", "web", file), "utf8");
    assert.match(html, /sidebar-navigation\.css\?v=navigation-6/);
    assert.match(html, /sidebar-navigation\.js\?v=clean-retrieval-1/);
    assert.match(html, /ui-language\.js\?v=cards-settings-2/);
    assert.doesNotMatch(html, /id="sidebar-tree-search"/);
    assert.match(html, /data-collapse-tree="folders"/);
    assert.match(html, /data-collapse-tree="url-groups"/);
    assert.match(html, /data-i18n-collapse-section="Folders"/);
    assert.match(html, /data-collapse-tree="folders"[^>]*data-icon="collapse"/);
    assert.doesNotMatch(html, />Collapse all</);
    assert.doesNotMatch(html, /<details class="nav-group" open>/);
    assert.match(html, /id="sidebar-mobile-close"/);
    assert.match(html, /id="sidebar-backdrop"/);
    assert.match(html, /placeholder="Search bookmarks…"/);
  }
});

test("sidebar implementation keeps disclosure and scope selection as separate controls", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "web", "sidebar-navigation.js"), "utf8");
  assert.match(source, /className = 'tree-toggle-improved'/);
  assert.match(source, /className = 'tree-select-improved'/);
  assert.match(source, /includesDescendants \? 'folder_descendants'/);
  assert.match(source, /closeMobileDrawer/);
  assert.match(source, /sidebar\.toggleAttribute\('inert', concealed\)/);
  assert.match(source, /mainContent\.toggleAttribute\('inert', narrow && open\)/);
  assert.match(source, /event\.key !== 'Tab'/);
  assert.match(source, /getElementById\('search-input'\)\?\.focus\(\)/);
  assert.doesNotMatch(source, /refreshTreeSearch|SEARCH_THRESHOLD|treeSearch/);
  assert.doesNotMatch(source, /folder\.name \+.*entry_count/);
  assert.match(source, /toggle\.textContent = ''/);
  assert.match(source, /syncSectionDefault\(folderTarget, settings\.error \|\| folders\.length > 0\)/);
  assert.match(source, /syncSectionDefault\(urlTarget, settings\.error \|\| urlGroups\.length > 0\)/);
});

test("selected sidebar rows keep their selected surface while hovering", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "web", "sidebar-navigation.css"), "utf8");
  assert.match(css, /\.tree-node-improved\.is-active:hover \{ color: var\(--surface\); background: var\(--ink\); \}/);
  assert.match(css, /\.tree-node-improved\.is-active \.tree-toggle-improved:hover:not\(:disabled\) \{ background: transparent; \}/);
});
