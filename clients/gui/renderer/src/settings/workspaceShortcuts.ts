import { useSyncExternalStore } from "react";

export type WorkspaceShortcutKey = "pinSummary" | "threadFind";

const DEFAULTS: Record<WorkspaceShortcutKey, string> = {
  pinSummary: "⌘+⇧+S",
  threadFind: "⌘+F",
};

const STORAGE_KEY = "areal-gui:workspace-shortcuts:v1";
const CHANGE_EVENT = "areal-workspace-shortcuts-changed";

let cachedRaw: string | null = null;
let cachedValue: Record<WorkspaceShortcutKey, string> = DEFAULTS;

function readShortcuts(): Record<WorkspaceShortcutKey, string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === cachedRaw) return cachedValue;
    cachedRaw = raw;
    if (!raw) {
      cachedValue = DEFAULTS;
      return cachedValue;
    }
    const parsed = JSON.parse(raw) as Partial<Record<WorkspaceShortcutKey, unknown>>;
    cachedValue = {
      pinSummary: typeof parsed.pinSummary === "string" ? parsed.pinSummary : DEFAULTS.pinSummary,
      threadFind: typeof parsed.threadFind === "string" ? parsed.threadFind : DEFAULTS.threadFind,
    };
    return cachedValue;
  } catch {
    return DEFAULTS;
  }
}

export function setWorkspaceShortcut(key: WorkspaceShortcutKey, value: string) {
  const next = { ...readShortcuts(), [key]: value };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {}
  cachedRaw = null;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function resetWorkspaceShortcut(key: WorkspaceShortcutKey) {
  setWorkspaceShortcut(key, DEFAULTS[key]);
}

export function useWorkspaceShortcuts(): Record<WorkspaceShortcutKey, string> {
  return useSyncExternalStore(
    (onStoreChange) => {
      window.addEventListener(CHANGE_EVENT, onStoreChange);
      window.addEventListener("storage", onStoreChange);
      return () => {
        window.removeEventListener(CHANGE_EVENT, onStoreChange);
        window.removeEventListener("storage", onStoreChange);
      };
    },
    readShortcuts,
    () => DEFAULTS,
  );
}

/** 匹配 ShortcutCapture 生成的组合键字符串（同时兼容 macOS ⌘ 与 Windows/Linux Ctrl）。 */
export function matchesWorkspaceShortcut(event: KeyboardEvent, combo: string): boolean {
  if (!combo.trim()) return false;
  const parts = combo.split("+").map((part) => part.trim());
  const keyPart = parts.at(-1)?.toLowerCase();
  if (!keyPart) return false;
  const mods = new Set(parts.slice(0, -1));
  const wantMeta = mods.has("⌘");
  const wantCtrl = mods.has("Ctrl");
  const wantAlt = mods.has("⌥");
  const wantShift = mods.has("⇧");
  const primaryMatches =
    wantMeta && !wantCtrl
      ? event.metaKey || event.ctrlKey
      : event.metaKey === wantMeta && event.ctrlKey === wantCtrl;
  return (
    primaryMatches &&
    event.altKey === wantAlt &&
    event.shiftKey === wantShift &&
    event.key.toLowerCase() === keyPart
  );
}
