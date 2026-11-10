import { useEffect, useRef, useState } from "react";
import { currentErrorText } from "../errors/currentErrorText.js";
import { applyThemeWithoutTransitions } from "@areal/ui/theme";
import type { PlatformServices } from "../services.js";
import { useAppearance } from "../settings/applicationPreferences.js";

export function useWorkbenchAppearance(
  services: PlatformServices,
  onError: (message: string) => void,
) {
  const [themeReady, setThemeReady] = useState(false);
  const [uiFontSize, setUiFontSize] = useState(
    () => Number(localStorage.getItem("areal-gui:font-size")) || 14,
  );
  useEffect(() => {
    document.documentElement.style.setProperty("--ui-font-size", `${uiFontSize}px`);
    localStorage.setItem("areal-gui:font-size", String(uiFontSize));
  }, [uiFontSize]);
  const [dark, setDark] = useState(false);
  useAppearance(dark);
  const [theme, setTheme] = useState(() => localStorage.getItem("areal-gui:theme") ?? "data-dense");
  const [sidebar, setSidebar] = useState(() => !matchMedia("(max-width: 640px)").matches);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem("areal-gui:sidebar-width"));
    return Number.isFinite(saved) && saved >= 240 && saved <= 520 ? saved : 320;
  });
  useEffect(() => {
    localStorage.setItem("areal-gui:sidebar-width", String(sidebarWidth));
  }, [sidebarWidth]);
  const previousSidebar = useRef(sidebar);
  useEffect(() => {
    if (previousSidebar.current === sidebar) return;
    previousSidebar.current = sidebar;
    document
      .querySelector<HTMLButtonElement>(`[aria-label="${sidebar ? "收起侧栏" : "展开侧栏"}"]`)
      ?.focus();
  }, [sidebar]);
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("areal-gui:collapsed-sidebar") ?? "{}");
      return saved && typeof saved === "object" && !Array.isArray(saved)
        ? (Object.fromEntries(
            Object.entries(saved).filter(([, value]) => typeof value === "boolean"),
          ) as Record<string, boolean>)
        : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    localStorage.setItem("areal-gui:collapsed-sidebar", JSON.stringify(collapsedProjects));
  }, [collapsedProjects]);
  const toggleSidebarGroup = (id: string) =>
    setCollapsedProjects((current) => ({ ...current, [id]: !current[id] }));

  useEffect(
    () =>
      services.onTheme((next) => {
        setDark(next.dark);
        applyTheme(next);
      }),
    [services],
  );
  useEffect(() => {
    localStorage.setItem("areal-gui:theme", theme);
    void services
      .theme(theme)
      .then((next) => {
        setDark(next.dark);
        applyTheme(next);
      })
      .catch((cause) => onError(currentErrorText(cause)))
      .finally(() => setThemeReady(true));
  }, [theme, services]);
  return {
    dark,
    theme,
    setTheme,
    themeReady,
    uiFontSize,
    setUiFontSize,
    sidebar,
    setSidebar,
    sidebarWidth,
    setSidebarWidth,
    collapsedProjects,
    setCollapsedProjects,
    toggleSidebarGroup,
  };
}

function applyTheme(theme: Awaited<ReturnType<PlatformServices["theme"]>>) {
  const root = document.documentElement;
  root.classList.toggle("platform-mac-desktop", theme.platform === "darwin");
  applyThemeWithoutTransitions(root, () => {
    root.classList.toggle("dark", theme.dark);
    root.classList.toggle("theme-areal-light", !theme.dark);
    root.classList.toggle("theme-areal-dark", theme.dark);
    root.style.colorScheme = theme.dark ? "dark" : "light";
  });
}
