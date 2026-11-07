import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { Action, Data } from "./services.js";
import { useSideChatTabs } from "./useSideChatTabs.js";

// 无 DOM 的 hook 调度器让回执推送与请求响应可以按指定顺序交错。
const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  dirty: false,
  effects: [] as (() => void)[],
}));
vi.mock("react", () => ({
  useRef: (value: unknown) => {
    const index = hooks.cursor++;
    return (hooks.slots[index] ??= { current: value });
  },
  useState: (value: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = value;
    return [
      hooks.slots[index],
      (next: unknown) => {
        const value = typeof next === "function" ? next(hooks.slots[index]) : next;
        if (!Object.is(value, hooks.slots[index])) hooks.dirty = true;
        hooks.slots[index] = value;
      },
    ];
  },
  useEffect: (effect: () => void, deps: unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as unknown[] | undefined;
    if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) {
      hooks.slots[index] = deps;
      hooks.effects.push(effect);
    }
  },
}));
vi.mock("./i18n/IntlProvider.js", () => ({ useI18n: () => ({ t: (id: string) => id }) }));
vi.mock("./Composer.js", () => ({ attachmentDrafts: new Map(), attachmentErrors: new Map() }));
vi.mock("./composerDraftStorage.js", () => ({
  registerTransientComposer() {},
  forgetTransientComposer() {},
}));
vi.mock("./conversationSelectionReference.js", () => ({
  clearConversationSelections() {},
  conversationSelectionScope() {},
}));

const original = "ac15ee9c-0a56-42a7-8db4-d2a316fc872b";
const operation = { requestId: original, method: "areal/side/create", target: { kind: "project" } };
const pending = {
  method: operation.method,
  params: { requestId: original, sourceThreadId: "parent" },
  operation,
  awaitingResponse: false,
};
const project = (): Data => ({ id: "project", pending: [pending], outcomes: {} });
function render(action: Action, projects: Data[]) {
  let result: ReturnType<typeof useSideChatTabs>;
  for (let turn = 0; turn < 10; turn++) {
    hooks.cursor = 0;
    hooks.dirty = false;
    result = useSideChatTabs(action, projects);
    for (const effect of hooks.effects.splice(0)) effect();
    if (!hooks.dirty) return result;
  }
  throw new Error("Hook did not settle");
}
beforeEach(() => {
  hooks.slots = [];
  hooks.effects = [];
  hooks.cursor = 0;
});

it("recovers the original conflicting request instead of the new attempted creation", async () => {
  const action = vi.fn(async (_name, request) => {
    if (request.operation === "create")
      throw Object.assign(new Error("unknown"), {
        submissionUnknown: true,
        requestId: original,
        outcome: { kind: "unconfirmed", operation },
      });
    return { confirmed: true, requestId: original, threadId: "child" };
  }) as unknown as Action;
  const projects = [{ id: "project", pending: [], outcomes: {} }];
  let state = render(action, projects);
  await expect(state.create("project", "parent")).rejects.toThrow("unknown");
  state = render(action, projects);
  expect(state.pendingCreation("project", "parent")?.requestId).toBe(original);
  await state.recoverCreation("project", "parent");
  expect(vi.mocked(action).mock.calls[1]?.[1]).toMatchObject({
    operation: "recover",
    requestId: original,
  });
  state = render(action, projects);
  expect(state.pendingCreation("project", "parent")).toBeUndefined();
  expect(state.tabs.map((tab) => tab.childId)).toEqual(["child"]);
});

it("restores pending identity after remount and consumes a background receipt without replay", async () => {
  const action = vi.fn() as unknown as Action;
  const owner = project();
  let state = render(action, [owner]);
  expect(state.pendingCreation("project", "parent")?.requestId).toBe(original);
  await expect(state.create("project", "parent")).rejects.toThrow();
  const settled = {
    ...owner,
    pending: [],
    outcomes: {
      [original]: {
        accepted: true,
        status: "completed",
        method: operation.method,
        sourceThreadId: "parent",
        threadId: "child",
        operation: { ...operation, target: { kind: "thread", threadId: "child" } },
      },
    },
  };
  state = render(action, [settled]);
  expect(state.pendingCreation("project", "parent")).toBeUndefined();
  expect(state.tabs.map((tab) => tab.childId)).toEqual(["child"]);
  expect(action).not.toHaveBeenCalled();
});

it("retains unknown when a snapshot omits the receipt or reports another source", () => {
  const action = vi.fn() as unknown as Action;
  render(action, [project()]);
  const missing = { id: "project", pending: [], outcomes: {} };
  expect(render(action, [missing]).pendingCreation("project", "parent")?.requestId).toBe(original);
  const wrong = {
    ...missing,
    outcomes: {
      [original]: {
        accepted: true,
        status: "completed",
        sourceThreadId: "other",
        threadId: "child",
        operation: { ...operation, target: { kind: "thread", threadId: "child" } },
      },
    },
  };
  expect(render(action, [wrong]).pendingCreation("project", "parent")?.requestId).toBe(original);
});

it("settles a confirmed failure locally without creating a tab or retrying", async () => {
  const action = vi.fn(async () => ({
    confirmed: true,
    requestId: original,
    status: "failed",
    accepted: false,
    message: "Source unavailable",
  })) as unknown as Action;
  let state = render(action, [project()]);
  await state.recoverCreation("project", "parent");
  state = render(action, [{ id: "project", pending: [], outcomes: {} }]);
  expect(state.pendingCreation("project", "parent")).toBeUndefined();
  expect(state.creationError("project", "parent")).toBe("Source unavailable");
  expect(state.tabs).toEqual([]);
  expect(action).toHaveBeenCalledTimes(1);
});
