(function exposeDetailView(root, factory) {
  const contentTypes = typeof module === 'object' && module.exports
    ? require('./content-types.js')
    : root?.WBHContentTypes;
  const detailPresentation = typeof module === 'object' && module.exports
    ? require('./detail-presentation.js')
    : root?.WBHDetailPresentation;
  const cardPresentation = typeof module === 'object' && module.exports
    ? require('./card-presentation.js')
    : root?.WBHCardPresentation;
  const api = factory(contentTypes, detailPresentation, cardPresentation);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBHDetailView = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function detailViewFactory(contentTypes, detailPresentation, cardPresentation) {
  'use strict';

  function notePoints(value) {
    const lines = String(value || '').split(/\r?\n/).map(function cleanLine(line) {
      return line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '');
    }).filter(Boolean);
    if (lines.length !== 1 || typeof Intl.Segmenter !== 'function') return lines;
    return Array.from(new Intl.Segmenter('ko', { granularity: 'sentence' }).segment(lines[0]), function sentence(part) {
      return part.segment.trim();
    }).filter(Boolean);
  }

  function createAutosaveCoordinator(options) {
    const settings = options || {};
    const save = typeof settings.save === 'function' ? settings.save : async function noSave(value) { return value; };
    const notify = typeof settings.onState === 'function' ? settings.onState : function noop() {};
    const scheduleTimer = settings.setTimer || setTimeout;
    const cancelTimer = settings.clearTimer || clearTimeout;
    const delay = Number.isFinite(settings.delay) ? Math.max(0, settings.delay) : 650;
    let timer = null;
    let pending = null;
    let inFlight = null;
    let lastResult = true;
    let lastError = null;

    function schedule(value, immediate) {
      pending = value;
      lastError = null;
      notify('dirty');
      if (timer !== null) cancelTimer(timer);
      timer = null;
      if (immediate) return flush();
      timer = scheduleTimer(function saveAfterDelay() { timer = null; void flush(); }, delay);
      return Promise.resolve(true);
    }

    async function flush() {
      if (timer !== null) cancelTimer(timer);
      timer = null;
      if (inFlight) {
        await inFlight.catch(function ignoreHandledFailure() {});
        if (pending) return flush();
        return lastError ? false : lastResult;
      }
      if (!pending) return lastError ? false : lastResult;
      const payload = pending;
      pending = null;
      notify('saving');
      inFlight = Promise.resolve().then(function performSave() { return save(payload); });
      try {
        lastResult = await inFlight;
        lastError = null;
        notify(pending ? 'dirty' : 'saved', null, lastResult);
      } catch (error) {
        lastError = error;
        if (!pending) pending = payload;
        notify('error', error);
      } finally {
        inFlight = null;
      }
      if (pending && !lastError) return flush();
      return lastError ? false : lastResult;
    }

    function hasPending() { return Boolean(timer !== null || pending || inFlight); }
    return { flush, hasPending, schedule };
  }

  function renderDetail(options, deps) {
    const { clear, element, button, iconButton, sourceLabel, visualPreview, externalUrl, formatDate, entryTags, tagList, renderFolderOptions, detailField, detailSelect, windowRef } = deps;
    const t = typeof deps.t === 'function' ? deps.t : function untranslated(key) { return key; };
    const settings = options || {};
    const container = settings.container;
    if (!container) return;
    let entry = settings.entry || {};
    let autosaveStatus = null;
    let actionError = null;
    const assets = Array.isArray(settings.assets) ? settings.assets : [];
    const commentPage = settings.commentPage && !Array.isArray(settings.commentPage)
      ? settings.commentPage
      : { items: Array.isArray(settings.comments) ? settings.comments : [], total: Array.isArray(settings.comments) ? settings.comments.length : 0 };
    const comments = Array.isArray(commentPage.items) ? commentPage.items : [];
    const commentTotal = Math.max(comments.length, Number(commentPage.total) || 0);
    const autosave = createAutosaveCoordinator({
      delay: 650,
      async save(changes) {
        if (typeof settings.onEdit !== 'function') return entry;
        const updated = await settings.onEdit(changes);
        if (updated && typeof updated === 'object') entry = updated;
        return entry;
      },
      onState(state, error) {
        if (!autosaveStatus) return;
        autosaveStatus.dataset.state = state;
        autosaveStatus.textContent = state === 'dirty' ? t('status.dirty')
          : state === 'saving' ? t('status.saving')
            : state === 'saved' ? t('status.saved')
              : state === 'error' ? (error instanceof Error ? error.message : t('status.couldNotSave')) : '';
      }
    });

    container.wbhFlushPendingEdits = async function flushPendingEdits() {
      return (await autosave.flush()) !== false;
    };

    function showActionError(error) {
      if (!actionError) {
        actionError = element('p', 'detail-action-error');
        actionError.setAttribute('role', 'alert');
        container.prepend(actionError);
      }
      actionError.textContent = error instanceof Error ? error.message : t('error.detailAction');
    }

    function renderActions(mode, target) {
      const actionRow = element('div', 'detail-content-actions');
      if (!entry.deleted_at) {
        const modeButton = iconButton(mode === 'edit' ? 'done' : 'edit', t(mode === 'edit' ? 'action.finishEditing' : 'action.editEntry'), 'button button-quiet icon-button', async function toggleMode() {
          if (mode === 'edit' && !(await container.wbhFlushPendingEdits())) return;
          renderMode(mode === 'edit' ? 'read' : 'edit');
          if (mode !== 'edit') container.querySelector('#detail-title')?.focus();
        });
        actionRow.append(modeButton);
      }
      const deleteButton = iconButton('delete', t('action.deleteUrlPermanently'), 'button button-quiet icon-button delete-entry-button', async function deleteUrl() {
        if (!(await container.wbhFlushPendingEdits())) return;
        if (typeof settings.onDelete !== 'function') return;
        if (typeof windowRef.confirm === 'function'
          && !windowRef.confirm(t('confirm.deleteEntry'))) return;
        deleteButton.disabled = true;
        try {
          await settings.onDelete();
        } catch (error) {
          deleteButton.disabled = false;
          showActionError(error);
        }
      });
      if (settings.deleteAvailable === false) {
        deleteButton.disabled = true;
        deleteButton.dataset.tooltip = settings.deleteUnavailableReason || t('status.deleteUnavailable');
      }
      actionRow.append(deleteButton);
      target.append(actionRow);
      if (settings.deleteAvailable === false) {
        target.append(element(
          'p',
          'detail-delete-unavailable',
          settings.deleteUnavailableReason || t('status.deleteUnavailable')
        ));
      }
    }

    function closeButton() {
      const close = iconButton('remove', t('action.closeEntry'), 'button button-quiet icon-button detail-dialog-close');
      close.dataset.dialogClose = '';
      close.dataset.tooltip = t('action.close');
      return close;
    }

    function appendIdentity(target) {
      const presentation = detailPresentation.describe(entry);
      const primary = cardPresentation.describe(entry);
      container.dataset.presentationGroup = presentation.group;
      const lead = element('div', 'detail-lead detail-lead-' + presentation.lead);
      const topRail = element('div', 'detail-top-rail');
      topRail.append(element('strong', 'detail-source', sourceLabel(entry)));
      const metadata = element('div', 'detail-top-metadata');
      const saved = element('time', 'detail-saved-date', formatDate(entry.saved_at));
      if (entry.saved_at) saved.dateTime = entry.saved_at;
      metadata.append(saved, element('span', 'detail-kind', primary.typeLabel));
      topRail.append(metadata, closeButton());
      lead.append(topRail);
      target.append(lead);

      if (primary.state === 'cover') {
        const coverLead = element('div', 'detail-stage detail-stage-cover');
        const coverFallback = element('div', 'detail-cover-fallback');
        if (primary.fallbackSummary) coverFallback.append(element('p', 'detail-stage-summary', primary.fallbackSummary));
        else coverFallback.append(element('strong', '', primary.typeLabel), element('span', '', t('app.previewUnavailable')));
        const detailVisual = visualPreview(entry, 'detail', { ignoreContentFocus: true, requireImage: true, fallbackNode: coverFallback });
        if (detailVisual) coverLead.append(detailVisual);
        if (coverLead.childElementCount) target.append(coverLead);
      } else if (primary.state === 'summary') {
        target.append(element('p', 'detail-stage detail-stage-summary', primary.summary));
      } else {
        target.append(element('div', 'detail-stage detail-stage-type', primary.typeLabel));
      }

      const identity = element('div', 'detail-identity');
      if (primary.title) {
        const identityTitle = element('h3', 'detail-title', primary.title);
        identityTitle.id = 'detail-title';
        identity.append(identityTitle);
      }

      const secondaryRail = element('div', 'detail-identity-facts');
      if (entry.creator_handle) secondaryRail.append(element('span', 'detail-creator', '@' + entry.creator_handle));
      if (secondaryRail.childElementCount) identity.append(secondaryRail);
      target.insertBefore(identity, target.querySelector('.detail-stage'));

      const facts = cardPresentation.enrichmentFacts(entry);
      if (facts.length) {
        const list = element('dl', 'detail-enrichment-facts');
        facts.forEach(function appendFact(fact) {
          list.append(element('dt', '', t(fact.key)));
          const value = element('dd', '', fact.value);
          if (fact.observedAt) value.append(element('small', '', t('enrichment.observed') + ' ' + new Date(fact.observedAt).toLocaleString()));
          if (fact.stale) value.append(element('small', '', t('enrichment.stale')));
          list.append(value);
        });
        target.append(list);
      }

      const tags = entryTags(entry);
      if (tags.length) target.append(tagList(entry, tags.length));

      const originalUrl = externalUrl(entry.url_original || entry.url_canonical);
      const urlRow = element('div', 'detail-url-row');
      if (originalUrl) {
        const link = element('a', 'detail-url', originalUrl);
        link.href = originalUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      link.dataset.tooltip = originalUrl;
        urlRow.append(link);
      } else {
        urlRow.append(element('p', 'detail-url', entry.url_original || t('status.noUrl')));
      }
      target.append(urlRow);
    }

    function appendAssets(target) {
      if (!assets.length) return;
      const section = element('details', 'detail-secondary detail-assets');
      section.append(element('summary', '', t('detail.visualAssets', { count: assets.length })));
      assets.forEach(function appendAsset(asset) {
        const row = element('div', 'asset-row');
        const identity = element('span', 'asset-label', (asset.source_kind || t('detail.assetImage')) + (asset.is_cover ? ' ' + t('detail.assetCover') : ''));
        const controls = element('div', 'asset-actions');
        if (!asset.is_cover) {
          controls.append(iconButton('cover', t('action.useAsCover'), 'button button-quiet icon-button', function chooseCover() {
            if (settings.onSetCover) void settings.onSetCover(asset.id);
          }));
        } else {
          controls.append(iconButton('clearCover', t('action.clearCover'), 'button button-quiet icon-button', function clearCover() {
            if (settings.onClearCover) void settings.onClearCover();
          }));
        }
        controls.append(iconButton('remove', t('action.removeVisualReference'), 'button button-quiet icon-button', function removeAsset() {
          if (settings.onRemoveAsset && (typeof windowRef.confirm !== 'function' || windowRef.confirm(t('confirm.removeVisualReference')))) void settings.onRemoveAsset(asset.id);
        }));
        row.append(identity, controls);
        section.append(row);
      });
      target.append(section);
    }

    function appendNotes(target, editable) {
      if (!editable && !commentTotal) return;
      const section = element('section', 'detail-comments');
      section.setAttribute('aria-label', 'Notes');
      comments.forEach(function appendComment(comment) {
        const points = notePoints(comment && (comment.body || comment.text));
        if (!points.length) return;
        const item = element('ul', 'comment-body note-points');
        points.forEach(function appendPoint(point) { item.append(element('li', '', point)); });
        section.append(item);
      });
      if (comments.length < commentTotal && typeof settings.onLoadMoreComments === 'function') {
        const loadMore = button(t('action.loadMore'), 'button button-quiet');
        loadMore.type = 'button';
        loadMore.dataset.loadMoreNotes = 'true';
        loadMore.addEventListener('click', async function loadMoreNotes() {
          loadMore.disabled = true;
          try {
            if (!(await container.wbhFlushPendingEdits())) { loadMore.disabled = false; return; }
            await settings.onLoadMoreComments();
          } catch (error) {
            loadMore.disabled = false;
            showActionError(error);
          }
        });
        section.append(loadMore);
      }
      if (!editable || entry.deleted_at) {
        target.append(section);
        return;
      }
      const form = element('form', 'comment-form');
      const label = element('label', '', 'Notes');
      const textarea = element('textarea', 'comment-input');
      textarea.name = 'comment';
      textarea.rows = 3;
      textarea.maxLength = 20000;
      textarea.required = true;
      textarea.value = settings.noteDraft || '';
      label.htmlFor = 'detail-comment';
      textarea.id = 'detail-comment';
      const formError = element('p', 'comment-error');
      formError.id = 'detail-comment-error';
      formError.setAttribute('role', 'alert');
      textarea.setAttribute('aria-describedby', formError.id);
      textarea.addEventListener('input', function clearCommentError() {
        formError.textContent = '';
        textarea.removeAttribute('aria-invalid');
      });
      const submitButton = button(t('action.addNote'), 'comment-submit');
      submitButton.type = 'submit';
      form.append(label, textarea, formError, submitButton);
      form.addEventListener('submit', async function submitComment(event) {
        event.preventDefault();
        const body = textarea.value.trim();
        if (!body) {
          formError.textContent = t('validation.writeNote');
          textarea.setAttribute('aria-invalid', 'true');
          textarea.focus();
          return;
        }
        if (typeof settings.onComment !== 'function') return;
        submitButton.disabled = true;
        try {
          if (!(await container.wbhFlushPendingEdits())) { submitButton.disabled = false; return; }
          await settings.onComment(body);
        } catch (error) {
          formError.textContent = error instanceof Error ? error.message : t('error.noteAdd');
          textarea.setAttribute('aria-invalid', 'true');
          submitButton.disabled = false;
        }
      });
      section.append(form);
      target.append(section);
    }

    function renderRead() {
      appendIdentity(container);
      appendNotes(container);
      renderActions('read', container);
    }

    function renderEdit() {
      const header = element('div', 'detail-edit-header');
      header.append(closeButton());
      container.append(header);
      const tags = entryTags(entry);
      const form = element('form', 'detail-edit-form');
      const fields = element('div', 'form-grid');
      const urlField = detailField('URL', 'url', entry.url_original || '', 'url');
      urlField.wrapper.classList.add('form-field-wide');
      const titleField = detailField('Title', 'title', entry.title || '', 'text');
      titleField.wrapper.classList.add('form-field-wide');
      const tagsField = detailField('Tags', 'tags', tags.map(function tagName(tag) { return tag.name || tag.normalized_name; }).join(', '), 'text');
      tagsField.input.placeholder = t('placeholder.commaSeparated');
      tagsField.wrapper.classList.add('form-field-wide');
      if (typeof settings.attachTagSuggestions === 'function') settings.attachTagSuggestions(tagsField.input);
      const folderWrapper = element('div', 'form-field');
      const folderLabel = element('label', '', 'Folder');
      const folderSelect = element('select');
      folderLabel.htmlFor = 'detail-folder';
      folderSelect.id = 'detail-folder';
      renderFolderOptions(folderSelect, settings.folders || []);
      folderSelect.value = entry.folder_id === null || entry.folder_id === undefined ? '' : String(entry.folder_id);
      folderWrapper.append(folderLabel, folderSelect);
      const kindField = detailSelect('Content type', 'detail-kind', contentTypes.optionPairs(), entry.kind || 'page');
      const visibilityField = detailSelect('Visibility', 'detail-visibility', [['normal', 'Normal (local)'], ['private', 'Private']], entry.visibility || 'private');
      fields.append(urlField.wrapper, titleField.wrapper, tagsField.wrapper, folderWrapper, kindField.wrapper, visibilityField.wrapper);
      autosaveStatus = element('p', 'detail-autosave-status', t('status.saved'));
      autosaveStatus.setAttribute('role', 'status');
      autosaveStatus.setAttribute('aria-live', 'polite');
      form.append(fields, autosaveStatus);

      function collectChanges() {
        return {
          url: urlField.input.value.trim(),
          title: titleField.input.value.trim() || null,
          tags: tagsField.input.value.split(',').map(function trimTag(tag) { return tag.trim(); }).filter(Boolean),
          folder_id: folderSelect.value ? Number(folderSelect.value) : null,
          kind: kindField.select.value,
          visibility: visibilityField.select.value
        };
      }

      [urlField.input, titleField.input, tagsField.input].forEach(function bindTextInput(input) {
        input.addEventListener('input', function queueTextSave() { void autosave.schedule(collectChanges(), false); });
      });
      urlField.input.addEventListener('change', function queueUrlSave() { void autosave.schedule(collectChanges(), true); });
      [folderSelect, kindField.select, visibilityField.select].forEach(function bindSelect(select) {
        select.addEventListener('change', function queueSelectSave() { void autosave.schedule(collectChanges(), true); });
      });
      form.addEventListener('submit', function preventExplicitSubmit(event) {
        event.preventDefault();
        void autosave.flush();
      });
      container.append(form);
      appendAssets(container);
      appendNotes(container, true);
      renderActions('edit', container);
    }

    function renderMode(mode) {
      autosaveStatus = null;
      actionError = null;
      clear(container);
      container.dataset.mode = mode;
      container.classList.toggle('is-private', entry.visibility === 'private');
      delete container.dataset.presentationGroup;
      if (mode === 'edit' && !entry.deleted_at) renderEdit();
      else renderRead();
    }

    renderMode(settings.mode === 'edit' ? 'edit' : 'read');
  }

  return { createAutosaveCoordinator, notePoints, renderDetail };
}));
