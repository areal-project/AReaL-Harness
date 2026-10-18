import { useLayoutEffect, useSyncExternalStore } from "react";
import {
  UI_FONTS,
  CODE_FONTS,
  normalizeApplicationSettings,
  paletteVariables,
  type ApplicationSettings,
} from "./applicationSettings.js";
const key = "areal-gui:application-preferences";
let value: ApplicationSettings;
try {
  value = normalizeApplicationSettings(
    JSON.parse(localStorage.getItem(key) ?? "{}"),
  );
} catch {
  value = normalizeApplicationSettings(null);
}
const listeners = new Set<() => void>();
export function setApplicationPreferences(patch: Partial<ApplicationSettings>) {
  const next = normalizeApplicationSettings({ ...value, ...patch });
  localStorage.setItem(key, JSON.stringify(next));
  value = next;
  listeners.forEach((listener) => listener());
}
export function useApplicationPreferences() {
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
// One effective motion preference serves CSS and Web Animations/scrolling.
const motionQuery = typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
const subscribeMotion = (listener: () => void) => {
  motionQuery?.addEventListener("change", listener);
  return () => motionQuery?.removeEventListener("change", listener);
};
export function useReducedMotion() {
  const { reducedMotion } = useApplicationPreferences();
  const system = useSyncExternalStore(subscribeMotion, () => motionQuery?.matches ?? false);
  return reducedMotion === "on" || (reducedMotion === "system" && system);
}
export function useAppearance(dark: boolean) {
  const prefs = useApplicationPreferences();
  const reducedMotion = useReducedMotion();
  useLayoutEffect(() => {
    document.documentElement.dataset.reducedMotion = String(reducedMotion);
    const palette = prefs[dark ? "dark" : "light"], fonts = palette.fonts;
    const vars = {
      "--interactive-cursor": prefs.pointerCursor ? "pointer" : "default",
      "-webkit-font-smoothing": prefs.fontSmoothing ? "antialiased" : "auto",
      ...paletteVariables(palette, dark),
      "--font-sans": UI_FONTS[fonts.uiFont],
      "--font-content":
        UI_FONTS[
          fonts.contentFont === "inherit" ? fonts.uiFont : fonts.contentFont
        ],
      "--font-mono": CODE_FONTS[fonts.codeFont],
      "--content-font-size": `${prefs.contentSize}px`,
    };
    for (const [name, value] of Object.entries(vars))
      document.documentElement.style.setProperty(name, value);
  }, [prefs, dark, reducedMotion]);
}
