'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const View = require('../web/view.js');
const UiLanguage = require('../web/ui-language.js');

test('detail notes preserve text while presenting sentences and existing lists as points', function () {
  const { notePoints } = require('../web/detail-view.js');
  assert.deepEqual(notePoints(''), []);
  assert.deepEqual(notePoints('첫 번째 요약입니다. 두 번째 요약입니다.'), ['첫 번째 요약입니다.', '두 번째 요약입니다.']);
  assert.deepEqual(notePoints('- 첫 항목\n\n• 둘째 항목\n3. 셋째 항목'), ['첫 항목', '둘째 항목', '셋째 항목']);
  assert.deepEqual(notePoints('가격 3.14, https://example.test/a.b'), ['가격 3.14, https://example.test/a.b']);
  assert.deepEqual(notePoints('<img src=x onerror=alert(1)>'), ['<img src=x onerror=alert(1)>']);
});

test('sourceDisplayName turns registry source keys into compact human labels', function () {
  assert.equal(View.sourceDisplayName('youtube.com'), 'YouTube');
  assert.equal(View.sourceDisplayName('m.youtube.com'), 'YouTube');
  assert.equal(View.sourceDisplayName('youtu.be'), 'YouTube');
  assert.equal(View.sourceDisplayName('x.com'), 'Twitter');
  assert.equal(View.sourceDisplayName('twitter.com'), 'Twitter');
  assert.equal(View.sourceDisplayName('export.arxiv.org'), 'arXiv');
  assert.equal(View.sourceDisplayName('github.com'), 'GitHub');
  assert.equal(View.sourceDisplayName('youtube.example.test'), 'YouTube');
  assert.equal(View.sourceDisplayName('x.example.test'), 'Twitter');
  assert.equal(View.sourceDisplayName('arxiv.example.test'), 'arXiv');
  assert.equal(View.sourceDisplayName('notes.example.test'), 'Notes');
  assert.equal(View.sourceDisplayName('abcblog.com'), 'Abcblog');
});

test('sourceDisplayName also accepts provider keys used by the registry', function () {
  assert.equal(View.sourceDisplayName('youtube'), 'YouTube');
  assert.equal(View.sourceDisplayName('x'), 'Twitter');
  assert.equal(View.sourceDisplayName('chatgpt'), 'ChatGPT');
  assert.equal(View.sourceDisplayName('generic-web'), 'Generic Web');
});

test('unknown source and date labels follow the selected language', function () {
  try {
    UiLanguage.setLanguage('ko');
    assert.equal(View.sourceDisplayName(''), '출처를 알 수 없음');
    assert.equal(View.formatDate(null), '날짜를 알 수 없음');
    UiLanguage.setLanguage('en');
    assert.equal(View.sourceDisplayName(''), 'Unknown source');
    assert.equal(View.formatDate('not-a-date'), 'Date unknown');
  } finally {
    UiLanguage.setLanguage('en');
  }
});

test('coverUrl maps only renderable cover references and can ignore legacy content focus', function () {
  assert.equal(View.coverUrl({ content_focus: 'text', cover_image: { id: 2, storage_kind: 'local', status: 'ready' } }), null);
  assert.equal(View.coverUrl({ content_focus: 'visual', cover_image: { id: 2, storage_kind: 'local', status: 'ready' } }), '/api/v1/visual-assets/2/content');
  assert.equal(View.coverUrl({ content_focus: 'visual', cover_image: { id: 2, storage_kind: 'local', status: 'error' } }), null);
  assert.equal(View.coverUrl({ content_focus: 'visual', cover_image: { storage_kind: 'remote', status: 'referenced', source_url: 'https://images.example.test/a.jpg' } }), 'https://images.example.test/a.jpg');
  assert.equal(View.coverUrl({ content_focus: 'visual', cover_image: { storage_kind: 'remote', status: 'referenced', source_url: 'http://images.example.test/a.jpg' } }), null);
  assert.equal(View.coverUrl({ content_focus: 'visual', cover_image: { storage_kind: 'remote', status: 'referenced', source_url: 'data:image/png;base64,a' } }), null);
  assert.equal(View.coverUrl({ content_focus: 'text', cover_image: { storage_kind: 'remote', status: 'referenced', source_url: 'https://images.example.test/a.jpg' } }, { ignoreContentFocus: true }), 'https://images.example.test/a.jpg');
});

test('resultsRenderKey changes only when rendered result data or view changes', function () {
  const items = [{ id: 1, title: 'One', tags: [{ name: 'alpha' }] }];
  assert.equal(View.resultsRenderKey(items, 'grid'), View.resultsRenderKey(structuredClone(items), 'grid'));
  assert.notEqual(View.resultsRenderKey(items, 'grid'), View.resultsRenderKey(items, 'feed'));
  assert.notEqual(View.resultsRenderKey(items, 'grid'), View.resultsRenderKey([{ ...items[0], title: 'Changed' }], 'grid'));
});

test('paginationItems keeps the ends and one neighboring page on each side', function () {
  assert.deepEqual(View.paginationItems(1, 10), [1, 2, 'ellipsis', 10]);
  assert.deepEqual(View.paginationItems(5, 10), [1, 'ellipsis', 4, 5, 6, 'ellipsis', 10]);
  assert.deepEqual(View.paginationItems(10, 10), [1, 'ellipsis', 9, 10]);
  assert.deepEqual(View.paginationItems(2, 3), [1, 2, 3]);
  assert.deepEqual(View.paginationItems(1, 0), []);
});

test('nextSelection toggles one Entry and extends an inclusive anchored range', function () {
  const items = [1, 2, 3, 4, 5].map(function entry(id) { return { id: id }; });
  let next = View.nextSelection(items, new Set(), null, 3, { selected: true });
  assert.deepEqual([...next.selectedIds], [3]);
  assert.equal(next.anchorId, 3);
  next = View.nextSelection(items, next.selectedIds, next.anchorId, 3, { selected: false });
  assert.deepEqual([...next.selectedIds], []);
  next = View.nextSelection(items, new Set([2]), 2, 5, { shiftKey: true, selected: true });
  assert.deepEqual([...next.selectedIds], [2, 3, 4, 5]);
  assert.equal(next.anchorId, 2);
  next = View.nextSelection(items, new Set([1]), 99, 4, { shiftKey: true, selected: true });
  assert.deepEqual([...next.selectedIds], [1, 4]);
  assert.equal(next.anchorId, 4);
  next = View.nextSelection(items, new Set([1, 2]), 2, 5, { shiftKey: true, selected: true, maxSelected: 3 });
  assert.deepEqual([...next.selectedIds], [1, 2, 3]);
  assert.equal(next.limitReached, true);
  next = View.nextSelection(items, new Set([1, 2, 3]), 2, 4, { selected: true, maxSelected: 3 });
  assert.deepEqual([...next.selectedIds], [1, 2, 3]);
  assert.equal(next.anchorId, 2);
  assert.equal(next.limitReached, true);
});

test('production shell separates user Folders, URL structure, Add URL metadata, and Chrome pairing', function () {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const demoHtml = fs.readFileSync(path.join(__dirname, '..', 'web', 'demo.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  const settings = fs.readFileSync(path.join(__dirname, '..', 'web', 'settings-controller.js'), 'utf8');
  const view = fs.readFileSync(path.join(__dirname, '..', 'web', 'view.js'), 'utf8');
  const resultsView = fs.readFileSync(path.join(__dirname, '..', 'web', 'results-view.js'), 'utf8');
  const detailView = fs.readFileSync(path.join(__dirname, '..', 'web', 'detail-view.js'), 'utf8');
  const queryState = fs.readFileSync(path.join(__dirname, '..', 'web', 'query-state.js'), 'utf8');
  const tagSuggestions = fs.readFileSync(path.join(__dirname, '..', 'web', 'tag-suggestions.js'), 'utf8');
  assert.doesNotMatch(html, /Top sources|top-sources|filter-sources/);
  assert.doesNotMatch(html, /data-scope="(?:all|recent|private)"|id="top-tags"|Top tags/);
  ['id="folders"', 'id="url-groups"', '>Folders</summary>', '>URLs</summary>', 'id="add-comment-input"', 'id="add-tags-input"', 'id="add-folder-input"', 'id="add-kind-input"', 'id="add-visibility-input"', 'id="add-form-result"', 'id="settings-dialog"', 'id="settings-button"', 'id="settings-add-tab"', 'id="settings-add-panel"', 'id="settings-view-tab"', 'id="settings-view-panel"', 'id="settings-view-select"', 'id="settings-folders-tab"', 'id="settings-folders-panel"', 'id="folder-create-form"', 'id="folder-manager-list"', 'id="settings-rules-panel"', 'id="settings-guide-panel"', 'id="settings-chrome-panel"', 'id="settings-ai-tab"', 'id="settings-ai-panel"', 'id="ai-url-summary-start"', 'id="ai-url-summary-status"', 'id="policy-default-storage"', 'id="policy-rule-toggle"', 'id="policy-rule-kind"', 'id="chrome-clients-show-all"', 'id="control-slot"', 'id="browse-toolbar"', 'id="result-context-slot"', 'id="batch-bar"', 'id="batch-done"', 'id="batch-kind"', 'id="batch-visibility"', 'id="sort-trigger"', 'id="sort-popover"', 'id="view-scope-label"', 'id="feed-loader"', 'id="feed-load-more"', 'id="filter-form"', 'id="filter-preview"', 'id="filter-kind"', 'id="filter-source"', 'id="filter-visibility"', 'id="filter-folder"', 'id="filter-tag"', 'id="filter-saved-from"', 'id="filter-recent-preset"', 'id="filter-saved-to"', 'id="active-filter-chips"'].forEach(function (needle) {
    assert.match(html, new RegExp(needle));
  });
  assert.doesNotMatch(html, /id="(?:add|batch)-ai-policy"/);
  assert.doesNotMatch(html, /git-publication|settings-github-panel|Normal 데이터 게시|병합된 결과 가져오기/);
  assert.match(html, /id="search-input"[\s\S]*id="default-view-button"[\s\S]*id="filter-button"/);
  assert.match(demoHtml, /id="default-view-button"/);
  assert.match(app, /source\.listFolders/);
  assert.match(app, /source\.listUrlGroups/);
  assert.match(settings, /source\.createPairingCode/);
  assert.match(settings, /connectExtension/);
  assert.doesNotMatch(html, /Generate new code|pairing-code|chrome-base-url/);
  assert.doesNotMatch(demoHtml, /Generate new code|pairing-code|chrome-base-url/);
  assert.match(html, /id="chrome-approve-button"/);
  assert.match(demoHtml, /id="chrome-approve-button"/);
  assert.match(app, /WBH_PAIR_WITH_CODE/);
  assert.match(app, /requestChromeApproval/);
  assert.match(settings, /source\.revokeClient/);
  assert.match(app, /source\.editEntry/);
  assert.match(app, /await elements\.detailContent\.wbhFlushPendingEdits\(\)/);
  assert.match(app, /if \(!saved\) \{\s*return;/);
  assert.match(settings, /source\.previewCapturePolicyRule/);
  assert.match(settings, /activeClients\.slice\(0, 3\)/);
  assert.match(html, /<details class="settings-help">[\s\S]*Rules apply to future saves\. Existing Entries change only after Preview\/apply\./);
  assert.match(app, /anyLabel: "Detect from URL"/);
  assert.match(html, /tag-suggestions\.js\?v=tag-suggestions-2/);
  assert.match(app, /attachTagSuggestions\(elements\.addTags\)/);
  assert.match(app, /attachTagSuggestions\(elements\.batchTags\)/);
  assert.match(detailView, /settings\.attachTagSuggestions\(tagsField\.input\)/);
  assert.match(tagSuggestions, /\['ArrowDown', 'ArrowUp', 'Enter'\]/);
  assert.match(tagSuggestions, /setTimeout\(function runSuggestionQuery\(\) \{ timer = null; void refresh\(\); \}, 150\)/);
  assert.match(settings, /confirmAction/);
  assert.doesNotMatch(app, /source\.listEntryRevisions/);
  assert.match(app, /source\.batchEntries/);
  assert.match(app, /source\.deleteEntry/);
  assert.match(app, /settingsController\.activate/);
  assert.match(app, /ArrowLeft/);
  assert.match(app, /activeFilterItems/);
  assert.match(app, /function returnToDefaultView\(\)[\s\S]*state\.search = "";[\s\S]*state\.filters = QueryState\.defaultFilters\(\);/);
  assert.match(app, /QueryState\.entryQuery/);
  assert.match(app, /includeArchived: true/);
  assert.doesNotMatch(app, /entries ready/);
  assert.match(html, /class="visually-hidden">Entry details<\/h2>/);
  assert.match(detailView, /'button button-quiet icon-button detail-dialog-close'/);
  assert.doesNotMatch(html, /id="detail-header-actions"|id="manage-button"/);
  assert.match(detailView, /detail-autosave-status/);
  assert.match(detailView, /iconButton\('delete', t\('action\.deleteUrlPermanently'\)/);
  assert.match(detailView, /t\('confirm\.removeVisualReference'\)/);
  assert.match(detailView, /t\('placeholder\.commaSeparated'\)/);
  assert.match(resultsView, /t\('results\.listCaption'\)/);
  assert.match(resultsView, /t\('results\.page', \{ page: current \}\)/);
  assert.doesNotMatch(detailView, /button\('Delete URL'/);
  assert.match(view, /addEventListener\('dblclick'/);
  assert.match(view, /event\.key === 'Enter'/);
  assert.match(view, /event\.key === ' ' \|\| event\.key === 'Spacebar'/);
  assert.doesNotMatch(view, /commitSingleClick|clickTimer|setTimeout\(function commitSingleClick/);
  assert.match(view, /syncRenderedManagement/);
  assert.match(view, /if \(children\.length\) \{/);
  assert.match(view, /element\('summary', 'tree-parent'/);
  assert.match(app, /View\.syncRenderedManagement\(elements\.results, next, renderedSelectedIds\(\)\)/);
  assert.doesNotMatch(app, /if \(changed\) \{\s*renderCurrentResults\(\)/);
  assert.match(app, /const next = state\.selectedIds\.size > 0 \|\| Boolean\(state\.selectedQuery\)/);
  assert.doesNotMatch(app, /manageButton|setManagement/);
  assert.doesNotMatch(view, /'Open URL'/);
  assert.match(view, /event\.pointerType !== 'touch'/);
  assert.match(detailView, /container\.dataset\.mode = mode/);
  assert.match(app, /MAX_SELECTION = 100/);
  assert.match(html, /id="batch-select-results"[^>]*>Select all results</);
  assert.match(app, /QueryState\.entryScopeQuery/);
  assert.match(app, /expected_count: state\.selectedQuery\.expectedCount/);
  assert.match(app, /expected_digest: state\.selectedQuery\.expectedDigest/);
  assert.match(app, /source\.selectionSnapshot/);
  assert.match(app, /if \(operation === "delete"\) clearSelection\(\);\s*await refresh\(\);/);
  assert.match(app, /expectedDigest: snapshot\.expected_digest/);
  assert.match(queryState, /settings\.view === 'feed' \? 'with' : settings\.view === 'list' \? 'without'/);
  assert.match(app, /state\.feedNextPage = 2;\s*state\.feedHasMore = false;/);
  assert.match(app, /new global\.IntersectionObserver/);
  assert.match(app, /renderCurrentResults\(\{ appendItems: appended \}\)/);
  assert.match(app, /version !== refreshVersion/);
  assert.match(app, /global\.addEventListener\("focus", refreshAfterExternalChange\)/);
  assert.match(app, /document\.addEventListener\("visibilitychange", refreshAfterExternalChange\)/);
  assert.doesNotMatch(app, /event\.key !== "F5"/);
  assert.match(app, /QueryState\.readLocation/);
  assert.match(app, /QueryState\.writeLocation/);
  assert.match(app, /if \(!elements\.results\.querySelector\("\[data-entry-id\]"\)\)/);
  assert.match(app, /if \(!activationRefreshReady \|\| document\.visibilityState === "hidden"\) return;/);
  assert.match(app, /now - lastActivationRefreshAt < 750/);
  assert.match(app, /await refresh\(\);\s*activationRefreshReady = true;/);
  assert.match(app, /totalPages: state\.view === "feed" \? 0 : state\.totalPages/);
  assert.match(resultsView, /settings\.append === true/);
  assert.match(view, /active \? 'option' : 'listitem'/);
  assert.doesNotMatch(detailView, /Save changes|Change history|detail-history/);
  assert.doesNotMatch(detailView, /No notes yet\.|New note|Write a note for yourself/);
  assert.match(detailView, /detailPresentation\.describe\(entry\)/);
  assert.match(detailView, /cardPresentation\.describe\(entry\)/);
  assert.match(detailView, /target\.append\(lead\);[\s\S]*primary\.state === 'cover'[\s\S]*primary\.state === 'summary'[\s\S]*detail-stage-type[\s\S]*target\.insertBefore\(identity, target\.querySelector\('.detail-stage'\)\);[\s\S]*target\.append\(tagList[\s\S]*target\.append\(urlRow\)/);
  assert.match(detailView, /if \(primary\.title\)/);
  assert.match(detailView, /container\.classList\.toggle\('is-private', entry\.visibility === 'private'\)/);
  assert.doesNotMatch(detailView, /detail-meta-divider/);
  assert.match(detailView, /detail-top-metadata/);
  assert.doesNotMatch(detailView, /badgeList\(entry\)/);
  assert.match(html, /detail-presentation\.js\?v=single-url-1[\s\S]*card-presentation\.js\?v=card-density-1[\s\S]*detail-view\.js\?v=clean-retrieval-1/);
  assert.match(html, /card-presentation\.js\?v=card-density-1[\s\S]*view\.js\?v=clean-retrieval-1/);
  assert.match(view, /CardPresentation\.describe\(entry\)/);
  assert.match(view, /visualPreview\(entry, 'card', \{[\s\S]*ignoreContentFocus: true,[\s\S]*fallbackNode:/);
  assert.match(view, /body\.append\(metaLine\(entry, href\)\)[\s\S]*entry-card-main[\s\S]*entry-card-title[\s\S]*appendResultFooter\(body, entry, tags, selectedIds, onSelect\)/);
  assert.match(view, /if \(!tags\.childElementCount\) footer\.classList\.add\('has-no-tags'\)/);
  assert.match(view, /ContentTypes\.label\(entry\.kind \|\| 'page'\)/);
  assert.match(view, /frame\.dataset\.imageShape = image\.naturalHeight > image\.naturalWidth \* 1\.15 \? 'portrait' : 'landscape'/);
  assert.match(view, /main\.dataset\.cardState = presentation\.state/);
  assert.doesNotMatch(view, /main\.addEventListener\('dblclick'|openCardDestination|더블클릭하여 바로가기/);
  assert.match(view, /link\.append\(controlIcon\('external'\)\)/);
  assert.match(view, /link\.target = '_blank';[\s\S]*link\.rel = 'noopener noreferrer';[\s\S]*link\.referrerPolicy = 'no-referrer'/);
  assert.match(view, /link\.addEventListener\('click', stopCardInteraction\);[\s\S]*link\.addEventListener\('pointerup', stopCardInteraction\);[\s\S]*link\.addEventListener\('keydown', stopCardInteraction\)/);
  assert.match(view, /if \(presentation\.title\) \{[\s\S]*body\.append\(title\)/);
  assert.match(view, /entry-card-summary/);
  assert.match(view, /body\.insertBefore\(title, main\)/);
  assert.match(view, /const facts = element\('span', 'entry-meta-facts'\)/);
  assert.match(view, /header\.append\(metaLine\(entry, externalUrl\(presentation\.url\)\)\)/);
  assert.match(view, /fallback\.append\(cardFallbackStage\(presentation\)\)/);
  assert.match(view, /fallbackNode: fallback/);
  assert.doesNotMatch(view, /entry-meta-divider/);
  assert.doesNotMatch(view, /entry\.title \|\| entry\.url_original/);
  assert.match(view, /presentation\.isPrivate[\s\S]*classList\.add\('is-private'\)/);
  assert.doesNotMatch(view, /entry-card-url|bbs-private-label|has-private/);
  assert.match(view, /tags\.childElementCount/);
  assert.doesNotMatch(detailView, /images'\)/);
  assert.match(detailView, /detailSelect\('Content type', 'detail-kind'/);
  assert.doesNotMatch(detailView, /detail-ai-policy|AI policy/);
  assert.match(html, /id="detail-previous"[\s\S]*id="detail-next"/);
  assert.match(html, /detail-navigation\.js\?v=detail-navigation-1/);
  assert.match(app, /DetailNavigation\.navigationTarget\(detailNavigationInput\(\), direction\)/);
  assert.match(app, /source\.listEntries\(entryListQuery\(target\.page\)\)/);
  assert.match(app, /detailLoadVersion/);
  assert.match(app, /detailController = new AbortController\(\)/);
  assert.match(app, /page: 1, page_size: 100, signal/);
  assert.match(app, /onLoadMoreComments/);
  assert.doesNotMatch(detailView, /notesOpen|noteCount/);
  assert.match(detailView, /dataset\.loadMoreNotes = 'true'/);
  assert.match(detailView, /textarea\.maxLength = 20000/);
  assert.doesNotMatch(detailView, /Check link|linkHealth|detail-link-health/);
  assert.doesNotMatch(app, /checkLinkHealth|getLinkHealth|linkHealth/);
  assert.match(app, /const appended = await loadMoreFeed\(\)/);
  assert.match(app, /wbhFlushPendingEdits/);
  assert.match(app, /syncEntryLocation\(targetEntryId, "replaceState"\)/);
  assert.match(app, /\["ArrowLeft", "ArrowRight"\]/);
  assert.doesNotMatch(html + detailView, /Agent access|AI processing/);
  assert.doesNotMatch(html, /id="batch-open"|Open details/);
  assert.doesNotMatch(html + app + view + detailView, /source\.archiveEntry|source\.restoreEntry|Archive URL|Restore URL/);
  assert.doesNotMatch(html, /id="policy-dialog"|id="chrome-dialog"|id="policy-button"|id="chrome-button"/);
  assert.doesNotMatch(html, /right[- ](?:hand )?(?:detail|inspector)|detail-rail/i);
  assert.match(html, /id="control-slot"[\s\S]*id="browse-toolbar"[\s\S]*id="result-context-slot"[\s\S]*id="active-filter-summary"[\s\S]*id="batch-bar"/);
  assert.doesNotMatch(html + app, /context-toolbar|contextToolbar/);
  assert.match(app, /elements\.batchBar\.hidden = !state\.management/);
  assert.match(app, /elements\.batchDone\.addEventListener\("click"[\s\S]*clearSelection/);
  assert.match(app, /SortModel\.describe\(state\.sort\)/);
  assert.match(app, /sortOptions: Array\.from\(document\.querySelectorAll\("\[data-sort-value\]"\)\)/);
  assert.match(app, /commitSort\(button\.dataset\.sortValue\)/);
  assert.doesNotMatch(app, /sortCriteria|sortDirection|defaultSortFor|SortModel\.opposite/);
  ['newest', 'oldest', 'updated_desc', 'updated_asc', 'title_asc', 'title_desc', 'source_asc', 'source_desc'].forEach(function (sort) {
    assert.match(html, new RegExp('data-sort-value="' + sort + '"'));
  });
  assert.match(app, /closeSortPopover\(\{ returnFocus: true \}\)/);
  assert.match(html, /id="settings-add-tab"[\s\S]*id="settings-view-tab"[\s\S]*id="settings-rules-tab"/);
  assert.doesNotMatch(html + demoHtml, /class="view-toggle"|data-view=/);
  assert.match(app, /settingsView: document\.getElementById\("settings-view-select"\)/);
  assert.match(app, /elements\.settingsView\?\.addEventListener\("change"/);
  assert.doesNotMatch(html + demoHtml + app, /id="add-url-button"|id="add-dialog"|addDialog|openAddDialog/);
  assert.match(app, /await refresh\(\);\s*if \(outcome\?\.outcome_code === "created"\) resetAddForm\(\{ clearResult: false \}\)/);
  assert.match(app, /form\.autoFromUrl/);
  assert.match(app, /kind: elements\.addKind\.value \|\| undefined/);
  assert.doesNotMatch(app, /contentFocus: \["video", "image"\]/);
  assert.match(app, /app\.hiddenAfterSave/);
  assert.match(app, /app\.duplicateActive/);
  assert.match(app, /app\.duplicateArchived/);
  assert.match(app, /["']Title["'][\s\S]*["']Note["'][\s\S]*["']Tags["'][\s\S]*["']Folder["'][\s\S]*["']Content type["'][\s\S]*["']Visibility["']/);
  assert.doesNotMatch(app, /["']AI policy["']/);
  assert.doesNotMatch(app, /elements\.addDialog\.close\(\)[\s\S]*state\.search = ""|state\.filters = QueryState\.emptyFilters\(\)[\s\S]*state\.sort = "newest"/);
  assert.match(app, /shortcut\.textContent = t\(["']action\.openEntry["']\)/);
  assert.match(settings, /let activePanel = 'add'/);
  assert.match(settings, /\['add', 'view', 'folders', 'rules', 'guide', 'chrome', 'ai'\]/);
  assert.match(settings, /source\.createFolder/);
  assert.match(settings, /source\.updateFolder/);
  assert.match(settings, /source\.deleteFolder/);
  assert.match(app, /folderTreeLoaded = false;[\s\S]*await refresh\(\)/);
  assert.doesNotMatch(app, /data-render-stale/);
  assert.match(view, /preview-placeholder/);
  assert.match(view, /image\.addEventListener\('load'/);
  assert.match(view, /const renderedEntryKeys = new WeakMap\(\)/);
  assert.match(resultsView, /reusableNodes\.get\(String\(entry\.id\)\)/);
  assert.match(resultsView, /reconcileChildren\(container, desiredNodes\)/);
  assert.match(view, /fallback\.classList\.remove\('preview-placeholder'\)/);
  assert.doesNotMatch(view, /owner\.dataset\.renderStale/);
  assert.match(view, /onFailure/);
  assert.match(app, /function installTooltipBehavior\(documentRef\)/);
  assert.match(app, /details\.settings-help\[open\]/);
  assert.match(app, /event\.stopImmediatePropagation\(\)/);
  assert.match(app, /installTooltipBehavior\(document\)/);
  assert.doesNotMatch(html + demoHtml + app + view + detailView, /title="|\.title\s*=/);
  for (const file of fs.readdirSync(path.join(__dirname, '..', 'web')).filter((name) => /\.(?:css|html|js)$/.test(name))) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'web', file), 'utf8'), /·/, file);
  }
});

test('narrow-width and failure-state rules keep primary controls visible and labels bounded', function () {
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.toolbar \{[\s\S]*display: grid;/);
  assert.match(css, /\.form-field \{[^}]*align-content: start;/);
  assert.match(css, /\.form-grid \.form-field > label, \.form-grid \.field-label-with-help \{[^}]*min-height: 28px;[^}]*align-items: center;/);
  assert.match(css, /"home filter sort settings"/);
  assert.doesNotMatch(css, /\.view-toggle/);
  assert.doesNotMatch(css, /"add add add add"|\.add-url-button/);
  assert.match(css, /\.settings-button \{ grid-area: settings; justify-self: end;/);
  assert.match(css, /\.bbs-saved-head::after \{ content: "Date";/);
  assert.match(css, /\.settings-tab\[aria-selected="true"\]/);
  assert.match(css, /\.settings-dialog \{[^}]*overflow-y: auto;/);
  assert.match(css, /\.settings-panel-padded \{ padding: 24px; \}/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.folder-create-form, \.folder-manager-row \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(css, /\.folder-manager-actions \{[^}]*justify-content: end;/);
  assert.match(css, /\.folder-create-form \.button \{ grid-column: 1 \/ -1; justify-self: end; \}/);
  assert.match(css, /\.settings-tabs \{ overflow-x: auto; \}/);
  assert.match(css, /\.settings-section-heading \{ align-items: flex-start; flex-wrap: wrap; \}/);
  assert.match(html, /class="settings-help"[\s\S]*<summary aria-label="About URL rules">\?<\/summary>/);
  assert.doesNotMatch(html, /Rules affect future saves by default/);
  assert.match(css, /\.add-form-result\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.filter-button \{ display: inline-grid;/);
  assert.match(css, /\.icon \{ width: 16px; height: 16px;/);
  assert.match(css, /\.icon-button \{[^}]*width: 42px;[^}]*border: 0;[^}]*background: transparent;[^}]*box-shadow: none;/);
  assert.match(css, /\.icon-button:focus-visible \{ outline: none;[^}]*background: var\(--ink\);/);
  assert.match(css, /\.button\.icon-button, \.toggle-button\.icon-button, \.pagination-button\.icon-button \{[^}]*border: 0;[^}]*font-size: 16px;/);
  assert.match(css, /\.button\.icon-button\.default-view-button,[\s\S]*\.button\.icon-button\.settings-button \{ border: 1px solid var\(--ink\); \}/);
  assert.match(css, /\.settings-help \{[^}]*width: 28px;[^}]*height: 24px;/);
  assert.match(css, /\.settings-help > summary \{[^}]*width: 36px;[^}]*border: 0;[^}]*font-size: \.58rem;/);
  assert.match(css, /\.filter-form-grid/);
  assert.match(css, /select \{[^}]*font-size: \.78rem;/);
  assert.match(css, /\.capture-defaults-grid \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.capture-rule-grid \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.active-filter-chip/);
  assert.match(css, /\.control-slot \{[^}]*min-height: 42px;/);
  assert.match(css, /\.result-context-slot \{[^}]*height: 42px;/);
  assert.doesNotMatch(css, /\.app-shell\.is-managing \.browse-toolbar \{ display: none; \}/);
  assert.match(css, /\.batch-bar:not\(\[hidden\]\) \{[^}]*max-width: calc\(100% - 112px\);[^}]*margin-left: auto;/);
  assert.doesNotMatch(css, /\.app-shell\.is-managing \.main-content \{ padding-bottom:/);
  assert.doesNotMatch(css, /\.app-shell\.is-managing \.active-filter-summary \{[^}]*visibility: hidden;/);
  assert.match(css, /\.active-filter-summary\[hidden\] \+ \.batch-bar:not\(\[hidden\]\) \{ max-width: 100%; \}/);
  assert.match(css, /\.results-header \{ position: sticky;[^}]*top: 0;/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.results-header \{ position: sticky;/);
  assert.match(css, /\.sort-popover \{[^}]*position: absolute;[^}]*max-width: calc\(100vw - 28px\);/);
  assert.match(css, /\.sort-options \{ display: grid; border: 1px solid var\(--line-strong\); \}/);
  assert.match(css, /\.sort-option \{[^}]*display: flex;[^}]*width: 100%;/);
  assert.match(css, /\.sort-option\[aria-checked="true"\]/);
  assert.match(css, /\.tree-item[\s\S]*overflow-wrap: anywhere/);
  assert.match(css, /\.results-grid[^}]*grid-auto-rows: 1fr;[^}]*align-items: stretch;/);
  assert.match(css, /\.entry-card-grid[^}]*height: 100%/);
  assert.match(css, /\.entry-card-body \{[^}]*height: 100%;[^}]*flex-direction: column;/);
  assert.doesNotMatch(css, /\.tags, \.badges[^}]*min-height/);
  assert.match(css, /\.entry-card-main \{[^}]*aspect-ratio: 4 \/ 3;[^}]*container-type: inline-size;/);
  assert.match(css, /\.entry-card-main\[data-card-state="type"\] \{ place-items: center; \}/);
  assert.match(css, /\.entry-card-type[^}]*justify-content: center;[^}]*font-size: clamp\(3rem, 21cqi, 5\.25rem\);[^}]*text-align: center;/);
  assert.doesNotMatch(css, /\.entry-card-summary/);
  assert.match(css, /\.entry-card-footer \{[^}]*overflow: hidden;/);
  assert.doesNotMatch(css, /\.entry-card-footer \{[^}]*min-height:/);
  assert.match(css, /\.entry-card-external \{[^}]*width: 36px;[^}]*height: 36px;[^}]*margin-left: auto;[^}]*border: 0;[^}]*font-size: 16px;/);
  assert.match(css, /\.entry-card-external:focus-visible \{ outline: none;[^}]*background: var\(--ink\);/);
  assert.match(css, /\.entry-card\.is-private, \.entry-feed\.is-private \{ background: #eee9dc; \}/);
  assert.match(css, /\.bbs-row\.is-private td \{ background: #eee9dc; \}/);
  assert.doesNotMatch(css, /\.bbs-row\.is-private td:first-child/);
  assert.match(css, /\.entry-card-main \+ \.entry-card-title \{ margin-top: 8px; align-self: start; \}/);
  assert.match(css, /\.entry-feed \.entry-title \{ min-height: calc\(1\.34em \* 2\);/);
  assert.match(css, /\.entry-feed-fallback \{[^}]*background: var\(--surface-muted\);[^}]*background-image: none;/);
  assert.match(css, /\.entry-meta-facts \{[^}]*gap: 10px;/);
  assert.match(css, /\.entry-card \.preview \{[^}]*height: 100%;[^}]*aspect-ratio: auto;/);
  assert.match(css, /\.preview-detail \{[^}]*height: clamp\(300px, 58vh, 560px\);[^}]*aspect-ratio: auto;/);
  assert.match(css, /\.preview-detail \.cover-image \{[^}]*width: 100%;[^}]*height: 100%;[^}]*object-fit: contain;[^}]*object-position: center;/);
  assert.match(css, /\.preview-detail\[data-image-shape="portrait"\] \.cover-image \{ object-fit: cover; object-position: center top; \}/);
  assert.match(css, /\.detail-stage \{[^}]*background: transparent;/);
  assert.doesNotMatch(css, /\.detail-stage \{[^}]*border:/);
  assert.match(css, /\.detail-stage-cover \.preview-detail \{[^}]*background: transparent;/);
  assert.match(css, /\.preview-image\.is-loaded \.cover-image \{ opacity: 1; \}/);
  assert.match(css, /\.detail-secondary > summary \{ width: max-content;/);
  assert.match(css, /\.detail-content \{[^}]*gap: 12px;/);
  assert.match(css, /\.detail-content\.is-private \{ background: #eee9dc; \}/);
  assert.match(css, /\.detail-stage-summary \{[^}]*min-height: 220px;[^}]*-webkit-line-clamp: 9;/);
  assert.match(css, /\.detail-content \{[^}]*container-type: inline-size;/);
  assert.match(css, /\.detail-cover-fallback > strong \{[^}]*font-size: clamp\(2rem, 9cqi, 7rem\);[^}]*overflow-wrap: normal;[^}]*white-space: nowrap;/);
  assert.match(css, /\.detail-stage-type \{[^}]*min-height: 240px;[^}]*place-items: center;[^}]*font-size: clamp\(2rem, 9cqi, 7rem\);[^}]*overflow-wrap: normal;[^}]*white-space: nowrap;/);
  assert.match(css, /\.detail-content\[data-mode="edit"\] \{ gap: 16px;/);
  assert.match(css, /\.detail-content-actions \.icon, \.detail-dialog-close \.icon \{[^}]*width: 22px;[^}]*height: 22px;[^}]*stroke-width: 2\.1;/);
  assert.match(css, /\.detail-content-actions \[data-tooltip\]::after \{[^}]*right: 0;[^}]*left: auto;[^}]*translate\(0, 3px\);/);
  assert.doesNotMatch(css, /\.delete-entry-button \{[^}]*display: inline-flex;/);
  assert.match(css, /\.detail-dialog-close \{ flex: 0 0 auto;/);
  assert.match(css, /\.detail-dialog \{ max-height: 95vh;[^}]*overflow: hidden;/);
  assert.match(css, /\.detail-dialog-nav \{ position: fixed;[^}]*width: 52px;[^}]*background: rgb\(23 23 21 \/ 28%\);/);
  assert.match(css, /\.detail-dialog-previous \{ left: max\(8px, calc\(50vw - 404px\)\);/);
  assert.match(css, /\.detail-dialog-next \{ right: max\(8px, calc\(50vw - 404px\)\);/);
  assert.match(css, /\.detail-dialog-nav:disabled \{[^}]*opacity: \.18;/);
  assert.doesNotMatch(css, /\.detail-dialog-nav:disabled \{[^}]*visibility: hidden;/);
  assert.doesNotMatch(css, /:hover[^{}]*\{[^}]*border-color:/);
  assert.match(css, /html\.has-open-dialog, html\.has-open-dialog body \{[^}]*overflow: hidden;/);
  assert.match(css, /\.detail-content \{[^}]*max-height: 95vh;[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain;/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.detail-dialog \{ width: calc\(100vw - 24px\);/);
  assert.match(css, /\.entry-dialog \{[^}]*overflow-x: hidden;/);
  assert.match(css, /\.detail-content \{[^}]*overflow-x: hidden;/);
  assert.match(css, /\.asset-actions \.icon-button \{ width: 36px;/);
  assert.match(css, /@media \(max-width: 540px\)[\s\S]*\.pagination button \{ min-width: 38px;/);
  assert.match(css, /\.is-managing \.entry-card\[aria-selected="true"\]/);
  assert.match(css, /\.is-managing \.entry-card\[aria-selected="true"\] \.entry-card-type,[\s\S]*color: var\(--surface\);/);
  assert.match(css, /outline: 4px solid var\(--ink\)/);
  assert.match(css, /background: #c9c4b8/);
  assert.doesNotMatch(css, /selected-label|content: "✓ "/);
  assert.match(css, /--ui-font-family: system-ui, -apple-system, "Segoe UI", sans-serif;/);
  assert.match(css, /--ui-root-font-size: 143\.75%;/);
  assert.match(css, /\.entry-kind \{[^}]*flex: 0 1 auto;[^}]*text-overflow: ellipsis;/);
  assert.match(css, /@media \(max-width: 1500px\) \{ \.results-grid \{ grid-template-columns: repeat\(3,/);
  assert.doesNotMatch(css, /typography-lab|data-typography/);
  assert.match(css, /\.bbs-select-checkbox/);
  assert.match(css, /\.results-list:not\(\.is-managing\) \.bbs-select-head/);
  assert.match(css, /\.results-list:not\(\.is-managing\) \.bbs-row > :nth-child\(2\) \{ width: 76%; \}/);
  assert.doesNotMatch(css, /\.bbs-row\[aria-selected="true"\] td \{ color: var\(--surface\); background: var\(--ink\);/);
  assert.doesNotMatch(css, /\.comment \+ \.comment \{ border-top/);
  assert.match(css, /-webkit-line-clamp: 2/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\[data-tooltip\]\.is-tooltip-visible::after/);
  assert.doesNotMatch(css, /\[data-tooltip\]:hover::after|\[data-tooltip\]:focus-visible::after/);
  assert.match(html, /id="app-status" class="app-status"/);
  assert.doesNotMatch(html, /id="app-status" class="visually-hidden"/);
  assert.match(css, /\.app-status:empty \{ min-height: 0; margin: 0; \}/);
});

test('autosave coordinator debounces edits and persists only the latest full value', async function () {
  let timerCallback;
  const saved = [];
  const states = [];
  const coordinator = View.createAutosaveCoordinator({
    delay: 650,
    setTimer(callback) {
      timerCallback = callback;
      return 1;
    },
    clearTimer() {},
    async save(value) {
      saved.push(value);
      return value;
    },
    onState(state) {
      states.push(state);
    }
  });

  await coordinator.schedule({ title: 'First' }, false);
  await coordinator.schedule({ title: 'Latest' }, false);
  timerCallback();
  await coordinator.flush();

  assert.deepEqual(saved, [{ title: 'Latest' }]);
  assert.deepEqual(states, ['dirty', 'dirty', 'saving', 'saved']);
  assert.equal(coordinator.hasPending(), false);
});

test('autosave coordinator serializes an edit queued during an active save', async function () {
  let releaseFirst;
  let active = 0;
  let peakActive = 0;
  const saved = [];
  const coordinator = View.createAutosaveCoordinator({
    async save(value) {
      active += 1;
      peakActive = Math.max(peakActive, active);
      saved.push(value);
      if (saved.length === 1) {
        await new Promise(function waitForRelease(resolve) { releaseFirst = resolve; });
      }
      active -= 1;
      return value;
    }
  });

  const first = coordinator.schedule({ title: 'First' }, true);
  await Promise.resolve();
  const second = coordinator.schedule({ title: 'Second' }, true);
  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(saved, [{ title: 'First' }, { title: 'Second' }]);
  assert.equal(peakActive, 1);
  assert.equal(coordinator.hasPending(), false);
});

test('autosave coordinator retains a failed edit for an explicit retry', async function () {
  let attempts = 0;
  const saved = [];
  const coordinator = View.createAutosaveCoordinator({
    async save(value) {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
      saved.push(value);
      return value;
    }
  });

  assert.equal(await coordinator.schedule({ visibility: 'normal' }, true), false);
  assert.equal(coordinator.hasPending(), true);
  assert.deepEqual(await coordinator.flush(), { visibility: 'normal' });
  assert.deepEqual(saved, [{ visibility: 'normal' }]);
  assert.equal(coordinator.hasPending(), false);
});
