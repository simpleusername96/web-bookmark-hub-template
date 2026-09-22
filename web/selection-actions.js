(function selectionActions(window, document) {
  'use strict';
  const byId = id => document.getElementById(id);
  const icon = name => window.WBHIcons.create(name);
  const t = (key, values) => window.WBHUiLanguage.text(key, values);
  const editor = byId('batch-editor');
  const menu = byId('batch-more-menu');
  const operation = byId('batch-operation');
  const media = window.matchMedia('(max-width: 700px)');
  const triggers = [...document.querySelectorAll('[data-batch-action]')];
  let returnTarget = null;

  window.WBHIcons.mount(document);
  document.querySelectorAll('.sort-option span:last-child').forEach(function mountDirection(node) {
    const label = node.textContent;
    node.replaceChildren(document.createTextNode(label.replace(/[↑↓]/g, '').trim()), icon(label.includes('↑') ? 'up' : 'down'));
  });

  function hidePopup(node) {
    if (node.matches(':popover-open')) node.hidePopover();
  }

  function closeEditor(focus) {
    if (media.matches) editor.hidden = true;
    else hidePopup(editor);
    triggers.forEach(button => button.setAttribute('aria-expanded', 'false'));
    if (focus && returnTarget?.getClientRects().length) returnTarget.focus();
  }

  function place(node, anchor) {
    const rect = anchor.getBoundingClientRect();
    const width = node === editor ? 320 : 220;
    node.style.left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)) + 'px';
    node.style.top = Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 360)) + 'px';
  }

  function syncEditor() {
    const value = operation.value;
    const tagAction = value === 'add_tags' || value === 'remove_tags';
    operation.hidden = !tagAction;
    [...operation.options].forEach(option => { option.hidden = tagAction && !['add_tags', 'remove_tags'].includes(option.value); });
    const titles = { set_folder: 'action.moveToFolder', set_kind: 'action.setContentType', set_visibility: 'action.setVisibility', delete: 'action.deletePermanently' };
    byId('batch-editor-title').textContent = tagAction ? 'Tags' : t(titles[value] || 'selection.operation');
    byId('batch-delete-hint').hidden = value !== 'delete';
    byId('batch-apply').textContent = t(value === 'delete' ? 'selection.deleteConfirm' : 'action.apply');
    byId('batch-apply').classList.toggle('is-destructive', value === 'delete');
  }

  function showEditor(value, trigger) {
    const anchor = trigger.closest('#batch-more-menu') ? byId('batch-more') : trigger;
    hidePopup(menu);
    returnTarget = anchor;
    byId('batch-editor-feedback').textContent = '';
    operation.value = value;
    operation.dispatchEvent(new Event('change', { bubbles: true }));
    syncEditor();
    triggers.forEach(button => button.setAttribute('aria-expanded', String(button === trigger)));
    if (media.matches) editor.hidden = false;
    else {
      place(editor, anchor);
      if (!editor.matches(':popover-open')) editor.showPopover();
    }
    const first = [...editor.querySelectorAll('select,input')].find(node => !node.hidden && node.getClientRects().length);
    (first || byId('batch-apply')).focus();
  }

  function syncLabels() {
    byId('batch-done').replaceChildren(media.matches ? document.createTextNode(t('selection.clearShort')) : icon('close'));
    byId('batch-editor-close').replaceChildren(icon(media.matches ? 'up' : 'close'));
    byId('batch-editor-close').setAttribute('aria-label', t(media.matches ? 'selection.foldEditor' : 'selection.closeEditor'));
    syncEditor();
  }

  function syncLayout() {
    hidePopup(editor);
    hidePopup(menu);
    if (media.matches) {
      editor.removeAttribute('popover');
      editor.hidden = true;
    } else {
      editor.setAttribute('popover', 'auto');
      editor.hidden = false;
    }
    syncLabels();
  }

  triggers.forEach(button => button.addEventListener('click', () => showEditor(button.dataset.batchAction, button)));
  operation.addEventListener('change', syncEditor);
  byId('batch-editor-close').addEventListener('click', () => closeEditor(true));
  byId('batch-more').addEventListener('click', () => {
    closeEditor(false);
    place(menu, byId('batch-more'));
  });
  byId('batch-ai-summary').addEventListener('click', () => {
    closeEditor(false);
    hidePopup(menu);
  });
  editor.addEventListener('toggle', event => {
    if (event.newState === 'closed') triggers.forEach(button => button.setAttribute('aria-expanded', 'false'));
  });
  new MutationObserver(() => {
    if (byId('batch-bar').hidden) {
      closeEditor(false);
      hidePopup(menu);
    }
  }).observe(byId('batch-bar'), { attributes: true, attributeFilter: ['hidden'] });
  byId('batch-dialog').addEventListener('close', () => { closeEditor(false); hidePopup(menu); });
  document.addEventListener('wbh-languagechange', syncLabels);
  media.addEventListener('change', syncLayout);
  window.addEventListener('resize', () => {
    if (menu.matches(':popover-open')) place(menu, byId('batch-more'));
    if (editor.matches(':popover-open') && returnTarget) place(editor, returnTarget);
  });
  syncLayout();
})(window, document);
