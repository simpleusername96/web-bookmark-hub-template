(function exposeTagSuggestions(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBHTagSuggestions = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function tagSuggestionsFactory() {
  'use strict';

  let nextId = 1;

  function tokenAt(value, caret) {
    const text = String(value || '');
    const position = Number.isSafeInteger(caret) ? Math.max(0, Math.min(caret, text.length)) : text.length;
    const commaBefore = text.lastIndexOf(',', Math.max(0, position - 1));
    const commaAfter = text.indexOf(',', position);
    const start = commaBefore + 1;
    const end = commaAfter === -1 ? text.length : commaAfter;
    return { start, end, query: text.slice(start, end).trim() };
  }

  function completedTokens(value, active) {
    return String(value || '').split(',').map(function trim(token) { return token.trim(); })
      .filter(Boolean)
      .filter(function excludeActive(_token, index) {
        let offset = 0;
        const parts = String(value || '').split(',');
        for (let itemIndex = 0; itemIndex < index; itemIndex += 1) offset += parts[itemIndex].length + 1;
        return offset < active.start || offset > active.end;
      });
  }

  function replaceToken(value, active, suggestion) {
    const text = String(value || '');
    const segment = text.slice(active.start, active.end);
    const leading = segment.match(/^\s*/u)?.[0] || '';
    const trailing = segment.match(/\s*$/u)?.[0] || '';
    const replacement = leading + suggestion + trailing;
    return {
      value: text.slice(0, active.start) + replacement + text.slice(active.end),
      caret: active.start + leading.length + String(suggestion).length
    };
  }

  function create(options) {
    const settings = options || {};
    const input = settings.input;
    const documentRef = settings.document || input?.ownerDocument;
    const fetchSuggestions = settings.fetchSuggestions;
    if (!input || !documentRef || typeof fetchSuggestions !== 'function') return null;
    if (input.dataset.tagSuggestionsAttached === 'true') return null;
    input.dataset.tagSuggestionsAttached = 'true';

    const host = documentRef.createElement('div');
    host.className = 'tag-combobox';
    input.parentNode.insertBefore(host, input);
    host.append(input);
    const list = documentRef.createElement('div');
    list.className = 'tag-suggestion-list';
    list.id = 'tag-suggestions-' + nextId++;
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    host.append(list);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('aria-expanded', 'false');

    let timer = null;
    let requestController = null;
    let requestSequence = 0;
    let suggestions = [];
    let activeIndex = -1;
    let suppressNextInput = false;

    function close() {
      requestSequence += 1;
      requestController?.abort();
      requestController = null;
      suggestions = [];
      activeIndex = -1;
      list.replaceChildren();
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }

    function choose(index) {
      const suggestion = suggestions[index];
      if (!suggestion) return;
      const active = tokenAt(input.value, input.selectionStart);
      const replaced = replaceToken(input.value, active, suggestion.name);
      input.value = replaced.value;
      input.setSelectionRange(replaced.caret, replaced.caret);
      suppressNextInput = true;
      close();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function render(items) {
      suggestions = (Array.isArray(items) ? items : []).slice(0, 8)
        .filter(function valid(item) { return item && String(item.name || '').trim(); })
        .map(function normalized(item) { return { name: String(item.name).trim(), entry_count: Number(item.entry_count) || 0 }; });
      activeIndex = suggestions.length ? 0 : -1;
      list.replaceChildren();
      suggestions.forEach(function appendSuggestion(suggestion, index) {
        const option = documentRef.createElement('button');
        option.type = 'button';
        option.className = 'tag-suggestion-option';
        option.id = list.id + '-option-' + index;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(index === activeIndex));
        option.tabIndex = -1;
        option.textContent = suggestion.entry_count ? `${suggestion.name} (${suggestion.entry_count})` : suggestion.name;
        option.addEventListener('pointerdown', function retainInputFocus(event) { event.preventDefault(); });
        option.addEventListener('click', function selectSuggestion() { choose(index); });
        list.append(option);
      });
      list.hidden = !suggestions.length;
      input.setAttribute('aria-expanded', String(Boolean(suggestions.length)));
      syncActive();
    }

    function syncActive() {
      Array.from(list.children).forEach(function updateOption(option, index) {
        option.setAttribute('aria-selected', String(index === activeIndex));
      });
      const activeOption = list.children[activeIndex];
      if (activeOption) input.setAttribute('aria-activedescendant', activeOption.id);
      else input.removeAttribute('aria-activedescendant');
    }

    async function refresh() {
      const active = tokenAt(input.value, input.selectionStart);
      if (!active.query) {
        close();
        return;
      }
      requestController?.abort();
      const sequence = ++requestSequence;
      requestController = typeof AbortController === 'function' ? new AbortController() : null;
      try {
        const items = await fetchSuggestions({
          query: active.query,
          exclude: completedTokens(input.value, active),
          limit: 8,
          signal: requestController?.signal
        });
        if (sequence !== requestSequence) return;
        requestController = null;
        render(items);
      } catch (_error) {
        if (sequence === requestSequence) close();
      }
    }

    input.addEventListener('input', function scheduleSuggestions() {
      if (suppressNextInput) {
        suppressNextInput = false;
        return;
      }
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(function runSuggestionQuery() { timer = null; void refresh(); }, 150);
    });
    input.addEventListener('keydown', function navigateSuggestions(event) {
      if (event.key === 'Escape') {
        if (list.hidden) return;
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (!suggestions.length || !['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Enter') {
        choose(activeIndex);
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      activeIndex = (activeIndex + step + suggestions.length) % suggestions.length;
      syncActive();
    });
    input.addEventListener('blur', function closeAfterBlur() {
      setTimeout(close, 0);
    });

    return { close, refresh };
  }

  return { completedTokens, create, replaceToken, tokenAt };
}));
