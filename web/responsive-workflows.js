(function exposeResponsiveWorkflows(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBHResponsiveWorkflows = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function responsiveWorkflowsFactory() {
  'use strict';

  function nextHeaderState(previous, position, locked) {
    const y = Math.max(0, Number(position) || 0);
    const last = previous || { y, distance: 0, direction: 0, hidden: false };
    if (locked || y <= 160) return { y, distance: 0, direction: 0, hidden: false };
    const movement = y - last.y;
    if (!movement) return { ...last, y };
    const direction = Math.sign(movement);
    const distance = (direction === last.direction ? last.distance : 0) + Math.abs(movement);
    let hidden = last.hidden;
    if (direction > 0 && distance >= 16) hidden = true;
    if (direction < 0 && distance >= 8) hidden = false;
    return { y, direction, distance, hidden };
  }

  function install(options) {
    const win = options.window;
    const doc = options.document;
    const elements = options.elements;
    const t = options.t;
    const media = win.matchMedia('(max-width: 700px)');
    const header = elements.resultsHeader;
    const anchor = doc.createComment('Desktop batch controls');
    elements.batchBar.before(anchor);
    let selectedCount = 0;
    let headerState = nextHeaderState(null, win.scrollY, true);
    let frame = null;

    function revealHeader() {
      headerState = nextHeaderState(headerState, win.scrollY, true);
      header.classList.remove('is-reading-down');
    }

    function syncSelection(count) {
      selectedCount = count;
      const visible = media.matches && count > 0;
      elements.mobileSelection.hidden = !visible;
      elements.mobileSelectedCount.textContent = t('selection.mobileCount', { count });
      doc.documentElement.classList.toggle('has-mobile-selection', visible);
      if (!visible && elements.batchDialog.open) elements.batchDialog.close();
    }

    function syncLayout() {
      if (elements.batchDialog.open) elements.batchDialog.close();
      if (media.matches) elements.batchDialogBody.append(elements.batchBar);
      else anchor.after(elements.batchBar);
      revealHeader();
      syncSelection(selectedCount);
    }

    function onScroll() {
      if (!media.matches || frame !== null) return;
      frame = win.requestAnimationFrame(function updateHeader() {
        frame = null;
        if (!media.matches) { revealHeader(); return; }
        const locked = header.contains(doc.activeElement)
          || Boolean(doc.querySelector('dialog[open]'))
          || !elements.sortPopover.hidden
          || elements.appShell.classList.contains('is-mobile-sidebar-open');
        headerState = nextHeaderState(headerState, win.scrollY, locked);
        header.classList.toggle('is-reading-down', headerState.hidden);
      });
    }

    elements.mobileBatchOpen.addEventListener('click', function openActions() {
      if (!media.matches || selectedCount === 0) return;
      revealHeader();
      options.openDialog(elements.batchDialog, elements.mobileBatchOpen);
      elements.batchAiSummary.focus();
    });
    elements.mobileBatchDone.addEventListener('click', options.clearSelection);
    // Native dialog backdrop dismissal retains selection; Done owns clearing it.
    let backdropPress = false;
    function onBackdrop(event) {
      const rect = elements.batchDialog.getBoundingClientRect();
      return event.target === elements.batchDialog && (event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom);
    }
    elements.batchDialog.addEventListener('pointerdown', function rememberBackdrop(event) { backdropPress = onBackdrop(event); });
    elements.batchDialog.addEventListener('click', function closeBackdrop(event) {
      if (backdropPress && onBackdrop(event)) elements.batchDialog.close();
      backdropPress = false;
    });
    header.addEventListener('focusin', revealHeader);
    media.addEventListener('change', syncLayout);
    win.addEventListener('scroll', onScroll, { passive: true });
    syncLayout();
    return { revealHeader, syncSelection };
  }

  return { install, nextHeaderState };
}));
