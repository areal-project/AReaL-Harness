import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { IntlProvider } from "react-intl";
import { catalogs } from "./i18n/messages.js";
import type { Action, Data } from "./services.js";

const storage = vi.hoisted(() => {
  const map = new Map<string, string>();
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  });
  return map;
});

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

vi.mock("./prompt-editor/ChatPromptEditor.js", () => ({
  ChatPromptEditor: (props: Record<string, unknown>) =>
    createElement("div", {
      "data-testid": props.inputTestId,
      "data-initial-value": props.initialValue,
      "data-submit-disabled": String(props.submitDisabled),
      "data-placeholder": props.placeholder,
    }),
}));

import { CloudComposer } from "./CloudComposer.js";
import { setPendingMessage } from "./pendingMessage.js";

beforeEach(() => {
  storage.clear();
  setPendingMessage("areal-gui:draft:p1:new");
  setPendingMessage("areal-gui:draft:p1:cloud-1");
});

function renderComposer(props: {
  project?: Data;
  thread?: Data;
  cloudConfigured?: boolean;
  cloudStatusChecking?: boolean;
  cloudStatusError?: string;
  onOpenCloudSettings?: () => void;
}) {
  return renderToStaticMarkup(
    createElement(
      IntlProvider,
      { locale: "zh-CN", messages: catalogs["zh-CN"] },
      createElement(CloudComposer, {
        project: props.project ?? { id: "p1", root: "/tmp/demo" },
        action: vi.fn(async () => ({})) as unknown as Action,
        ...props,
      }),
    ),
  );
}

describe("CloudComposer", () => {
  it("never shows a disconnected warning in draft mode and preserves shared draft text", () => {
    storage.set("areal-gui:draft:p1:new", "run tests in cloud sandbox");
    const html = renderComposer({ cloudConfigured: true });
    expect(html).not.toContain("Cloud 未连接");
    expect(html).not.toContain("恢复连接");
    expect(html).toContain('data-initial-value="run tests in cloud sandbox"');
    expect(html).toContain('data-submit-disabled="false"');
  });

  it("shows setup guidance below the composer and disables submission when Cloud is unconfigured", () => {
    storage.set("areal-gui:draft:p1:new", "pending prompt");
    const html = renderComposer({
      cloudConfigured: false,
      onOpenCloudSettings: () => {},
    });
    expect(html).toContain("尚未配置云端服务");
    expect(html).toContain("前往云端设置");
    expect(html).toContain('data-submit-disabled="true"');
    expect(html).not.toContain("Cloud 未连接");
    // 引导提示位于输入框下方，不占据输入框上方空间。
    expect(html.indexOf('data-testid="cloud-chat-input"')).toBeLessThan(
      html.indexOf("尚未配置云端服务"),
    );
  });

  it("renders outgoing Cloud draft in draft-message-preview with sandbox elapsed time instead of a top banner", () => {
    setPendingMessage("areal-gui:draft:p1:new", {
      text: "run cloud tests",
      files: [],
      previousUserIds: [],
      starting: true,
      status: "cloud.startingSandbox",
      startedAt: Date.now() - 8_000,
    });
    const html = renderComposer({ cloudConfigured: true });
    expect(html).toContain("draft-message-preview");
    expect(html).toContain("run cloud tests");
    expect(html).toContain("正在连接云端并启动沙箱… 8s");
    expect(html).not.toContain('data-testid="feedback-notice"');
  });

  it("renders exactly one Reconnect button for disconnected Cloud conversations", () => {
    const withoutError = renderComposer({
      thread: {
        id: "cloud-1",
        turns: [],
        cloud: { sessionId: "s1", connected: false },
      },
    });
    expect(withoutError.match(/恢复连接/g)?.length).toBe(1);

    const withError = renderComposer({
      thread: {
        id: "cloud-1",
        turns: [],
        cloud: {
          sessionId: "s1",
          connected: false,
          error: "Cloud 尚未连接，请重新连接以读取远端历史",
        },
      },
    });
    expect(withError.match(/恢复连接/g)?.length).toBe(1);
  });
});
