import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { usePanelNavigation } from "./usePanelNavigation.js";

vi.hoisted(() => vi.stubGlobal("window", new EventTarget()));
vi.mock("../i18n/IntlProvider.js", () => ({ useI18n: () => ({ t: (id: string) => id }) }));
afterEach(() => vi.unstubAllGlobals());

function fixture(settings: readonly string[] | undefined, initialReleased = true, desktop = false) {
  const page = new EventTarget();
  vi.stubGlobal("window", page);
  vi.stubGlobal("document", { querySelector: () => null });
  const state = { open: false, tab: "" };
  const selectPanel = vi.fn();
  type Args = Parameters<typeof usePanelNavigation>;
  let navigation: ReturnType<typeof usePanelNavigation> | undefined;
  function Harness() {
    navigation = usePanelNavigation(
      {
        readOnly: true,
        services: { capabilities: { mutations: desktop, native: desktop, settings } },
      } as Args[0],
      { view: { panel: "", workspaceView: "" }, selectPanel } as unknown as Args[1],
      {} as Args[2],
      { canCreateSide: false } as Args[3],
      {
        settingsOpen: false,
        setSettingsTab: (tab: string) => {
          state.tab = tab;
        },
        setSettingsOpen: (open: boolean) => {
          state.open = open;
        },
      } as Args[4],
      {} as Args[5],
      initialReleased,
      "bottom",
      { current: null },
    );
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  if (!navigation) throw Error("Navigation not mounted");
  return { navigation, state, selectPanel, page };
}

it("opens an authorized settings page without granting session mutations", () => {
  const f = fixture(["模型服务"]);
  f.navigation.showPanel("进程");
  f.navigation.showPanel("会话配置");
  expect(f.state.open).toBe(false);
  expect(f.selectPanel).not.toHaveBeenCalled();
  f.navigation.showPanel("设置");
  expect(f.state).toEqual({ open: true, tab: "模型服务" });
});

it.each([false, true])("settings shortcut follows the same domain grant: %s", (allowed) => {
  const f = fixture(allowed ? ["模型服务"] : []);
  const unsubscribe = f.navigation.subscribeShortcuts();
  const event = new Event("keydown", { cancelable: true });
  Object.assign(event, { key: ",", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false });
  f.page.dispatchEvent(event);
  expect(f.state.open).toBe(allowed);
  expect(event.defaultPrevented).toBe(allowed);
  unsubscribe();
});

it("an observe-only client cannot open settings through the button handler", () => {
  const f = fixture([]);
  f.navigation.showPanel("设置");
  expect(f.state).toEqual({ open: false, tab: "" });
});

it.each(["direct", "panel", "shortcut"])(
  "opens recovery settings before startup releases via %s",
  (entry) => {
    const f = fixture(["模型服务"], false);
    if (entry === "direct") f.navigation.openSettings("模型服务");
    else if (entry === "panel") f.navigation.showPanel("设置");
    else {
      const unsubscribe = f.navigation.subscribeShortcuts();
      const event = new Event("keydown", { cancelable: true });
      Object.assign(event, {
        key: ",",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      });
      f.page.dispatchEvent(event);
      unsubscribe();
    }
    expect(f.state).toEqual({ open: true, tab: "模型服务" });
    expect(f.selectPanel).not.toHaveBeenCalled();
  },
);

it("does not grant settings or execution panels during failed startup", () => {
  const f = fixture([], false);
  f.navigation.openSettings("模型服务");
  f.navigation.showPanel("进程");
  expect(f.state.open).toBe(false);
  expect(f.selectPanel).not.toHaveBeenCalled();
});
it("a persisted desktop conversation still allows application settings", () => {
  const f = fixture(undefined, true, true);
  f.navigation.showPanel("设置");
  expect(f.state).toEqual({ open: true, tab: "模型服务" });
  f.navigation.openSettings("常规");
  expect(f.state.tab).toBe("常规");
  f.navigation.showPanel("进程");
  expect(f.selectPanel).not.toHaveBeenCalled();
});

it("a persisted desktop conversation still accepts the settings shortcut", () => {
  const f = fixture(undefined, true, true);
  const unsubscribe = f.navigation.subscribeShortcuts();
  const event = new Event("keydown", { cancelable: true });
  Object.assign(event, { key: ",", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false });
  f.page.dispatchEvent(event);
  expect(f.state.open).toBe(true);
  expect(event.defaultPrevented).toBe(true);
  unsubscribe();
});
