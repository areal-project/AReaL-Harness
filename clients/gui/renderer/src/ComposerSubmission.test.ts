import { describe, expect, it, vi } from "vite-plus/test";
import type { Action } from "./services.js";
import { submitMessage } from "./Composer.js";
import { appendMcpDraft, clearMcpDraft, readMcpDraft, removeMcpDraft } from "./mcp-app-draft.js";
import { composerUploads, forgetComposerUploads } from "./ComposerUploadState.js";
import {
  readReviewComments,
  reconcileReviewSubmission,
  reviewCommentKey,
  writeReviewComments,
  type ReviewComment,
} from "./reviewComments.js";

vi.hoisted(() => {
  vi.stubGlobal("window", new EventTarget());
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});

const media = { uri: "areal://blob/receipt", mimeType: "text/plain" };

describe("composer submission upload lifetime", () => {
  it("submits review comments as structured context instead of text", async () => {
    const comment: ReviewComment = {
      id: "comment",
      path: "src/app.ts",
      root: "/workspace",
      scope: "branch",
      ref: "main",
      token: "token",
      head: "head",
      base: "base",
      side: "additions",
      start: 3,
      end: 3,
      snippet: "const value = 1;",
      body: "Please extract this value.",
    };
    const key = reviewCommentKey("project", "thread");
    writeReviewComments(key, { comments: [comment], attachedIds: [comment.id] });
    const action = vi.fn<Action>().mockResolvedValue({ threadId: "thread" });
    await submitMessage(action as Action, "project", "thread", "please fix", []);
    expect(action).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        text: "please fix",
        contextParts: [{ type: "reviewComment", comment }],
      }),
    );
    const firstCall = action.mock.calls[0];
    if (!firstCall) throw new Error("send action was not recorded");
    expect((firstCall[1] as { text?: string }).text).not.toContain("审查反馈：");
  });

  it("keeps context parts through UNKNOWN and consumes them only after reconcile", async () => {
    const comment: ReviewComment = {
      id: "unknown-comment",
      path: "src/app.ts",
      root: "/workspace",
      scope: "branch",
      ref: "main",
      token: "token",
      head: "head",
      base: "base",
      side: "additions",
      start: 3,
      end: 3,
      snippet: "const value = 1;",
      body: "Keep this after a lost reply.",
    };
    const key = reviewCommentKey("project", "unknown-thread");
    writeReviewComments(key, { comments: [comment], attachedIds: [comment.id] });
    const action = vi.fn<Action>().mockRejectedValue(
      Object.assign(new Error("response lost"), {
        submissionUnknown: true,
        requestId: "unknown-request",
      }),
    );
    await expect(
      submitMessage(action as Action, "project", "unknown-thread", "please fix", []),
    ).rejects.toMatchObject({ submissionUnknown: true, requestId: "unknown-request" });
    expect(readReviewComments(key).submission?.comments).toEqual([comment]);
    reconcileReviewSubmission(key, "unknown-request", true);
    expect(readReviewComments(key).comments).toEqual([]);
  });

  it("blocks restored missing files before uploads or admission", async () => {
    const action = vi.fn<Action>();
    await expect(
      submitMessage(action as Action, "project", "thread", "keep my context", [
        { kind: "missing-file", name: "diagram.png", size: 10, type: "image/png", lastModified: 0 },
      ]),
    ).rejects.toThrow("Missing draft attachment");
    expect(action).not.toHaveBeenCalled();
  });
  it("releases prepared file references after explicit acceptance", async () => {
    const owner = crypto.randomUUID();
    const file = new File(["content"], "document.txt");
    const preparation = composerUploads(owner);
    const action = vi.fn<Action>();
    action.mockResolvedValueOnce(media).mockResolvedValueOnce({ threadId: "thread" });
    await submitMessage(action as Action, "project", "thread", "message", [file], {
      appMessage: true,
      uploadOwner: owner,
    });
    expect(action).toHaveBeenLastCalledWith(
      "send",
      expect.objectContaining({
        attachments: [expect.objectContaining({ url: media.uri })],
      }),
    );
    expect(preparation.accepted.size).toBe(0);
    expect(preparation.states.size).toBe(0);
    expect(preparation.inFlight.size).toBe(0);
    forgetComposerUploads(owner, [file]);
  });

  it("does not attempt message admission when an upload result is UNKNOWN", async () => {
    const onSendStart = vi.fn();
    const owner = crypto.randomUUID();
    const file = new File(["content"], "document.txt");
    const action = vi.fn<Action>();
    action.mockRejectedValueOnce(
      Object.assign(new Error("upload response lost"), {
        submissionUnknown: true,
      }),
    );
    const send = () =>
      submitMessage(action as Action, "project", "thread", "message", [file], {
        onSendStart,
        appMessage: true,
        uploadOwner: owner,
      });
    await expect(send()).rejects.toMatchObject({ submissionUnknown: true });
    await expect(send()).rejects.toMatchObject({ submissionUnknown: true });
    expect(action.mock.calls.map(([name]) => name)).toEqual(["media"]);
    expect(onSendStart).not.toHaveBeenCalled();
    expect(composerUploads(owner).states.get(file)?.state).toBe("unknown");
    forgetComposerUploads(owner, [file]);
  });

  it("retains upload facts when message acceptance is UNKNOWN", async () => {
    const onSendStart = vi.fn();
    const owner = crypto.randomUUID();
    const file = new File(["content"], "document.txt");
    const preparation = composerUploads(owner);
    const unknown = Object.assign(new Error("response lost"), {
      submissionUnknown: true,
      requestId: "request",
    });
    const action = vi.fn<Action>();
    action.mockResolvedValueOnce(media).mockRejectedValueOnce(unknown);
    const send = () =>
      submitMessage(action as Action, "project", "thread", "message", [file], {
        onSendStart,
        appMessage: true,
        uploadOwner: owner,
      });
    await expect(send()).rejects.toBe(unknown);
    expect(onSendStart).toHaveBeenCalledOnce();
    expect(preparation.states.get(file)?.state).toBe("ready");
    expect(preparation.accepted.get(file)?.url).toBe(media.uri);
    expect(action.mock.calls.filter(([name]) => name === "media")).toHaveLength(1);
    expect(action.mock.calls.filter(([name]) => name === "send")).toHaveLength(1);
    forgetComposerUploads(owner, [file]);
  });
});

const image = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
function draft() {
  const projectId = crypto.randomUUID();
  const key = `areal-gui:draft:${projectId}:thread`;
  appendMcpDraft(key, [image]);
  return { projectId, key, owner: crypto.randomUUID() };
}
describe("MCP draft image submission identity", () => {
  it("does not upload the same durable draft again after UNKNOWN", async () => {
    const { projectId, key, owner } = draft();
    const preparation = composerUploads(owner);
    const action = vi
      .fn<Action>()
      .mockRejectedValue(Object.assign(new Error("response lost"), { submissionUnknown: true }));
    const send = () =>
      submitMessage(action as Action, projectId, "thread", "message", [], { uploadOwner: owner });
    await expect(send()).rejects.toMatchObject({ submissionUnknown: true });
    await expect(send()).rejects.toMatchObject({ submissionUnknown: true });
    expect(action.mock.calls.map(([name]) => name)).toEqual(["media"]);
    clearMcpDraft(key);
    expect(preparation.states.size).toBe(0);
    expect(preparation.accepted.size).toBe(0);
  });
  it("reuses a prepared image after a rejected send and releases it on acceptance", async () => {
    const { projectId, key, owner } = draft();
    const preparation = composerUploads(owner);
    const action = vi
      .fn<Action>()
      .mockResolvedValueOnce({ ...media, mimeType: "image/png" })
      .mockRejectedValueOnce(new Error("rejected"))
      .mockResolvedValueOnce({ threadId: "thread" });
    const send = () =>
      submitMessage(action as Action, projectId, "thread", "message", [], { uploadOwner: owner });
    await expect(send()).rejects.toThrow("rejected");
    await send();
    expect(action.mock.calls.map(([name]) => name)).toEqual(["media", "send", "send"]);
    expect(readMcpDraft(key)).toEqual([]);
    expect(preparation.states.size).toBe(0);
    expect(preparation.accepted.size).toBe(0);
  });
  it("releases a removed draft image even when its upload completes later", async () => {
    const { projectId, key, owner } = draft();
    const preparation = composerUploads(owner);
    let resolveUpload!: (value: typeof media) => void;
    const action = vi
      .fn<Action>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveUpload = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error("rejected"));
    const send = submitMessage(action as Action, projectId, "thread", "message", [], {
      uploadOwner: owner,
    });
    await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
    removeMcpDraft(key, readMcpDraft(key)[0].id);
    resolveUpload(media);
    await expect(send).rejects.toThrow("rejected");
    expect(preparation.states.size).toBe(0);
    expect(preparation.accepted.size).toBe(0);
    expect(preparation.inFlight.size).toBe(0);
  });
  it("keeps execution owners and new identical draft entries independent", async () => {
    const { projectId, key, owner } = draft();
    const otherOwner = crypto.randomUUID();
    const action = vi
      .fn<Action>()
      .mockRejectedValue(Object.assign(new Error("response lost"), { submissionUnknown: true }));
    await expect(
      submitMessage(action as Action, projectId, "thread", "", [], { uploadOwner: owner }),
    ).rejects.toThrow();
    await expect(
      submitMessage(action as Action, projectId, "thread", "", [], { uploadOwner: otherOwner }),
    ).rejects.toThrow();
    clearMcpDraft(key);
    appendMcpDraft(key, [image]);
    await expect(
      submitMessage(action as Action, projectId, "thread", "", [], { uploadOwner: owner }),
    ).rejects.toThrow();
    expect(action.mock.calls.map(([name]) => name)).toEqual(["media", "media", "media"]);
    clearMcpDraft(key);
  });
  it("treats direct app RPCs independently and releases their temporary images on failure", async () => {
    const owner = crypto.randomUUID();
    const action = vi
      .fn<Action>()
      .mockRejectedValue(Object.assign(new Error("response lost"), { submissionUnknown: true }));
    for (let attempt = 0; attempt < 2; attempt++) {
      const preparation = composerUploads(owner);
      await expect(
        submitMessage(action as Action, "project", "thread", "", [], {
          uploadOwner: owner,
          appMessage: true,
          mcpContent: [image],
        }),
      ).rejects.toThrow();
      expect(preparation.states.size).toBe(0);
    }
    expect(action.mock.calls.map(([name]) => name)).toEqual(["media", "media"]);
  });
});
