import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";
import { PlatformReadProvider } from "./PlatformReadContext.js";
import { useForkHistory } from "./ForkHistory.js";
import type { Action, PlatformReadServices } from "./services.js";

const scheduled = vi.hoisted(
  () => [] as Array<{ effect: () => void | (() => void); deps: unknown[] }>,
);
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    scheduled.push({ effect, deps });
  },
}));

it("loads inherited history after a stale subscription is replaced", async () => {
  const history = vi
    .fn()
    .mockRejectedValueOnce(new Error("Conversation unavailable"))
    .mockResolvedValueOnce({ snapshotId: "seed", complete: true, data: [] });
  const reads = { history } as unknown as PlatformReadServices;
  const action = vi.fn() as unknown as Action;
  const thread = {
    id: "fork",
    conversation: { kind: "fork", historySeed: { snapshotId: "seed" } },
    displayHistory: { viewGeneration: "old-subscription" },
  };
  function View() {
    useForkHistory("project", thread, action);
    return null;
  }
  const render = () =>
    renderToStaticMarkup(
      createElement(PlatformReadProvider, { reads, children: createElement(View) }),
    );
  scheduled.length = 0;
  render();
  const first = scheduled.pop()!;
  const cleanup = first.effect();
  await vi.waitFor(() => expect(history).toHaveBeenCalledTimes(1));
  thread.displayHistory.viewGeneration = "new-subscription";
  render();
  const second = scheduled.pop()!;
  if (second.deps.some((value, index) => !Object.is(value, first.deps[index]))) {
    cleanup?.();
    second.effect();
  }
  await vi.waitFor(() => expect(history).toHaveBeenCalledTimes(2));
  expect(history).toHaveBeenLastCalledWith({ view: "inherited", maxBytes: 65536 });
});
