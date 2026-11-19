import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { expect, it, vi } from "vite-plus/test";
import { catalogs } from "./i18n/messages.js";
vi.hoisted(() => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

import { ComposerWorkspaceContext } from "./ComposerWorkspaceContext.js";

it.each([false, true])(
  "offers explicit reconnect when scheduling is suppressed, connected=%s",
  (connected) => {
    const html = renderToStaticMarkup(
      createElement(
        IntlProvider,
        { locale: "zh-CN", messages: catalogs["zh-CN"] },
        createElement(ComposerWorkspaceContext, {
          project: {
            id: "p",
            root: "/tmp/p",
            scheduling: { suppressed: true },
            state: { connected },
          },
          backendReady: true,
          action: vi.fn(),
        }),
      ),
    );
    expect(html).toContain("重新连接项目");
  },
);
