const transientPrefixes = new Set();
const transientValues = new Map();
const owns = (key, prefix) => key === prefix || key.startsWith(`${prefix}:`);
const transient = (key) => [...transientPrefixes].some((prefix) => owns(key, prefix));
const pending = new Map();
let timer;

export function flushComposerDrafts() {
  clearTimeout(timer);
  timer = undefined;
  for (const [key, value] of pending) {
    globalThis.localStorage.setItem(key, value);
    pending.delete(key);
  }
}

// 刷新、隐藏和失焦前落盘；普通输入先更新内存，合并短时间内的同步存储工作。
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushComposerDrafts);
  window.addEventListener("beforeunload", flushComposerDrafts);
  window.addEventListener("blur", flushComposerDrafts, true);
  window.addEventListener("visibilitychange", flushComposerDrafts);
}

export const composerDraftStorage = {
  getItem(key) {
    return transient(key)
      ? (transientValues.get(key) ?? null)
      : (pending.get(key) ?? globalThis.localStorage.getItem(key));
  },
  scheduleItem(key, value) {
    if (transient(key)) {
      transientValues.set(key, String(value));
      return;
    }
    pending.set(key, String(value));
    // 不随每次按键延后，持续输入也有有界的落盘窗口。
    timer ??= setTimeout(flushComposerDrafts, 150);
  },
  setItem(key, value) {
    pending.delete(key);
    if (transient(key)) transientValues.set(key, String(value));
    else globalThis.localStorage.setItem(key, value);
  },
  removeItem(key) {
    pending.delete(key);
    if (transient(key)) transientValues.delete(key);
    else globalThis.localStorage.removeItem(key);
  },
};
export function registerTransientComposer(projectId, threadId) {
  transientPrefixes.add(`areal-gui:draft:${projectId}:${threadId}`);
  transientPrefixes.add(`areal-gui:review-comments:${projectId}:${threadId}`);
}
export function forgetTransientComposer(projectId, threadId) {
  for (const prefix of [
    `areal-gui:draft:${projectId}:${threadId}`,
    `areal-gui:review-comments:${projectId}:${threadId}`,
  ]) {
    for (const key of transientValues.keys()) if (owns(key, prefix)) transientValues.delete(key);
    for (const key of pending.keys()) if (owns(key, prefix)) pending.delete(key);
    transientPrefixes.delete(prefix);
  }
}

/** @param {{kind:"projectless"}|{kind:"project",projectId:string}|{kind:"thread",projectId:string,threadId:string}} destination */
export function stageComposerDraft(destination, text, append = false) {
  const key =
    destination.kind === "projectless"
      ? "areal-gui:draft:projectless:new"
      : `areal-gui:draft:${destination.projectId}:${destination.kind === "thread" ? destination.threadId : "new"}`;
  const previous = composerDraftStorage.getItem(key) ?? "";
  if (append ? !previous.trimEnd().endsWith(text.trimEnd()) : !previous.trim())
    composerDraftStorage.setItem(key, append && previous.trim() ? `${previous}\n${text}` : text);
  if (destination.kind === "projectless") composerDraftStorage.setItem(`${key}:intent`, "schedule");
  requestAnimationFrame(() =>
    window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: key })),
  );
  return key;
}
