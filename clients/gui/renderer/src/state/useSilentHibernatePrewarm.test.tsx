import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Action, Data } from "../services.js";

const hooks = vi.hoisted(() => ({
  refs: new Map<number, { current: unknown }>(),
  effects: [] as Array<{ fn: () => void | (() => void); deps?: unknown[]; cleanup?: () => void }>,
  refIdx: 0,
  effectIdx: 0,
  mounted: false,
  reset() {
    for (const effect of this.effects) effect.cleanup?.();
    this.refs.clear();
    this.effects = [];
    this.refIdx = 0;
    this.effectIdx = 0;
    this.mounted = false;
  },
}));

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
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

import { useSilentHibernatePrewarm } from "./useSilentHibernatePrewarm.js";

afterEach(() => {
  hooks.reset();
});

function runHook(props: Parameters<typeof useSilentHibernatePrewarm>[0]) {
  hooks.mounted = true;
  hooks.refIdx = 0;
  hooks.effectIdx = 0;
  let warming = false;
  function Harness() {
    warming = useSilentHibernatePrewarm(props);
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  return warming;
}

function createActionSpy() {
  const spy = vi.fn(async (_name: string, _params: unknown) => ({}));
  return { spy, action: spy as unknown as Action };
}

describe("useSilentHibernatePrewarm", () => {
  it("does not wake Core when an untouched draft is already in the composer as the project hibernates", () => {
    const { spy, action } = createActionSpy();
    const connectedProject: Data = {
      id: "p1",
      root: "/tmp/demo",
      state: { connected: true, hostState: "ready" },
    };
    const hibernatedProject: Data = {
      id: "p1",
      root: "/tmp/demo",
      state: { connected: false, hostState: "stopped" },
    };

    expect(
      runHook({ project: connectedProject, threadId: "t1", text: "unsent draft", action }),
    ).toBe(false);
    // 15 分钟空闲休眠，输入框里的旧草稿没动，不能自动唤醒。
    expect(
      runHook({ project: hibernatedProject, threadId: "t1", text: "unsent draft", action }),
    ).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("wakes Core once on active non-empty typing, stays warming through starting, and resets after reconnect", () => {
    const { spy, action } = createActionSpy();
    const hibernated: Data = {
      id: "p1",
      root: "/tmp/demo",
      state: { connected: false, hostState: "stopped" },
    };

    // 初始空草稿不唤醒。
    expect(runHook({ project: hibernated, threadId: "t1", text: "", action })).toBe(false);
    expect(spy).not.toHaveBeenCalled();

    // 仅输入空白字符不唤醒。
    expect(runHook({ project: hibernated, threadId: "t1", text: "   ", action })).toBe(false);
    expect(spy).not.toHaveBeenCalled();

    // 键入非空文本 -> 静默 connect（不带 resumeScheduling）。
    runHook({ project: hibernated, threadId: "t1", text: "h", action });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("connect", { projectId: "p1" });

    // 继续打字不会重复触发 connect，且在 starting 阶段维持 warming 状态。
    const starting: Data = {
      id: "p1",
      root: "/tmp/demo",
      state: { connected: false, hostState: "starting" },
    };
    expect(runHook({ project: starting, threadId: "t1", text: "hello", action })).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    // 恢复连接后清除本轮标记；再次进入休眠并编辑时允许再次静默预热。
    const connected: Data = {
      id: "p1",
      root: "/tmp/demo",
      state: { connected: true, hostState: "ready" },
    };
    expect(runHook({ project: connected, threadId: "t1", text: "", action })).toBe(false);

    expect(runHook({ project: hibernated, threadId: "t1", text: "", action })).toBe(false);
    runHook({ project: hibernated, threadId: "t1", text: "next", action });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("never wakes explicitly stopped projects or disabled/read-only composers", () => {
    const { spy, action } = createActionSpy();
    const suppressed: Data = {
      id: "p1",
      root: "/tmp/demo",
      scheduling: { suppressed: true },
      state: { connected: false, hostState: "stopped" },
    };

    runHook({ project: suppressed, threadId: "t1", text: "", action });
    runHook({ project: suppressed, threadId: "t1", text: "hello", action });
    expect(spy).not.toHaveBeenCalled();

    hooks.reset();
    const hibernated: Data = {
      id: "p2",
      root: "/tmp/demo2",
      state: { connected: false, hostState: "stopped" },
    };
    runHook({ project: hibernated, threadId: "t1", text: "", action, enabled: false });
    runHook({ project: hibernated, threadId: "t1", text: "hello", action, enabled: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not trigger prewarm when switching to another thread that already has a saved draft", () => {
    const { spy, action } = createActionSpy();
    const hibernated: Data = {
      id: "p1",
      root: "/tmp/demo",
      state: { connected: false, hostState: "stopped" },
    };

    runHook({ project: hibernated, threadId: "t1", text: "", action });
    runHook({ project: hibernated, threadId: "t2", text: "saved draft on t2", action });
    expect(spy).not.toHaveBeenCalled();

    runHook({ project: hibernated, threadId: "t2", text: "saved draft on t2!", action });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("connect", { projectId: "p1" });
  });
});
