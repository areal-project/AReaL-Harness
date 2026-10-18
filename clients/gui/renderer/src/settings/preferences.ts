import { useSyncExternalStore } from "react";
import {
  DEFAULT_CODE_PREVIEW_SETTINGS,
  type CodePreviewSettings,
} from "../lib/codePreviewSettings.js";
import { CODE_PREVIEW_THEME_OPTIONS } from "../lib/codePreviewPreferences.js";
const key = "areal-gui:code-preview";
function read(): CodePreviewSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
    const validTheme = (value: string) =>
      CODE_PREVIEW_THEME_OPTIONS.some((option) => option.value === value);
    return {
      lightTheme: validTheme(saved.lightTheme)
        ? saved.lightTheme
        : DEFAULT_CODE_PREVIEW_SETTINGS.lightTheme,
      darkTheme: validTheme(saved.darkTheme)
        ? saved.darkTheme
        : DEFAULT_CODE_PREVIEW_SETTINGS.darkTheme,
      showLineNumbers: saved.showLineNumbers !== false,
      wrapLongLines: saved.wrapLongLines === true,
      fontSizePx:
        Number.isFinite(saved.fontSizePx) && saved.fontSizePx >= 10 && saved.fontSizePx <= 24
          ? saved.fontSizePx
          : 12,
    };
  } catch {
    return DEFAULT_CODE_PREVIEW_SETTINGS;
  }
}
let value = read();
const listeners = new Set<() => void>();
export function setCodePreferences(patch: Partial<CodePreviewSettings>) {
  const next = { ...value, ...patch };
  localStorage.setItem(key, JSON.stringify(next));
  value = next;
  listeners.forEach((listener) => listener());
}
export function useCodePreferences() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => value,
  );
}
