(function exposeSettingsController(root, factory) {
  const uiLanguage = typeof module === 'object' && module.exports ? require('./ui-language.js') : root?.WBHUiLanguage;
  const api = factory(uiLanguage);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBHCreateSettingsController = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function settingsControllerFactory(defaultUiLanguage) {
  'use strict';

  function createSettingsController(options) {
    const settings = options || {};
    const source = settings.source;
    const elements = settings.elements || {};
    const documentRef = settings.document;
    const i18n = settings.i18n || defaultUiLanguage;
    const t = function translate(key, values) { return i18n?.text ? i18n.text(key, values) : key; };
    const confirmAction = settings.confirm || function reject() { return false; };
    const setStatus = settings.setStatus || function noop() {};
    const refreshEntries = settings.refreshEntries || async function noopRefresh() {};
    const onFoldersChanged = settings.onFoldersChanged || async function noopFolders() {};
    const connectExtension = settings.connectExtension || async function unavailable() {
      throw new Error('Chrome extension messaging is unavailable.');
    };
    const onConnectionApproved = settings.onConnectionApproved || function noopApproval() {};
    let pendingExtensionId = '';
    let chromeClients = [];
    let showAllClients = false;
    let activePanel = 'add';
    let editingRuleId = null;
    let aiPollTimer = null;

    function renderAiUrlSummary(summary) {
      const running = summary.status === 'running';
      const count = summary.available_count ?? summary.eligible_count ?? 0;
      elements.aiUrlSummaryCount.textContent = t('settings.aiCount', { count });
      elements.aiUrlSummaryStart.textContent = t(running ? 'settings.aiQueueAll' : 'settings.aiRunAll', { count });
      elements.aiUrlSummaryStart.disabled = count === 0;
      if (running) {
        elements.aiUrlSummaryStatus.textContent = t('settings.aiRunning', {
          processed: summary.progress?.processed || 0,
          total: summary.progress?.total || 0
        }) + (summary.queued_count ? ` ${t('settings.aiWaiting', { count: summary.queued_count })}` : '');
      } else if (summary.last_run) {
        const counts = summary.last_run.counts || {};
        elements.aiUrlSummaryStatus.textContent = t('settings.aiFinished', {
          complete: counts.complete || 0,
          partial: counts.partial || 0,
          failed: counts.failed || 0
        }) + (counts.skipped ? ` ${t('settings.aiSkipped', { count: counts.skipped })}` : '');
      } else {
        elements.aiUrlSummaryStatus.textContent = t('settings.aiReady');
      }
    }

    async function refreshAiUrlSummary() {
      elements.aiUrlSummaryError.textContent = '';
      const summary = await source.getAiUrlSummary();
      renderAiUrlSummary(summary);
      return summary;
    }

    function scheduleAiUrlSummaryRefresh() {
      if (aiPollTimer) clearTimeout(aiPollTimer);
      aiPollTimer = setTimeout(async function pollAiUrlSummary() {
        aiPollTimer = null;
        try {
          const summary = await refreshAiUrlSummary();
          if (summary.status === 'running') scheduleAiUrlSummaryRefresh();
          else {
            await refreshEntries();
            setStatus(elements.aiUrlSummaryStatus.textContent, summary.last_run?.counts?.failed ? 'warning' : 'success');
          }
        } catch (error) {
          elements.aiUrlSummaryStart.disabled = true;
          elements.aiUrlSummaryError.textContent = error?.code === 'ROUTE_NOT_FOUND'
            ? t('error.aiServerRestart')
            : error instanceof Error ? error.message : t('error.aiSummaryLoad');
        }
      }, 1500);
    }

    async function startAiUrlSummary() {
      elements.aiUrlSummaryStart.disabled = true;
      elements.aiUrlSummaryError.textContent = '';
      elements.aiUrlSummaryStatus.textContent = t('settings.aiStarting');
      try {
        const summary = await source.startAiUrlSummary({ mode: 'all' });
        renderAiUrlSummary(summary);
        if (summary.status === 'running') scheduleAiUrlSummaryRefresh();
        return summary;
      } catch (error) {
        if (error?.code === 'AI_SUMMARY_BUSY') {
          try {
            const summary = await refreshAiUrlSummary();
            if (summary.status === 'running') scheduleAiUrlSummaryRefresh();
            return summary;
          } catch (refreshError) {
            error = refreshError;
          }
        }
        elements.aiUrlSummaryStart.disabled = false;
        elements.aiUrlSummaryError.textContent = error?.code === 'ROUTE_NOT_FOUND'
          ? t('error.aiServerRestart')
          : error instanceof Error ? error.message : t('error.aiSummaryStart');
        return null;
      }
    }

    function flattenFolders(tree, depth, output) {
      const result = output || [];
      (tree || []).forEach(function append(folder) {
        result.push({ ...folder, depth: depth || 0 });
        flattenFolders(folder.children, (depth || 0) + 1, result);
      });
      return result;
    }

    function renderFolderOptions(select, folders, selected, excludedIds) {
      select.replaceChildren();
      const top = documentRef.createElement('option');
      top.value = '';
      top.textContent = t('settings.topLevel');
      select.append(top);
      const excluded = excludedIds || new Set();
      flattenFolders(folders).forEach(function appendOption(folder) {
        if (excluded.has(folder.id)) return;
        const option = documentRef.createElement('option');
        option.value = String(folder.id);
        option.textContent = `${'— '.repeat(folder.depth)}${folder.name}`;
        select.append(option);
      });
      select.value = selected === null || selected === undefined ? '' : String(selected);
    }

    async function refreshFolderSettings() {
      elements.folderManagerError.textContent = '';
      const folders = await source.listFolders();
      renderFolderOptions(elements.folderCreateParent, folders);
      elements.folderManagerList.replaceChildren();
      const flat = flattenFolders(folders);
      if (!flat.length) {
        const empty = documentRef.createElement('p');
        empty.className = 'detail-empty';
        empty.textContent = t('settings.noFolders');
        elements.folderManagerList.append(empty);
        return;
      }
      flat.forEach(function renderFolder(folder) {
        const row = documentRef.createElement('article');
        row.className = 'folder-manager-row';
        const name = documentRef.createElement('input');
        name.type = 'text';
        name.maxLength = 200;
        name.value = folder.name;
        name.setAttribute('aria-label', t('settings.renameFolder', { name: folder.name }));
        const parent = documentRef.createElement('select');
        parent.setAttribute('aria-label', t('settings.parentFor', { name: folder.name }));
        const descendants = new Set(flat.filter(function descendant(candidate) {
          let cursor = candidate;
          while (cursor && cursor.parent_id !== null) {
            if (cursor.parent_id === folder.id) return true;
            cursor = flat.find(function byId(item) { return item.id === cursor.parent_id; });
          }
          return false;
        }).map(function id(candidate) { return candidate.id; }));
        descendants.add(folder.id);
        renderFolderOptions(parent, folders, folder.parent_id, descendants);
        const facts = documentRef.createElement('span');
        facts.className = 'folder-manager-facts';
        facts.textContent = t('settings.children', { entries: folder.entry_count || 0, children: (folder.children || []).length });
        const rename = actionButton(t('action.rename'), async function renameManagedFolder() {
          await source.updateFolder(folder.id, { name: name.value.trim() });
          await onFoldersChanged();
          await refreshFolderSettings();
        }, t('error.folderRename'), elements.folderManagerError);
        const move = actionButton(t('action.move'), async function moveManagedFolder() {
          await source.updateFolder(folder.id, { parent_id: parent.value ? Number(parent.value) : null });
          await onFoldersChanged();
          await refreshFolderSettings();
        }, t('error.folderMove'), elements.folderManagerError);
        const remove = actionButton(t('action.delete'), async function deleteManagedFolder() {
          if (!confirmAction(t('confirm.deleteFolder', { name: folder.name }))) return;
          await source.deleteFolder(folder.id);
          await onFoldersChanged();
          await refreshFolderSettings();
        }, t('error.folderDelete'), elements.folderManagerError);
        const actions = documentRef.createElement('div');
        actions.className = 'folder-manager-actions';
        actions.append(rename, move, remove);
        row.append(name, parent, facts, actions);
        elements.folderManagerList.append(row);
      });
    }

    async function submitFolder(event) {
      event.preventDefault();
      const submit = elements.folderCreateForm.querySelector('button[type="submit"]');
      submit.disabled = true;
      elements.folderManagerError.textContent = '';
      try {
        await source.createFolder({
          name: elements.folderCreateName.value.trim(),
          parent_id: elements.folderCreateParent.value ? Number(elements.folderCreateParent.value) : null
        });
        elements.folderCreateName.value = '';
        await onFoldersChanged();
        await refreshFolderSettings();
        elements.folderCreateName.focus();
      } catch (error) {
        elements.folderManagerError.textContent = error instanceof Error ? error.message : t('error.folderCreate');
      } finally {
        submit.disabled = false;
      }
    }

    async function refreshChromeClients() {
      chromeClients = await source.listClients();
      renderChromeClients();
    }

    function renderChromeClients() {
      const activeClients = chromeClients
        .filter(function active(client) { return !client.revoked_at; })
        .sort(function newestActivity(left, right) {
          const leftAt = String(left.last_used_at || left.created_at || '');
          const rightAt = String(right.last_used_at || right.created_at || '');
          return rightAt.localeCompare(leftAt) || Number(right.id || 0) - Number(left.id || 0);
        });
      const revokedClients = chromeClients.filter(function revoked(client) { return Boolean(client.revoked_at); });
      const clients = showAllClients ? activeClients.concat(revokedClients) : activeClients.slice(0, 3);
      elements.chromeClients.replaceChildren();
      if (!clients.length) {
        const empty = documentRef.createElement('p');
        empty.className = 'sidebar-empty';
        empty.textContent = t(chromeClients.length ? 'settings.noActiveClients' : 'settings.noClients');
        elements.chromeClients.append(empty);
      } else clients.forEach(function renderClient(client) {
        const row = documentRef.createElement('div');
        row.className = 'client-row';
        const label = documentRef.createElement('span');
        label.textContent = client.label + (client.revoked_at ? ' ' + t('settings.revoked') : '');
        row.append(label);
        if (!client.revoked_at) {
          const revoke = documentRef.createElement('button');
          revoke.className = 'button button-quiet';
          revoke.type = 'button';
          revoke.textContent = t('action.revoke');
          revoke.addEventListener('click', async function revokeClient() {
            if (!confirmAction(t('confirm.revokeClient', { name: client.label }))) return;
            revoke.disabled = true;
            try {
              await source.revokeClient(client.id);
              await refreshChromeClients();
              setStatus(t('settings.clientRevoked', { name: client.label }), 'success');
            } catch (error) {
              elements.chromeError.textContent = error instanceof Error ? error.message : t('error.clientRevoke');
            } finally {
              revoke.disabled = false;
            }
          });
          row.append(revoke);
        }
        elements.chromeClients.append(row);
      });
      elements.chromeClientsShowAll.hidden = showAllClients || clients.length === chromeClients.length;
      elements.chromeClientsShowAll.textContent = t('action.showAll', { count: chromeClients.length });
    }

    function showAllChromeClients() {
      showAllClients = true;
      renderChromeClients();
    }

    function requestChromeApproval(extensionId) {
      pendingExtensionId = String(extensionId || '').trim();
      const valid = /^[a-p]{32}$/.test(pendingExtensionId);
      elements.chromeError.textContent = '';
      elements.chromeConnectionRequest.hidden = !valid;
      elements.chromeConnectionGuidance.hidden = valid;
      if (!valid) elements.chromeError.textContent = t('error.chromeRequest');
      return valid;
    }

    async function approveChromeConnection() {
      if (!/^[a-p]{32}$/.test(pendingExtensionId)) return false;
      elements.chromeApproveButton.disabled = true;
      elements.chromeError.textContent = '';
      try {
        const pairing = await source.createPairingCode();
        await connectExtension(pendingExtensionId, { code: pairing.code, label: 'Chrome' });
        elements.chromeConnectionRequest.hidden = true;
        elements.chromeConnectionGuidance.hidden = false;
        elements.chromeConnectionGuidance.textContent = t('settings.clientConnected');
        await refreshChromeClients();
        onConnectionApproved();
        setStatus(t('settings.chromeConnected'), 'success');
        pendingExtensionId = '';
        return true;
      } catch (error) {
        elements.chromeError.textContent = error instanceof Error ? error.message : t('error.chromeConnect');
        return false;
      } finally {
        elements.chromeApproveButton.disabled = false;
      }
    }

    async function refreshPolicySettings() {
      elements.policyError.textContent = '';
      const [policy, rules] = await Promise.all([source.getCapturePolicy(), source.listCapturePolicyRules()]);
      elements.policyDefaultVisibility.value = policy.visibility;
      elements.policyDefaultStorage.value = policy.selected_image_storage || 'reference_only';
      elements.policyRules.replaceChildren();
      if (!rules.length) {
        const empty = documentRef.createElement('p');
        empty.className = 'detail-empty';
        empty.textContent = t('settings.noRules');
        elements.policyRules.append(empty);
        return;
      }
      rules.forEach(function renderRule(rule) {
        const row = documentRef.createElement('article');
        row.className = 'policy-rule-row';
        const details = documentRef.createElement('details');
        details.className = 'policy-rule-details';
        const summary = documentRef.createElement('summary');
        summary.className = 'policy-rule-summary';
        const scope = documentRef.createElement('strong');
        scope.textContent = `${rule.hostname}${rule.path_prefix} — ${t("rule.mode." + (rule.capture_mode || "all"))}`;
        const stateText = documentRef.createElement('span');
        stateText.textContent = rule.enabled ? 'Enabled' : 'Disabled';
        summary.append(scope, stateText);
        const facts = documentRef.createElement('dl');
        facts.className = 'policy-rule-facts';
        [
          ['URL scope', `${rule.hostname}${rule.path_prefix}`],
          [t('rule.saveMethod'), t('rule.mode.' + (rule.capture_mode || 'all'))],
          ['Content type', rule.kind || 'Detect from URL'],
          ['Add tags', rule.tags?.length ? rule.tags.map(function tagName(tag) { return tag.name || tag; }).join(', ') : 'None'],
          ['Visibility', rule.visibility],
          ['State', rule.enabled ? 'Enabled' : 'Disabled']
        ].forEach(function appendFact(fact) {
          const term = documentRef.createElement('dt');
          term.textContent = fact[0];
          const value = documentRef.createElement('dd');
          value.textContent = fact[1];
          facts.append(term, value);
        });
        details.append(summary, facts);
        const actions = documentRef.createElement('div');
        actions.className = 'asset-actions';
        const edit = actionButton(t('action.edit'), async function editRule() {
          editingRuleId = rule.id;
          elements.policyRulePrefix.value = `https://${rule.hostname}${rule.path_prefix}`;
          elements.policyRuleKind.value = rule.kind || '';
          elements.policyRuleMode.value = rule.capture_mode || 'all';
          elements.policyRuleTags.value = (rule.tags || []).map(function tagName(tag) { return tag.name || tag; }).join(', ');
          elements.policyRuleVisibility.value = rule.visibility;
          setRuleEditorOpen(true);
        }, t('error.ruleOpen'));
        const toggle = actionButton(t(rule.enabled ? 'action.disable' : 'action.enable'), async function toggleRule() {
          await source.updateCapturePolicyRule(rule.id, { enabled: !rule.enabled });
          await refreshPolicySettings();
        }, t('error.ruleChange'));
        const apply = actionButton(t('action.previewApply'), async function previewRule() {
          const preview = await source.previewCapturePolicyRule(rule.id);
          if (preview.match_count === 0) {
            setStatus(t('settings.ruleNoMatches'), 'quiet');
            return;
          }
          const names = (preview.rule.tags || []).map(function tagName(tag) { return tag.name || tag; });
          const tagNotice = names.length ? ` Missing tags (${names.join(', ')}) will be added; existing tags remain.` : '';
          if (!confirmAction(t('confirm.applyRule', {
            count: preview.match_count,
            entries: preview.match_count === 1 ? 'Entry' : 'Entries',
            tagNotice
          }))) return;
          const outcome = await source.applyCapturePolicyRule(rule.id, 'Applied after web UI preview.');
          await refreshEntries();
          setStatus(t('settings.ruleUpdatedExisting', { count: outcome.updated_count, entries: outcome.updated_count === 1 ? 'Entry' : 'Entries' }), 'success');
        }, t('error.ruleApply'));
        const remove = actionButton(t('action.delete'), async function deleteRule() {
          if (!confirmAction(t('confirm.deleteRule', { scope: `${rule.hostname}${rule.path_prefix}` }))) return;
          await source.deleteCapturePolicyRule(rule.id);
          await refreshPolicySettings();
        }, t('error.ruleDelete'));
        actions.append(edit, toggle, apply, remove);
        row.append(details, actions);
        elements.policyRules.append(row);
      });
    }

    function actionButton(label, action, fallbackMessage, errorTarget) {
      const control = documentRef.createElement('button');
      control.className = 'button button-quiet';
      control.type = 'button';
      control.textContent = label;
      control.addEventListener('click', async function runAction() {
        control.disabled = true;
        try { await action(); }
        catch (error) { (errorTarget || elements.policyError).textContent = error instanceof Error ? error.message : fallbackMessage; }
        finally { control.disabled = false; }
      });
      return control;
    }

    async function activate(panelName, activateOptions) {
      const panel = ['add', 'view', 'folders', 'rules', 'guide', 'chrome', 'ai'].includes(panelName) ? panelName : activePanel;
      activePanel = panel;
      elements.settingsTabs.forEach(function updateTab(tab) {
        const active = tab.dataset.settingsPanel === panel;
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
      });
      elements.settingsPanels.forEach(function updatePanel(content) {
        content.hidden = content.dataset.settingsContent !== panel;
      });
      elements.settingsTabs.find(function find(tab) { return tab.dataset.settingsPanel === panel; })
        ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      if (activateOptions?.focusContent && panel === 'add') elements.addUrl?.focus();
      else if (activateOptions?.focusContent && panel === 'view') elements.settingsView?.focus();
      else if (activateOptions?.focusContent && panel === 'folders') elements.folderCreateName?.focus();
      else if (activateOptions?.focusTab || activateOptions?.focusContent) elements.settingsTabs.find(function find(tab) { return tab.dataset.settingsPanel === panel; })?.focus();
      if (panel === 'chrome') {
        elements.chromeError.textContent = '';
        try { await refreshChromeClients(); }
        catch (error) { elements.chromeError.textContent = error instanceof Error ? error.message : t('error.chromeLoad'); }
      } else if (panel === 'folders') {
        try { await refreshFolderSettings(); }
        catch (error) { elements.folderManagerError.textContent = error instanceof Error ? error.message : t('error.folderLoad'); }
      } else if (panel === 'rules') {
        try { await refreshPolicySettings(); }
        catch (error) { elements.policyError.textContent = error instanceof Error ? error.message : t('error.policyLoad'); }
      } else if (panel === 'ai') {
        try {
          const summary = await refreshAiUrlSummary();
          if (summary.status === 'running') scheduleAiUrlSummaryRefresh();
        } catch (error) {
          elements.aiUrlSummaryStart.disabled = true;
          elements.aiUrlSummaryError.textContent = error?.code === 'ROUTE_NOT_FOUND'
            ? t('error.aiServerRestart')
            : error instanceof Error ? error.message : t('error.aiSummaryLoad');
        }
      }
      return panel;
    }

    async function submitDefault(event) {
      event.preventDefault();
      const submit = elements.policyDefaultForm.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        await source.updateCapturePolicy({
          visibility: elements.policyDefaultVisibility.value,
          selected_image_storage: elements.policyDefaultStorage.value
        });
        setStatus(t('settings.defaultSaved'), 'success');
      } catch (error) {
        elements.policyError.textContent = error instanceof Error ? error.message : t('status.couldNotSave');
      } finally { submit.disabled = false; }
    }

    async function submitRule(event) {
      event.preventDefault();
      const submit = elements.policyRuleForm.querySelector('button[type="submit"]');
      submit.disabled = true;
      elements.policyRuleError.textContent = '';
      elements.policyRuleStatus.textContent = '';
      try {
        const rule = {
          url_prefix: elements.policyRulePrefix.value.trim(),
          kind: elements.policyRuleKind.value || null,
          capture_mode: elements.policyRuleMode.value || 'all',
          visibility: elements.policyRuleVisibility.value,
          tags: elements.policyRuleTags.value.split(',').map(function trimTag(tag) { return tag.trim(); }).filter(Boolean)
        };
        if (editingRuleId === null) await source.createCapturePolicyRule(rule);
        else await source.updateCapturePolicyRule(editingRuleId, rule);
        const changedExistingRule = editingRuleId !== null;
        setRuleEditorOpen(false);
        await refreshPolicySettings();
        elements.policyRuleStatus.textContent = t(changedExistingRule ? 'settings.ruleUpdated' : 'settings.ruleAdded');
        setStatus(elements.policyRuleStatus.textContent, 'success');
      } catch (error) {
        elements.policyRuleError.textContent = error?.code === 'SERVER_RESTART_REQUIRED'
          ? t('error.ruleServerRestart')
          : (error instanceof Error ? error.message : t('error.ruleSave'));
        elements.policyRuleError.scrollIntoView?.({ block: 'nearest' });
      } finally { submit.disabled = false; }
    }

    function setRuleEditorOpen(open) {
      elements.policyRuleError.textContent = '';
      elements.policyRuleStatus.textContent = '';
      if (!open) {
        editingRuleId = null;
        elements.policyRulePrefix.value = '';
        elements.policyRuleKind.value = '';
        elements.policyRuleMode.value = 'all';
        elements.policyRuleTags.value = '';
      }
      elements.policyRuleForm.hidden = !open;
      elements.policyRuleToggle.setAttribute('aria-expanded', String(open));
      elements.policyRuleToggle.textContent = t(open ? 'action.cancel' : 'action.addUrlRule');
      elements.policyRuleForm.querySelector('button[type="submit"]').textContent = t(editingRuleId === null ? 'action.addRule' : 'action.saveChanges');
      if (open) elements.policyRulePrefix.focus();
    }

    function toggleRuleEditor() {
      setRuleEditorOpen(elements.policyRuleForm.hidden);
    }

    return {
      activePanel: function getActivePanel() { return activePanel; },
      activate: activate,
      approveChromeConnection: approveChromeConnection,
      refreshChromeClients: refreshChromeClients,
      refreshFolderSettings: refreshFolderSettings,
      refreshPolicySettings: refreshPolicySettings,
      requestChromeApproval: requestChromeApproval,
      showAllChromeClients: showAllChromeClients,
      startAiUrlSummary: startAiUrlSummary,
      submitDefault: submitDefault,
      submitFolder: submitFolder,
      submitRule: submitRule,
      toggleRuleEditor: toggleRuleEditor
    };
  }

  return createSettingsController;
}));
