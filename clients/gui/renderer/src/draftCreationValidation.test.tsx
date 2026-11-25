import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlProvider } from "react-intl";
import { describe, expect, it, vi } from "vite-plus/test";

vi.hoisted(() => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
});

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

import { catalogs } from "./i18n/messages.js";
import { ComposerPermissionMenu } from "./ComposerPermissionMenu.js";
import { validateDraftCreation } from "./DraftComposer.js";
import { profileKey } from "./ProfileDetails.js";

describe("ComposerPermissionMenu three-state capabilities", () => {
  const renderMenu = (props: Partial<Parameters<typeof ComposerPermissionMenu>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(
        IntlProvider,
        { locale: "zh-CN", messages: catalogs["zh-CN"] },
        createElement(ComposerPermissionMenu, {
          value: "ask",
          permissionsSupported: false,
          fullAccessAvailable: false,
          onChange: vi.fn(),
          onClose: vi.fn(),
          ...props,
        }),
      ),
    );

  it("displays the saved preference calmly while capabilities are pending and locks fullAccess", () => {
    const triggerHtml = renderMenu({ capabilitiesPending: true, value: "ask" });
    expect(triggerHtml).toContain("请求审批");
    expect(triggerHtml).not.toContain("不受支持");
    expect(triggerHtml).not.toContain("受限");

    const autoReviewHtml = renderMenu({ capabilitiesPending: true, value: "autoReview" });
    expect(autoReviewHtml).toContain("帮我审批");

    const inlineHtml = renderMenu({
      capabilitiesPending: true,
      value: "ask",
      presentation: "inline",
    });
    expect(inlineHtml).toMatch(/<button[^>]*disabled=""[^>]*data-permission-preset="fullAccess"/);
    expect(inlineHtml).not.toMatch(/<button[^>]*disabled=""[^>]*data-permission-preset="ask"/);
    expect(inlineHtml).toContain("项目就绪后确认可用权限");
  });

  it("still marks explicitly unsupported backends when capabilities are known", () => {
    const html = renderMenu({ capabilitiesPending: false, permissionsSupported: false });
    expect(html).toContain("权限模式不受支持");
  });
});

describe("validateDraftCreation", () => {
  it("rejects creation when online capabilities have not synced yet", () => {
    expect(() => validateDraftCreation({ id: "p1", core: {}, profiles: [] }, "", "ask")).toThrow(
      /能力信息尚未同步/,
    );
  });

  it("rejects fullAccess when current generation revoked fullAccess", () => {
    expect(() =>
      validateDraftCreation(
        {
          id: "p1",
          core: { features: { permissionPresets: true, permissionFullAccess: false } },
          profiles: [],
        },
        "",
        "fullAccess",
      ),
    ).toThrow(/未启用完全访问/);
  });

  it("rejects creation instead of silently dropping an explicit missing profile revision", () => {
    expect(() =>
      validateDraftCreation(
        {
          id: "p1",
          core: { features: { permissionPresets: true, permissionFullAccess: true } },
          profiles: [{ id: "custom", revision: "rev-2" }],
        },
        profileKey({ id: "custom", revision: "rev-1" }),
        "ask",
      ),
    ).toThrow(/任务配置尚未加载或已失效/);
  });

  it("allows read-only profiles and verified writable permissions", () => {
    expect(() =>
      validateDraftCreation(
        {
          id: "p1",
          core: { features: { permissionPresets: false, permissionFullAccess: false } },
          profiles: [{ id: "reader", revision: "r1", readOnly: true }],
        },
        profileKey({ id: "reader", revision: "r1" }),
        "fullAccess",
      ),
    ).not.toThrow();

    expect(() =>
      validateDraftCreation(
        {
          id: "p1",
          core: { features: { permissionPresets: true, permissionFullAccess: true } },
          profiles: [{ id: "builder", revision: "r1", readOnly: false }],
        },
        profileKey({ id: "builder", revision: "r1" }),
        "fullAccess",
      ),
    ).not.toThrow();
  });
});
