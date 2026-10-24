const transientPrefixes = new Set();
const transientValues = new Map();
const owns = (key, prefix) => key === prefix || key.startsWith(`${prefix}:`);
const transient = key => [...transientPrefixes].some(prefix => owns(key, prefix));

export const composerDraftStorage = {
  getItem(key) { return transient(key) ? transientValues.get(key) ?? null : globalThis.localStorage.getItem(key); },
  setItem(key, value) {
    if (transient(key)) transientValues.set(key, String(value));
    else globalThis.localStorage.setItem(key, value);
  },
  removeItem(key) {
    if (transient(key)) transientValues.delete(key);
    else globalThis.localStorage.removeItem(key);
  },
};
export function registerTransientComposer(projectId, threadId) {
  transientPrefixes.add(`areal-gui:draft:${projectId}:${threadId}`);
  transientPrefixes.add(`areal-gui:review-comments:${projectId}:${threadId}`);
}
export function forgetTransientComposer(projectId, threadId) {
  for (const prefix of [`areal-gui:draft:${projectId}:${threadId}`, `areal-gui:review-comments:${projectId}:${threadId}`]) {
    for (const key of transientValues.keys()) if (owns(key, prefix)) transientValues.delete(key);
    transientPrefixes.delete(prefix);
  }
}
