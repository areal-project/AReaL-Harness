import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { Composer, attachmentDrafts, sending } from "./Composer.js";
import type { ConversationComposer } from "./ConversationComposer.js";
import { readingViews, cancelTurnStart } from "./readingViews.js";
import { setPendingMessage, usePendingMessage } from "./pendingMessage.js";
import { setApplicationPreferences } from "./settings/applicationPreferences.js";
import { planModeOptions } from "./permissions.js";
import type { Action } from "./services.js";

const observed = vi.hoisted(() => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  return {
    submit: undefined as ((value: string) => unknown) | undefined,
    modifiedSubmit: undefined as ((value: string) => unknown) | undefined,
    approve: undefined as (() => void) | undefined,
  };
});
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("./ConversationComposer.js", () => ({
  ConversationComposer: (props: ComponentProps<typeof ConversationComposer>) => {
    observed.submit = props.onSubmit;
    observed.modifiedSubmit = props.onModifiedSubmit;
    return props.topContent;
  },
}));
vi.mock("./components/ui/button.js", () => ({
  Button: (props: { children?: unknown; onClick?: () => void }) => {
    if (props.children === "批准并执行") observed.approve = props.onClick;
    return null;
  },
}));
vi.mock("./i18n/IntlProvider.js", () => ({ useI18n: () => ({ t: (id: string) => id }) }));

function fixture(plan = false, file = false, running = false, empty = false) {
  const projectId = crypto.randomUUID();
  const key = `areal-gui:draft:${projectId}:thread`;
  const owner = JSON.stringify([projectId, "thread", false]);
  if (file) attachmentDrafts.set(key, [new File(["image"], "file.txt")]);
  const config = { revision: 1, options: planModeOptions(plan) };
  const thread = {
    id: "thread",
    turns: empty
      ? []
      : [
          {
            id: "old",
            status: running ? "inProgress" : "completed",
            configuration: config,
            items: [{ id: "answer", type: "agentMessage", text: "Ready" }],
          },
        ],
  };
  const action = vi.fn<Action>().mockRejectedValue(
    Object.assign(new Error("response lost"), {
      submissionUnknown: true,
      requestId: "original-request",
    }),
  );
  const render = () =>
    renderToStaticMarkup(
      createElement(Composer, {
        project: {
          id: projectId,
          root: "/preview",
          models: [],
          pending: [],
          configurations: { thread: config },
          state: { connected: true, threads: { thread }, interactions: {}, queues: {} },
        },
        thread,
        action: action as Action,
        executionBlocked: false,
        onPanel: () => {},
        onNew: () => {},
      }),
    );
  render();
  return { key, owner, action, render };
}

describe("Composer reading intent across unknown boundaries", () => {
  it.each(["upload", "configure", "send"] as const)(
    "keeps intent only when %s reaches send",
    async (boundary) => {
      const f = fixture(boundary === "configure", boundary === "upload");
      if (boundary === "configure") observed.approve!();
      else observed.submit!("new message");
      await vi.waitFor(() => expect(f.action).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(sending.has(f.key)).toBe(false));
      expect(f.action.mock.calls[0][0]).toBe(boundary === "upload" ? "media" : boundary);
      if (boundary === "send")
        expect(readingViews.get(f.owner)?.pendingTurnStart).toMatchObject({
          afterTurnId: "old",
          requestId: "original-request",
        });
      else expect(readingViews.get(f.owner)?.pendingTurnStart).toBeUndefined();
      readingViews.delete(f.owner);
      attachmentDrafts.delete(f.key);
    },
  );
  it("does not recreate reading intent when the reader leaves during upload", async () => {
    const f = fixture(false, true);
    let resolveUpload!: (value: { uri: string; mimeType: string }) => void;
    f.action
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveUpload = resolve;
          }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("response lost"), {
          submissionUnknown: true,
          requestId: "original-request",
        }),
      );
    observed.submit!("new message");
    await vi.waitFor(() => expect(f.action).toHaveBeenCalledOnce());
    cancelTurnStart(readingViews.get(f.owner)?.pendingTurnStart);
    resolveUpload({ uri: "areal://blob/file", mimeType: "text/plain" });
    await vi.waitFor(() => expect(sending.has(f.key)).toBe(false));
    expect(f.action.mock.calls.map(([name]) => name)).toEqual(["media", "send"]);
    expect(readingViews.get(f.owner)?.pendingTurnStart).toBeUndefined();
    readingViews.delete(f.owner);
    attachmentDrafts.delete(f.key);
  });
});

describe("Composer follow-up destination before acceptance", () => {
  it.each([
    { mode: "queue", invert: false, queued: true },
    { mode: "steer", invert: false, queued: false },
    { mode: "queue", invert: true, queued: false },
    { mode: "steer", invert: true, queued: true },
  ] as const)(
    "routes $mode (invert=$invert) without a transient conversation message",
    async ({ mode, invert, queued }) => {
      setApplicationPreferences({ followUp: mode });
      const f = fixture(false, false, true);
      let accept!: (value: Awaited<ReturnType<Action>>) => void;
      f.action.mockReset().mockImplementation(
        () =>
          new Promise((resolve) => {
            accept = resolve;
          }),
      );
      let pendingMessage: unknown;
      function Probe() {
        pendingMessage = usePendingMessage(f.key);
        return null;
      }
      (invert ? observed.modifiedSubmit : observed.submit)!("follow-up message");
      await vi.waitFor(() => expect(f.action).toHaveBeenCalledOnce());
      renderToStaticMarkup(createElement(Probe));
      const intent = readingViews.get(f.owner)?.pendingTurnStart;
      accept({ threadId: "thread" });
      await vi.waitFor(() => expect(sending.has(f.key)).toBe(false));
      expect(f.action.mock.calls[0][0]).toBe(queued ? "send" : "steer");
      expect(f.action.mock.calls[0][1]).toMatchObject({ expectedTurnId: "old", enqueue: queued });
      if (queued) expect(pendingMessage).toBeUndefined();
      else expect(pendingMessage).toMatchObject({ text: "follow-up message" });
      expect(intent).toBeUndefined();
      renderToStaticMarkup(createElement(Probe));
      if (queued) expect(pendingMessage).toBeUndefined();
      else expect(pendingMessage).toMatchObject({ text: "follow-up message" });
      setPendingMessage(f.key);
      readingViews.delete(f.owner);
      setApplicationPreferences({ followUp: "queue" });
    },
  );
});

describe("Composer pending attachment visibility", () => {
  it("hides captured attachments during submission and restores them after rejection", async () => {
    const f = fixture(false, true);
    let reject!: (error: Error) => void;
    f.action.mockReset().mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    observed.submit!("message with attachment");
    await vi.waitFor(() => expect(f.action).toHaveBeenCalledOnce());
    expect(f.render()).toContain('<div hidden="">');
    expect(attachmentDrafts.get(f.key)).toHaveLength(1);
    reject(new Error("upload rejected"));
    await vi.waitFor(() => expect(sending.has(f.key)).toBe(false));
    expect(f.render()).not.toContain('<div hidden="">');
    expect(attachmentDrafts.get(f.key)).toHaveLength(1);
    attachmentDrafts.delete(f.key);
    readingViews.delete(f.owner);
  });
});

describe("Composer receipt before history projection", () => {
  it.each([true, false])(
    "keeps the outgoing message until history replaces it (first=%s)",
    async (first) => {
      const f = fixture(false, false, false, first);
      f.action.mockReset().mockResolvedValue({ threadId: "thread" });
      observed.submit!("second message");
      await vi.waitFor(() => expect(f.action).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(sending.has(f.key)).toBe(false));
      let pendingMessage: unknown;
      function Probe() {
        pendingMessage = usePendingMessage(f.key);
        return null;
      }
      renderToStaticMarkup(createElement(Probe));
      expect(pendingMessage).toMatchObject({ text: "second message", accepted: true });
      expect(f.render()).not.toContain('<div hidden="">');
      setPendingMessage(f.key);
      readingViews.delete(f.owner);
    },
  );
});
