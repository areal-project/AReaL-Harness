import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { usePanelNavigation } from "./usePanelNavigation.js";

vi.hoisted(() => vi.stubGlobal("window", new EventTarget()));
vi.mock("../i18n/IntlProvider.js", () => ({ useI18n: () => ({ t: (id: string) => id }) }));
afterEach(() => vi.unstubAllGlobals());

function fixture(settings: readonly string[]) {
  const page = new EventTarget();
  vi.stubGlobal("window", page);
  vi.stubGlobal("document", { querySelector: () => null });
  const state = { open: false, tab: "" };
  const selectPanel = vi.fn();
  type Args = Parameters<typeof usePanelNavigation>;
  let navigation: ReturnType<typeof usePanelNavigation> | undefined;
  function Harness() {
    navigation = usePanelNavigation(
      { readOnly: true, services: { capabilities: { mutations: false, native: false, settings } } } as Args[0],
      { view: { panel: "", workspaceView: "" }, selectPanel } as unknown as Args[1],
      {} as Args[2],
      { canCreateSide: false } as Args[3],
      {
        settingsOpen: false,
        setSettingsTab: (tab: string) => { state.tab = tab; },
        setSettingsOpen: (open: boolean) => { state.open = open; },
      } as Args[4],
      {} as Args[5],
      true,
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
