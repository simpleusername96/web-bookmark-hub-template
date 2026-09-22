"use strict";

const elements = {};
const UrlTagSuggestions = globalThis.WBHCaptureTagSuggestions;
const ExistingTagSuggestions = globalThis.WBHTagSuggestions;
let currentStatus = null;
let busy = false;
let tagsEdited = false;
let metadataSessionId = null;

document.addEventListener("DOMContentLoaded", () => { void initialize(); }, { once: true });

async function initialize() {
  cacheElements();
  bindEvents();
  ExistingTagSuggestions.create({
    input: elements.tags,
    document,
    fetchSuggestions(options) {
      return message({ type: "WBH_TAG_SUGGESTIONS", query: options.query, exclude: options.exclude });
    }
  });
  await refresh();
}

function cacheElements() {
  [
    "capture-visibility", "clear-selection", "connect-registry", "connection-status",
    "folder", "message", "note",
    "pairing-panel", "preview-empty", "preview-list", "preview-panel", "refresh-selection", "save-selection", "save-tab",
    "selection-controls", "selection-panel", "selection-summary", "start-selection", "stop-selection", "tab-url", "tags", "tags-hint",
    "result-entry"
  ].forEach((id) => { elements[camel(id)] = document.getElementById(id); });
}

function bindEvents() {
  elements.connectRegistry.addEventListener("click", () => { void openConnection(); });
  elements.saveTab.addEventListener("click", () => { void saveCurrentTab(); });
  elements.startSelection.addEventListener("click", () => { void startSelection(); });
  elements.stopSelection.addEventListener("click", () => { void stopSelection(); });
  elements.refreshSelection.addEventListener("click", () => { void refreshSelection(); });
  elements.saveSelection.addEventListener("click", () => { void saveSelection(); });
  elements.clearSelection.addEventListener("click", () => { void clearSelection(); });
  elements.tags.addEventListener("input", () => { tagsEdited = true; });
}

async function refresh() {
  setBusy(true);
  try {
    currentStatus = await message({ type: "WBH_GET_STATUS" });
    const connected = currentStatus.connection.connected;
    const selection = currentStatus.selection || {};
    const storedFolderId = selection.id && selection.id !== metadataSessionId
      ? selection.userMetadata?.folderId
      : undefined;
    renderStatus(currentStatus);
    try {
      renderFolders(connected ? await message({ type: "WBH_LIST_FOLDERS" }) : [], {
        connected,
        storedFolderId
      });
    } catch (error) {
      renderFolders([], { connected, storedFolderId });
      show(`Registry 연결은 확인됐지만 폴더 목록을 불러오지 못했어요. ${error.message || "다시 시도하세요."}`, true);
    }
  } catch (error) {
    show(error.message || "확장 상태를 불러오지 못했어요.", true);
  } finally {
    setBusy(false);
  }
}

function renderStatus(status) {
  const connected = status.connection.connected;
  const eligible = Boolean(status.tab?.url);
  const selection = status.selection || { active: false };
  if (selection.id && selection.id !== metadataSessionId) {
    const draft = selection.userMetadata || {};
    elements.note.value = draft.comment || "";
    elements.tags.value = (draft.tags || []).join(", ");
    elements.folder.value = draft.folderId ? String(draft.folderId) : "";
    elements.captureVisibility.value = draft.visibility || "default";
    metadataSessionId = selection.id;
  } else if (!selection.active) {
    metadataSessionId = null;
  }
  elements.connectionStatus.textContent = connected
    ? `연결됨 · ${status.connection.client?.label || "Chrome"} · ${status.connection.baseUrl}`
    : status.connection.state === "unavailable"
      ? "서버가 실행 중이 아니에요. Fastrun Manager에서 시작하세요."
      : "Web UI에서 이 확장 프로그램을 승인하세요.";
  elements.pairingPanel.hidden = connected;
  elements.tabUrl.textContent = pageLabel(status.tab?.url);
  renderSuggestedTags(status.tab?.url || "");
  const hasPending = Boolean(selection.hasPendingPayload);
  elements.selectionPanel.hidden = !selection.active && !hasPending;
  elements.selectionControls.hidden = !selection.active;
  elements.previewPanel.hidden = !hasPending;
  elements.startSelection.hidden = selection.active;
  elements.selectionSummary.textContent = hasPending
    ? `${selection.assetCount || 0}개 이미지 · ${selection.selectedCount || 0}개 링크`
    : "선택 모드";
  renderPreview(selection.preview || []);
  const stagedAssetCount = Number(selection.assetCount) || 0;
  elements.saveSelection.textContent = stagedAssetCount
    ? `선택 항목 저장 (${stagedAssetCount})`
    : "선택 항목 저장";

  elements.startSelection.disabled = busy || !connected || !eligible || selection.active;
  elements.stopSelection.disabled = busy || !selection.active;
  elements.refreshSelection.disabled = busy || !selection.active;
  elements.saveTab.disabled = busy || !connected || !eligible;
  elements.saveSelection.disabled = busy || !connected || !selection.hasPendingPayload;
  elements.clearSelection.disabled = busy || !selection.hasPendingPayload;
  elements.connectRegistry.disabled = busy;
  [elements.note, elements.tags, elements.folder, elements.captureVisibility]
    .forEach((input) => { input.disabled = busy; });
}

function renderSuggestedTags(pageUrl) {
  const suggestions = UrlTagSuggestions.fromUrl(pageUrl);
  const usingSuggestion = !tagsEdited && !metadataSessionId;
  if (usingSuggestion) elements.tags.value = suggestions.join(", ");
  elements.tagsHint.textContent = suggestions.length && usingSuggestion
    ? "추천 태그 · 저장 전 편집 가능"
    : "쉼표로 구분";
}

function renderPreview(items) {
  elements.previewList.replaceChildren();
  items.forEach((item) => {
    const row = document.createElement("li");
    row.className = "previewItem";
    const title = document.createElement("strong");
    title.textContent = item.title || item.entryUrl;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${item.assetCount}개 이미지 · ${item.entryUrl}`;
    row.append(title, meta);
    elements.previewList.append(row);
  });
  elements.previewEmpty.hidden = items.length > 0;
}

function renderFolders(folders, { connected = true, storedFolderId } = {}) {
  const selected = elements.folder.value || (storedFolderId ? String(storedFolderId) : "");
  elements.folder.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "없음";
  elements.folder.append(empty);
  function append(folder, depth) {
    const option = document.createElement("option");
    option.value = String(folder.id);
    option.textContent = `${"— ".repeat(depth)}${folder.name}`;
    elements.folder.append(option);
    (folder.children || []).forEach((child) => append(child, depth + 1));
  }
  (folders || []).forEach((folder) => append(folder, 0));
  if (selected && !connected) {
    const pending = document.createElement("option");
    pending.value = selected;
    pending.textContent = `폴더 #${selected} · 연결 후 확인`;
    elements.folder.append(pending);
  }
  if ([...elements.folder.options].some((option) => option.value === selected)) elements.folder.value = selected;
}

async function openConnection() {
  await runAction("Web UI를 여는 중…", async () => {
    await message({ type: "WBH_OPEN_CONNECTION" });
    return "열린 Web UI에서 Chrome 연결을 승인하세요.";
  });
}

async function saveCurrentTab() {
  await runAction("현재 탭을 저장하는 중…", async () => {
    const draft = metadata();
    const outcome = await message({ type: "WBH_SAVE_CURRENT_TAB", metadata: draft });
    const duplicate = outcome.summary?.entriesCreated === 0 && outcome.summary?.entriesAlreadySaved > 0;
    return {
      text: outcome.summary?.entriesSaved
        ? (duplicate ? duplicateMessage(draft, outcome.archived) : "저장됨")
        : "현재 탭을 저장하지 못했어요.",
      entryUrl: outcome.entryUrl
    };
  });
}

async function startSelection() {
  await runAction("이미지 선택 버튼을 붙이고 있어요…", async () => {
    await message({ type: "WBH_START_SELECTION", metadata: metadata() });
    return "선택 모드를 시작했어요.";
  });
}

async function stopSelection() {
  await runAction("선택 모드를 멈추는 중…", async () => {
    await message({ type: "WBH_STOP_SELECTION" });
    return "현재 탭의 선택 모드를 멈췄어요.";
  });
}

async function refreshSelection() {
  await runAction("이미지 선택 버튼을 다시 확인하는 중…", async () => {
    await message({ type: "WBH_RESCAN_SELECTION" });
    return "이미지 선택 버튼과 선택 상태를 다시 동기화했어요.";
  });
}

async function saveSelection() {
  await runAction("선택 항목을 Registry에 저장하는 중…", async () => {
    const draft = metadata();
    const outcome = await message({ type: "WBH_SAVE_STAGED_SELECTION", metadata: draft });
    const summary = outcome.summary || {};
    if (!outcome.completed) {
      const issues = [];
      if (summary.itemsFailed) issues.push(`${summary.itemsFailed}개 항목 실패`);
      if (summary.localCopiesFailed) issues.push(`이미지 캐시 ${summary.localCopiesFailed}개 실패`);
      if (summary.referencesFailed) issues.push(`이미지 참조 ${summary.referencesFailed}개 실패`);
      return `${summary.entriesSaved || 0}개 URL은 저장됨 · ${issues.length ? issues.join(" · ") : "저장 결과 없음"}. 선택은 재시도를 위해 유지했어요.`;
    }
    const duplicate = !summary.entriesCreated && summary.entriesAlreadySaved;
    return {
      text: duplicate
        ? duplicateMessage(draft, outcome.archived)
        : summary.entriesAlreadySaved
          ? `${summary.entriesCreated || 0}개 저장 · ${summary.entriesAlreadySaved}개는 이미 저장됨`
          : `${summary.entriesCreated || 0}개 저장됨`,
      entryUrl: outcome.entryUrl
    };
  });
}

async function clearSelection() {
  await runAction("선택을 지우는 중…", async () => {
    await message({ type: "WBH_CLEAR_STAGED_SELECTION" });
    return "현재 선택을 지웠어요.";
  });
}

async function runAction(pending, action) {
  setBusy(true);
  show(pending);
  try {
    const outcome = await action();
    if (outcome && typeof outcome === "object") show(outcome.text, false, outcome.entryUrl);
    else show(outcome);
    await refresh();
  } catch (error) {
    show(error.message || "작업을 완료하지 못했어요.", true);
  } finally {
    setBusy(false);
  }
}

function metadata() {
  const policy = {};
  if (elements.captureVisibility.value !== "default") policy.visibility = elements.captureVisibility.value;
  return {
    comment: elements.note.value.trim() || undefined,
    tags: elements.tags.value.split(",").map((tag) => tag.trim()).filter(Boolean),
    folderId: elements.folder.value ? Number(elements.folder.value) : undefined,
    ...policy
  };
}

function duplicateMessage(draft, archived) {
  const fields = [
    draft.comment && "메모",
    draft.tags?.length && "태그",
    draft.folderId && "폴더",
    draft.visibility && "공개 범위"
  ].filter(Boolean);
  const prefix = archived ? "보관된 기존 주소입니다." : "이미 저장된 주소입니다.";
  return fields.length ? `${prefix} 입력한 ${fields.join(", ")} 값은 적용되지 않았습니다.` : prefix;
}

function pageLabel(pageUrl) {
  if (!pageUrl) return "이 페이지는 저장할 수 없어요.";
  try {
    const url = new URL(pageUrl);
    return url.hostname.replace(/^www\./, "") + (url.pathname === "/" ? "" : url.pathname);
  } catch (_error) {
    return "이 페이지는 저장할 수 없어요.";
  }
}

async function message(payload) {
  const response = await chrome.runtime.sendMessage(payload);
  if (!response?.ok) {
    const error = new Error(response?.error?.message || "확장 작업에 실패했어요.");
    error.code = response?.error?.code;
    throw error;
  }
  return response.data;
}

function setBusy(value) {
  busy = value;
  if (currentStatus) renderStatus(currentStatus);
}

function show(text, error = false, entryUrl = null) {
  elements.message.textContent = text || "";
  elements.message.classList.toggle("is-error", error);
  elements.resultEntry.hidden = !entryUrl;
  if (entryUrl) elements.resultEntry.href = entryUrl;
  else elements.resultEntry.removeAttribute("href");
}

function camel(value) {
  return value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}
