import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { IntlProvider } from "react-intl";
import { catalogs } from "./i18n/messages.js";
import type { Action, Data } from "./services.js";

const hooks = vi.hoisted(() => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
  return {
    states: new Map<number, unknown>(),
    refs: new Map<number, { current: unknown }>(),
    effects: [] as Array<{ fn: () => void | (() => void); deps?: unknown[]; cleanup?: () => void }>,
    stateIdx: 0,
    refIdx: 0,
    effectIdx: 0,
    mounted: false,
    reset() {
      for (const effect of this.effects) effect.cleanup?.();
      this.states.clear();
      this.refs.clear();
      this.effects = [];
      this.stateIdx = 0;
      this.refIdx = 0;
      this.effectIdx = 0;
      this.mounted = false;
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
    useState: (initial: unknown) => {
      if (!hooks.mounted) return react.useState(initial);
      const index = hooks.stateIdx++;
      if (!hooks.states.has(index)) {
        hooks.states.set(
          index,
          typeof initial === "function" ? (initial as () => unknown)() : initial,
        );
      }
      const setState = (next: unknown) => {
        const prev = hooks.states.get(index);
        hooks.states.set(
          index,
          typeof next === "function" ? (next as (value: unknown) => unknown)(prev) : next,
        );
      };
      return [hooks.states.get(index), setState];
    },
    useRef: (initial: unknown) => {
      if (!hooks.mounted) return react.useRef(initial);
      const index = hooks.refIdx++;
      if (!hooks.refs.has(index)) hooks.refs.set(index, { current: initial });
      return hooks.refs.get(index);
    },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      if (!hooks.mounted) return react.useEffect(fn, deps);
      const index = hooks.effectIdx++;
      const prev = hooks.effects[index];
      const changed =
        !prev ||
        !deps ||
        !prev.deps ||
        deps.length !== prev.deps.length ||
        deps.some((value, i) => !Object.is(value, prev.deps![i]));
      if (changed) {
        prev?.cleanup?.();
        const cleanup = fn() || undefined;
        hooks.effects[index] = { fn, deps, cleanup };
      }
    },
  };
});

import { ComposerWorkspaceContext } from "./ComposerWorkspaceContext.js";

afterEach(() => {
  hooks.reset();
});

function renderContext(props: {
  project: Data;
  threadId?: string;
  action?: Action;
  backendReady?: boolean;
  showBranch?: boolean;
  cloud?: boolean;
  quietConnecting?: boolean;
}) {
  hooks.mounted = true;
  hooks.stateIdx = 0;
  hooks.refIdx = 0;
  hooks.effectIdx = 0;
  return renderToStaticMarkup(
    createElement(
      IntlProvider,
      { locale: "zh-CN", messages: catalogs["zh-CN"] },
      createElement(ComposerWorkspaceContext, {
        action: props.action ?? (vi.fn(async () => ({})) as unknown as Action),
        backendReady: props.backendReady ?? true,
        ...props,
      }),
    ),
  );
}

describe("ComposerWorkspaceContext", () => {
  it("preserves cached branch and worktree across idle hibernation and silent wake without showing status banners", async () => {
    const action = vi.fn(async () => ({
      git: true,
      branch: "feat/idle-hibernation",
      target: "wt-1",
      root: "/tmp/demo-wt",
    })) as unknown as Action;
    const baseProject: Data = {
      id: "p1",
      root: "/tmp/demo",
      state: { connected: true, hostState: "ready" },
    };

    renderContext({ project: baseProject, threadId: "t1", action });
    await Promise.resolve();
    const connectedHtml = renderContext({ project: baseProject, threadId: "t1", action });
    expect(connectedHtml).toContain("feat/idle-hibernation");
    expect(connectedHtml).toContain("工作树");

    // 15 分钟空闲休眠（stopping -> stopped）：保留上次缓存的分支/worktree，不提示不可用或正在连接。
    const stoppingHtml = renderContext({
      project: { ...baseProject, state: { connected: false, hostState: "stopping" } },
      threadId: "t1",
      action,
    });
    expect(stoppingHtml).toContain("feat/idle-hibernation");
    expect(stoppingHtml).not.toContain("连接暂不可用");
    expect(stoppingHtml).not.toContain("正在连接");

    const stoppedHtml = renderContext({
      project: { ...baseProject, state: { connected: false, hostState: "stopped" } },
      threadId: "t1",
      action,
    });
    expect(stoppedHtml).toContain("feat/idle-hibernation");
    expect(stoppedHtml).not.toContain("连接暂不可用");
    expect(stoppedHtml).not.toContain("正在连接");

    // 静默输入预热（starting）：仍然保留分支显示，无闪烁。
    const startingHtml = renderContext({
      project: { ...baseProject, state: { connected: false, hostState: "starting" } },
      threadId: "t1",
      action,
    });
    expect(startingHtml).toContain("feat/idle-hibernation");
    expect(startingHtml).not.toContain("正在连接");
    expect(startingHtml).not.toContain("连接暂不可用");
  });

  it("quietly omits status when a cold project is hibernated or silently waking without cached info", () => {
    const action = vi.fn(async () => ({})) as unknown as Action;
    const hibernatedProject: Data = {
      id: "p2",
      root: "/tmp/cold",
      state: { connected: false, hostState: "stopped" },
    };

    const hibernatedHtml = renderContext({ project: hibernatedProject, action });
    expect(hibernatedHtml).not.toContain("连接暂不可用");
    expect(hibernatedHtml).not.toContain("正在连接");
    expect(hibernatedHtml).not.toContain("重新连接项目");

    const wakingHtml = renderContext({
      project: { ...hibernatedProject, state: { connected: false, hostState: "starting" } },
      action,
    });
    expect(wakingHtml).not.toContain("正在连接");
    expect(wakingHtml).not.toContain("连接暂不可用");
  });

  it("shows unavailable reconnect button for explicit stop or genuine faults", () => {
    const suppressedHtml = renderContext({
      project: {
        id: "p3",
        root: "/tmp/stopped",
        scheduling: { suppressed: true },
        state: { connected: false, hostState: "stopped" },
      },
    });
    expect(suppressedHtml).toContain("连接暂不可用");
    expect(suppressedHtml).toContain("重新连接项目");

    hooks.reset();
    const erroredHtml = renderContext({
      project: {
        id: "p4",
        root: "/tmp/errored",
        error: "Core 启动失败",
        state: { connected: false, hostState: "stopped" },
      },
    });
    expect(erroredHtml).toContain("连接暂不可用");
    expect(erroredHtml).toContain("重新连接项目");

    hooks.reset();
    const unavailableHtml = renderContext({
      project: {
        id: "p5",
        root: "/tmp/unavailable",
        state: { connected: false, hostState: "unavailable" },
      },
    });
    expect(unavailableHtml).toContain("连接暂不可用");
    expect(unavailableHtml).toContain("重新连接项目");
  });

  it.each([false, true])(
    "offers explicit reconnect when scheduling is suppressed, connected=%s",
    (connected) => {
      const html = renderContext({
        project: {
          id: "p",
          root: "/tmp/p",
          scheduling: { suppressed: true },
          state: { connected },
        },
        backendReady: true,
        action: vi.fn() as unknown as Action,
      });
      expect(html).toContain("重新连接项目");
    },
  );

  it("still shows connecting during normal initial project startup", () => {
    const startingHtml = renderContext({
      project: {
        id: "p6",
        root: "/tmp/initial",
        state: { connected: false, hostState: "starting" },
      },
    });
    expect(startingHtml).toContain("正在连接");
    expect(startingHtml).not.toContain("连接暂不可用");
  });

  it("quietly omits routine connecting text on local drafts across all cold/transition states while keeping fault recovery", () => {
    for (const hostState of ["stopped", "stopping", "starting", "ready", undefined] as const) {
      hooks.reset();
      const html = renderContext({
        project: {
          id: "p-draft",
          root: "/tmp/LoopMe",
          state: { connected: false, ...(hostState ? { hostState } : {}) },
        },
        quietConnecting: true,
      });
      expect(html).not.toContain("正在连接");
      expect(html).not.toContain("连接暂不可用");
    }

    hooks.reset();
    const suppressedHtml = renderContext({
      project: {
        id: "p-draft",
        root: "/tmp/LoopMe",
        scheduling: { suppressed: true },
        state: { connected: false, hostState: "stopped" },
      },
      quietConnecting: true,
    });
    expect(suppressedHtml).toContain("连接暂不可用");
    expect(suppressedHtml).toContain("重新连接项目");

    hooks.reset();
    const erroredHtml = renderContext({
      project: {
        id: "p-draft",
        root: "/tmp/LoopMe",
        error: "Core 启动失败",
        state: { connected: false, hostState: "unavailable" },
      },
      quietConnecting: true,
    });
    expect(erroredHtml).toContain("连接暂不可用");
    expect(erroredHtml).toContain("重新连接项目");
  });
});
