import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { useComposerQueueEdit } from "./useComposerQueueEdit.js";
import { uploadComposerFiles } from "./ComposerUploads.js";
import {
  composerUploadOwner,
  composerUploads,
  forgetComposerUploads,
} from "./ComposerUploadState.js";
import type { Action } from "./services.js";
import type { ComposerDraftAttachment } from "./ComposerAttachments.js";

vi.hoisted(() => {
  vi.stubGlobal("window", new EventTarget());
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});

async function editingFixture() {
  const project = {
    id: crypto.randomUUID(),
    core: { instanceId: "core" },
    state: {
      connected: true,
      queues: {
        thread: {
          revision: 3,
          paused: true,
          items: [{ id: "item", status: "pending" }],
        },
      },
    },
  };
  const owner = composerUploadOwner(project, "thread");
  const key = `areal-gui:draft:${project.id}:thread`;
  const originalFile = new File(["original"], "original.txt");
  const addition = new File(["added"], "added.txt");
  const drafts = new Map<string, ComposerDraftAttachment[]>([
    [key, [addition]],
    [`${key}:queue-edit:original`, [originalFile]],
  ]);
  localStorage.setItem(key, "edited message");
  localStorage.setItem(
    `${key}:queue-edit`,
    JSON.stringify({
      id: "item",
      revision: 3,
      phase: "editing",
      wasPaused: true,
      attachments: [],
      original: { text: "original draft", skills: null, goal: null },
    }),
  );
  const action = vi.fn<Action>();
  action.mockResolvedValueOnce({ uri: "areal://blob/original", mimeType: "text/plain" });
  await uploadComposerFiles(
    action as Action,
    project.id,
    "thread",
    [originalFile],
    undefined,
    owner,
  );
  let editor!: ReturnType<typeof useComposerQueueEdit>;
  function Harness() {
    editor = useComposerQueueEdit({
      project,
      threadId: "thread",
      draftKey: key,
      action: action as Action,
      readAction: action as Action,
      api: { current: null },
      draftFiles: drafts,
      setText: vi.fn(),
      setFiles: vi.fn(),
      setGoalMode: vi.fn(),
      uploadFiles: (files) =>
        uploadComposerFiles(action as Action, project.id, "thread", files, undefined, owner),
      inFlight: false,
      setInFlight: vi.fn(),
      annotationBlocked: false,
    });
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  return { action, editor, key, drafts, originalFile, addition, owner };
}

describe("queued composer upload lifetime", () => {
  it("releases accepted edit additions and restores the original draft's prepared file", async () => {
    const fixture = await editingFixture();
    fixture.action
      .mockResolvedValueOnce({ uri: "areal://blob/addition", mimeType: "text/plain" })
      .mockResolvedValueOnce({ revision: 4 });
    await fixture.editor.save();
    expect(localStorage.getItem(fixture.key)).toBe("original draft");
    expect(localStorage.getItem(`${fixture.key}:queue-edit`)).toBeNull();
    expect(fixture.drafts.get(fixture.key)).toEqual([fixture.originalFile]);
    const preparation = composerUploads(fixture.owner);
    expect(preparation.accepted.has(fixture.addition)).toBe(false);
    expect(preparation.states.has(fixture.addition)).toBe(false);
    expect(preparation.accepted.get(fixture.originalFile)?.url).toBe("areal://blob/original");
    forgetComposerUploads(fixture.owner, [fixture.originalFile]);
  });

  it("retains the edit and its receipt when queue update acceptance is UNKNOWN", async () => {
    const fixture = await editingFixture();
    fixture.action
      .mockResolvedValueOnce({ uri: "areal://blob/addition", mimeType: "text/plain" })
      .mockRejectedValueOnce(
        Object.assign(new Error("response lost"), {
          submissionUnknown: true,
          requestId: "update-request",
        }),
      );
    await fixture.editor.save();
    expect(localStorage.getItem(fixture.key)).toBe("edited message");
    expect(JSON.parse(localStorage.getItem(`${fixture.key}:queue-edit`)!).unknown).toEqual({
      operation: "update",
      requestId: "update-request",
    });
    expect(fixture.drafts.get(fixture.key)).toEqual([fixture.addition]);
    expect(composerUploads(fixture.owner).accepted.get(fixture.addition)?.url).toBe(
      "areal://blob/addition",
    );
    expect(fixture.action.mock.calls.filter(([name]) => name === "queueEdit")).toHaveLength(1);
    forgetComposerUploads(fixture.owner, [fixture.originalFile, fixture.addition]);
  });
});
