import { isValidElement, type ComponentProps, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { ComposerQueue } from "./ComposerQueue.js";
import type { Action } from "./services.js";

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  // 组件在这里被当作函数直接调用，没有渲染器；自动核对的副作用不在本测试范围内。
  useRef: (current: unknown) => ({ current }),
  useEffect: () => {},
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots))
      hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[index], (value: unknown) => (hooks.slots[index] = value)];
  },
}));
vi.mock("./i18n/IntlProvider.js", () => ({ useI18n: () => ({ t: (id: string) => id }) }));
vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});

function grips(node: ReactNode): ComponentProps<"button">[] {
  if (Array.isArray(node)) return node.flatMap(grips);
  if (!isValidElement<ComponentProps<"button">>(node)) return [];
  return node.props.className === "composer-queue-grip" ? [node.props] : grips(node.props.children);
}
function queue(revision: number, ids: string[]) {
  return {
    revision,
    paused: false,
    items: ids.map((id) => ({ id, status: "pending", input: [{ type: "text", text: id }] })),
  };
}

beforeEach(() => {
  hooks.cursor = 0;
  hooks.slots = [];
});

it("waits for a confirmed queue revision before applying another order to its projection", async () => {
  const project = {
    id: crypto.randomUUID(),
    state: {
      connected: true,
      queues: { thread: queue(1, ["1", "2", "3"]), other: queue(0, ["a", "b"]) },
    },
  };
  const action = vi.fn<Action>().mockResolvedValue(queue(2, ["1", "3", "2"]));
  const render = (threadId = "thread") => {
    hooks.cursor = 0;
    return grips(
      ComposerQueue({
        project,
        thread: { id: threadId, turns: [] },
        disabled: false,
        action: action as Action,
        onEdit: vi.fn(),
      }),
    );
  };
  const press = (id: string, key: string) => {
    const handle = render().find((button) => button["aria-label"] === `调整顺序 ${id}`)!;
    handle.onKeyDown!({ key, preventDefault() {} } as Parameters<
      NonNullable<typeof handle.onKeyDown>
    >[0]);
  };
  press("3", "ArrowUp");
  await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
  expect(action.mock.calls[0][1]).toMatchObject({
    expectedRevision: 1,
    queueItemIds: ["1", "3", "2"],
  });
  expect(render().every((button) => button.disabled)).toBe(true);
  expect(render("other").some((button) => button.disabled)).toBe(false);
  press("1", "ArrowDown");
  expect(action).toHaveBeenCalledOnce();

  project.state.queues.thread = queue(2, ["1", "3", "2"]);
  expect(render().some((button) => button.disabled)).toBe(false);
  press("3", "ArrowDown");
  await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(2));
  expect(action.mock.calls[1][1]).toMatchObject({
    expectedRevision: 2,
    queueItemIds: ["1", "2", "3"],
  });
});
