'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const createSettingsController = require('../web/settings-controller.js');
const UiLanguage = require('../web/ui-language.js');

class FakeElement {
  constructor(name) {
    this.name = name;
    this.children = [];
    this.dataset = {};
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
    this.submit = { disabled: false };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, listener) { this.listeners ||= {}; this.listeners[type] = listener; }
  setAttribute(name, value) { this[name] = value; }
  querySelector() { return this.submit; }
  focus() { this.focused = true; }
  scrollIntoView(options) { this.revealOptions = options; }
}

function fixture() {
  const element = () => new FakeElement('fixture');
  const elements = {
    chromeApproveButton: element(), chromeClients: element(), chromeConnectionGuidance: element(),
    chromeClientsShowAll: element(), chromeConnectionRequest: element(), chromeError: element(),
    aiUrlSummaryError: element(), aiUrlSummaryStart: element(), aiUrlSummaryStatus: element(), aiUrlSummaryCount: element(),
    policyDefaultAi: element(), policyDefaultForm: element(), policyDefaultStorage: element(), policyDefaultVisibility: element(),
    policyError: element(), policyRuleAi: element(), policyRuleForm: element(), policyRuleKind: element(), policyRulePrefix: element(),
    policyRuleError: element(), policyRuleStatus: element(), policyRuleMode: element(), policyRuleTags: element(), policyRules: element(), policyRuleToggle: element(), policyRuleVisibility: element(), addUrl: element(),
    folderCreateParent: element(), folderManagerError: element(), folderManagerList: element(), settingsView: element(),
    settingsTabs: [element(), element(), element(), element(), element(), element(), element()],
    settingsPanels: [element(), element(), element(), element(), element(), element(), element()]
  };
  elements.settingsTabs[0].dataset.settingsPanel = 'add';
  elements.settingsTabs[1].dataset.settingsPanel = 'view';
  elements.settingsTabs[2].dataset.settingsPanel = 'folders';
  elements.settingsTabs[3].dataset.settingsPanel = 'rules';
  elements.settingsTabs[4].dataset.settingsPanel = 'guide';
  elements.settingsTabs[5].dataset.settingsPanel = 'chrome';
  elements.settingsTabs[6].dataset.settingsPanel = 'ai';
  elements.settingsPanels[0].dataset.settingsContent = 'add';
  elements.settingsPanels[1].dataset.settingsContent = 'view';
  elements.settingsPanels[2].dataset.settingsContent = 'folders';
  elements.settingsPanels[3].dataset.settingsContent = 'rules';
  elements.settingsPanels[4].dataset.settingsContent = 'guide';
  elements.settingsPanels[5].dataset.settingsContent = 'chrome';
  elements.settingsPanels[6].dataset.settingsContent = 'ai';
  return { elements, document: { createElement: (name) => new FakeElement(name) } };
}

test('settings controller coordinates capture defaults, rules, and hidden-code Chrome approval', async function () {
  const calls = [];
  const subject = fixture();
  const source = {
    baseUrl: 'http://127.0.0.1:3042/',
    getCapturePolicy: async () => ({ visibility: 'private', agent_access: 'blocked', ai_processing: 'disabled', selected_image_storage: 'reference_only' }),
    listCapturePolicyRules: async () => [{
      id: 7, hostname: 'example.test', path_prefix: '/private', kind: 'research', visibility: 'private',
      agent_access: 'blocked', ai_processing: 'disabled', enabled: true, tags: []
    }],
    updateCapturePolicyRule: async (id, value) => { calls.push(['update-rule', id, value]); }, previewCapturePolicyRule: async () => ({ match_count: 0 }), deleteCapturePolicyRule: async () => {},
    updateCapturePolicy: async (value) => { calls.push(['default', value]); },
    createCapturePolicyRule: async (value) => { calls.push(['rule', value]); },
    listClients: async () => [],
    createPairingCode: async () => ({ code: 'ABC123', expires_at: '2026-09-01T12:00:00.000Z' })
  };
  const controller = createSettingsController({
    source,
    elements: subject.elements,
    document: subject.document,
    connectExtension: async (extensionId, pairing) => { calls.push(['connect', extensionId, pairing]); }
  });
  await controller.activate('rules', { focusTab: true });
  assert.equal(subject.elements.policyDefaultVisibility.value, 'private');
  assert.equal(subject.elements.policyDefaultStorage.value, 'reference_only');
  assert.equal(subject.elements.settingsTabs[3].focused, true);
  assert.deepEqual(subject.elements.settingsTabs[3].revealOptions, { block: 'nearest', inline: 'nearest' });
  const ruleRow = subject.elements.policyRules.children[0];
  assert.equal(ruleRow.name, 'article');
  assert.equal(ruleRow.children[0].name, 'details');
  assert.equal(ruleRow.children[0].children[0].name, 'summary');
  assert.deepEqual(ruleRow.children[0].children[1].children.map((item) => item.textContent), [
    'URL scope', 'example.test/private', 'Save method', 'All saves', 'Content type', 'research', 'Add tags', 'None',
    'Visibility', 'private', 'State', 'Enabled'
  ]);
  await ruleRow.children[1].children[0].listeners.click();
  assert.equal(subject.elements.policyRulePrefix.value, 'https://example.test/private');
  assert.equal(subject.elements.policyRuleKind.value, 'research');
  assert.equal(subject.elements.policyRuleTags.value, '');
  assert.equal(subject.elements.policyRuleVisibility.value, 'private');
  assert.equal(subject.elements.policyRuleForm.submit.textContent, 'Save changes');
  subject.elements.policyRuleVisibility.value = 'normal';
  await controller.submitRule({ preventDefault() {} });
  subject.elements.policyDefaultVisibility.value = 'normal';
  subject.elements.policyDefaultStorage.value = 'local_copy';
  await controller.submitDefault({ preventDefault() {} });
  subject.elements.policyRulePrefix.value = 'https://example.test/private';
  subject.elements.policyRuleVisibility.value = 'private';
  subject.elements.policyRuleKind.value = 'research';
  await controller.submitRule({ preventDefault() {} });
  await controller.activate('chrome');
  assert.equal(controller.requestChromeApproval('invalid'), false);
  assert.equal(subject.elements.chromeConnectionRequest.hidden, true);
  assert.equal(controller.requestChromeApproval('abcdefghijklmnopabcdefghijklmnop'), true);
  assert.equal(subject.elements.chromeConnectionRequest.hidden, false);
  assert.equal(await controller.approveChromeConnection(), true);
  assert.deepEqual(calls.map((item) => item[0]), ['update-rule', 'default', 'rule', 'connect']);
  assert.deepEqual(calls[3], ['connect', 'abcdefghijklmnopabcdefghijklmnop', { code: 'ABC123', label: 'Chrome' }]);
  assert.deepEqual(calls[0], ['update-rule', 7, { url_prefix: 'https://example.test/private', kind: 'research', capture_mode: 'all', visibility: 'normal', tags: [] }]);
  assert.deepEqual(calls[1][1], { visibility: 'normal', selected_image_storage: 'local_copy' });
  assert.deepEqual(calls[2][1], { url_prefix: 'https://example.test/private', kind: 'research', capture_mode: 'all', visibility: 'private', tags: [] });
});

test('Settings starts on Add URL and remembers the last activated tab for the page session', async function () {
  const subject = fixture();
  const controller = createSettingsController({
    source: { listClients: async () => [] },
    elements: subject.elements,
    document: subject.document
  });
  assert.equal(await controller.activate(undefined, { focusContent: true }), 'add');
  assert.equal(subject.elements.addUrl.focused, true);
  assert.equal(controller.activePanel(), 'add');
  await controller.activate('view', { focusContent: true });
  assert.equal(subject.elements.settingsView.focused, true);
  await controller.activate('guide');
  assert.equal(await controller.activate(undefined), 'guide');
  assert.equal(controller.activePanel(), 'guide');
});

test('paired clients show three newest active rows before an explicit reveal without mutating records', async function () {
  const subject = fixture();
  const clients = [
    { id: 2, label: 'Fourth', created_at: '2026-08-04T00:00:00.000Z', last_used_at: '2026-08-04T00:00:00.000Z', revoked_at: null },
    { id: 5, label: 'Newest', created_at: '2026-08-01T00:00:00.000Z', last_used_at: '2026-08-05T00:00:00.000Z', revoked_at: null },
    { id: 3, label: 'Third', created_at: '2026-08-03T00:00:00.000Z', last_used_at: null, revoked_at: null },
    { id: 4, label: 'Second', created_at: '2026-08-02T00:00:00.000Z', last_used_at: '2026-08-04T12:00:00.000Z', revoked_at: null },
    { id: 1, label: 'Old revoked', created_at: '2026-07-01T00:00:00.000Z', last_used_at: null, revoked_at: '2026-09-01T00:00:00.000Z' }
  ];
  const calls = [];
  const controller = createSettingsController({
    source: {
      listClients: async () => clients,
      revokeClient: async (id) => { calls.push(id); clients.find((client) => client.id === id).revoked_at = 'now'; }
    },
    elements: subject.elements,
    document: subject.document,
    confirm: () => true
  });
  await controller.refreshChromeClients();
  assert.deepEqual(subject.elements.chromeClients.children.map((row) => row.children[0].textContent), ['Newest', 'Second', 'Fourth']);
  assert.equal(subject.elements.chromeClientsShowAll.hidden, false);
  assert.equal(subject.elements.chromeClientsShowAll.textContent, 'Show all (5)');
  assert.deepEqual(calls, []);
  controller.showAllChromeClients();
  assert.deepEqual(subject.elements.chromeClients.children.map((row) => row.children[0].textContent), [
    'Newest', 'Second', 'Fourth', 'Third', 'Old revoked (revoked)'
  ]);
  assert.equal(subject.elements.chromeClientsShowAll.hidden, true);
  await subject.elements.chromeClients.children[0].children[1].listeners.click();
  assert.deepEqual(calls, [5]);
});
test('folder controls and revoked client status render in Korean while keeping domain nouns', async function () {
  const subject = fixture();
  const folder = { id: 7, name: 'Research', parent_id: null, entry_count: 1, children: [] };
  const client = { id: 1, label: 'Chrome', created_at: '2026-09-01T00:00:00.000Z', last_used_at: null, revoked_at: '2026-09-02T00:00:00.000Z' };
  try {
    UiLanguage.setLanguage('ko');
    const controller = createSettingsController({
      source: {
        listFolders: async () => [folder],
        listClients: async () => [client]
      },
      elements: subject.elements,
      document: subject.document,
      i18n: UiLanguage
    });
    await controller.refreshFolderSettings();
    const row = subject.elements.folderManagerList.children[0];
    assert.equal(row.children[0]['aria-label'], 'Research Folder 이름 바꾸기');
    assert.equal(row.children[1]['aria-label'], 'Research Folder의 상위 Folder');
    await controller.refreshChromeClients();
    controller.showAllChromeClients();
    assert.equal(subject.elements.chromeClients.children[0].children[0].textContent, 'Chrome (연결 해제됨)');
  } finally {
    UiLanguage.setLanguage('en');
  }
});

test('AI settings show the eligible count and start all pending URLs', async function () {
  const subject = fixture();
  let startCalls = 0;
  const completed = {
    status: 'idle', eligible_count: 9, model: 'gpt-6-luna', reasoning_effort: 'max',
    last_run: { counts: { complete: 8, partial: 1, failed: 1 } }
  };
  const controller = createSettingsController({
    source: {
      getAiUrlSummary: async () => ({ ...completed, last_run: null }),
      startAiUrlSummary: async (scope) => { assert.deepEqual(scope, { mode: 'all' }); startCalls += 1; return completed; }
    },
    elements: subject.elements,
    document: subject.document
  });
  await controller.activate('ai');
  assert.equal(subject.elements.aiUrlSummaryStatus.textContent, 'Run first attempts here, or select URLs in Manage to retry or refresh them.');
  assert.equal(subject.elements.aiUrlSummaryCount.textContent, '9 URLs');
  assert.equal(subject.elements.aiUrlSummaryStart.textContent, 'Summarize 9 untried URLs');
  assert.equal(subject.elements.settingsTabs[6].dataset.settingsPanel, 'ai');
  const result = await controller.startAiUrlSummary();
  assert.equal(startCalls, 1);
  assert.equal(result, completed);
  assert.equal(subject.elements.aiUrlSummaryStart.disabled, false);
  assert.equal(subject.elements.aiUrlSummaryStatus.textContent, 'Finished: 8 complete, 1 partial, 1 failed.');
  assert.equal(subject.elements.aiUrlSummaryError.textContent, '');
});

test('AI settings show an existing run instead of displaying a busy error', async function () {
  const subject = fixture();
  let reads = 0;
  const controller = createSettingsController({
    source: {
      getAiUrlSummary: async () => {
        reads += 1;
        return reads === 1
          ? { status: 'running', eligible_count: 1, progress: { processed: 0, total: 1 }, last_run: null }
          : { status: 'idle', eligible_count: 1, progress: null, last_run: null };
      },
      startAiUrlSummary: async () => { throw Object.assign(new Error('Busy'), { code: 'AI_SUMMARY_BUSY' }); }
    },
    elements: subject.elements,
    document: subject.document
  });
  const status = await controller.startAiUrlSummary();
  assert.equal(status.status, 'running');
  assert.equal(subject.elements.aiUrlSummaryError.textContent, '');
  assert.equal(subject.elements.aiUrlSummaryStatus.textContent, 'Processing 0 of 1 URLs…');
  assert.equal(subject.elements.aiUrlSummaryStart.disabled, false);
});

test('AI settings can queue still-available URLs during a running summary', async function () {
  const subject = fixture();
  let starts = 0;
  let reads = 0;
  const running = {
    status: 'running', eligible_count: 4, available_count: 2, queued_count: 1,
    progress: { processed: 0, total: 2 }, last_run: null
  };
  const controller = createSettingsController({
    source: {
      getAiUrlSummary: async () => ++reads === 1
        ? running : { ...running, status: 'idle', available_count: 0, progress: null },
      startAiUrlSummary: async (scope) => {
        assert.deepEqual(scope, { mode: 'all' });
        starts += 1;
        return { ...running, available_count: 0, queued_count: 3, progress: { ...running.progress, total: 4 }, newly_queued: 2 };
      }
    },
    elements: subject.elements,
    document: subject.document
  });
  await controller.activate('ai');
  assert.equal(subject.elements.aiUrlSummaryStart.disabled, false);
  assert.equal(subject.elements.aiUrlSummaryStart.textContent, 'Queue 2 more URLs');
  assert.equal(subject.elements.aiUrlSummaryStatus.textContent, 'Processing 0 of 2 URLs… 1 waiting.');
  await controller.startAiUrlSummary();
  assert.equal(starts, 1);
  assert.equal(subject.elements.aiUrlSummaryStart.disabled, true);
  assert.equal(subject.elements.aiUrlSummaryStatus.textContent, 'Processing 0 of 4 URLs… 3 waiting.');
});


test('rule editor creates and updates a visible save-method condition without losing it on reopen', async () => {
  const subject = fixture();
  const stored = [];
  const source = {
    getCapturePolicy: async () => ({ visibility: 'private', agent_access: 'blocked', ai_processing: 'disabled' }),
    listCapturePolicyRules: async () => stored,
    createCapturePolicyRule: async (value) => stored.push({ ...value, id: 1, hostname: 'x.com', path_prefix: '/', enabled: true }),
    updateCapturePolicyRule: async (id, value) => Object.assign(stored.find((rule) => rule.id === id), value)
  };
  const controller = createSettingsController({ source, elements: subject.elements, document: subject.document });
  subject.elements.policyRuleForm.hidden = true;
  controller.toggleRuleEditor();
  subject.elements.policyRulePrefix.value = 'https://x.com/';
  subject.elements.policyRuleMode.value = 'selected_images';
  subject.elements.policyRuleKind.value = 'post';
  subject.elements.policyRuleVisibility.value = 'private';
  await controller.submitRule({ preventDefault() {} });
  assert.equal(stored[0].capture_mode, 'selected_images');
  assert.equal(stored[0].visibility, 'private');
  assert.equal(subject.elements.policyRuleMode.value, 'all');
  let row = subject.elements.policyRules.children[0];
  assert.match(row.children[0].children[0].children[0].textContent, /Image selection/);
  await row.children[1].children[0].listeners.click();
  assert.equal(subject.elements.policyRuleMode.value, 'selected_images');
  subject.elements.policyRuleMode.value = 'page';
  subject.elements.policyRuleVisibility.value = 'normal';
  await controller.submitRule({ preventDefault() {} });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].capture_mode, 'page');
  assert.equal(stored[0].visibility, 'normal');
  row = subject.elements.policyRules.children[0];
  await row.children[1].children[0].listeners.click();
  assert.equal(subject.elements.policyRuleMode.value, 'page');
});


test('rule save failures stay next to the action and preserve edits for retry', async () => {
  const subject = fixture();
  let fail = true;
  const controller = createSettingsController({
    source: {
      createCapturePolicyRule: async () => { if (fail) throw Object.assign(new Error('Old server'), { code: 'SERVER_RESTART_REQUIRED' }); },
      getCapturePolicy: async () => ({ visibility: 'private' }),
      listCapturePolicyRules: async () => []
    }, elements: subject.elements, document: subject.document
  });
  subject.elements.policyRulePrefix.value = 'https://x.com/';
  subject.elements.policyRuleMode.value = 'selected_images';
  await controller.submitRule({ preventDefault() {} });
  assert.match(subject.elements.policyRuleError.textContent, /Restart Web Bookmark Hub/);
  assert.equal(subject.elements.policyRuleForm.hidden, false);
  assert.equal(subject.elements.policyRulePrefix.value, 'https://x.com/');
  assert.equal(subject.elements.policyRuleMode.value, 'selected_images');
  assert.deepEqual(subject.elements.policyRuleError.revealOptions, { block: 'nearest' });
  assert.equal(subject.elements.policyRuleForm.submit.disabled, false);
  fail = false;
  await controller.submitRule({ preventDefault() {} });
  assert.equal(subject.elements.policyRuleError.textContent, '');
  assert.equal(subject.elements.policyRuleForm.hidden, true);
  assert.ok(subject.elements.policyRuleStatus.textContent);
});
