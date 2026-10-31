import { describe, expect, it, vi } from "vite-plus/test";
import type { Action } from "./services.js";
import { submitMessage } from "./Composer.js";
import { composerUploads, forgetComposerUploads } from "./ComposerUploadState.js";

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
        appMessage: true,
        uploadOwner: owner,
      });
    await expect(send()).rejects.toMatchObject({ submissionUnknown: true });
    await expect(send()).rejects.toMatchObject({ submissionUnknown: true });
    expect(action.mock.calls.map(([name]) => name)).toEqual(["media"]);
    expect(composerUploads(owner).states.get(file)?.state).toBe("unknown");
    forgetComposerUploads(owner, [file]);
  });

  it("retains upload facts when message acceptance is UNKNOWN", async () => {
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
        appMessage: true,
        uploadOwner: owner,
      });
    await expect(send()).rejects.toBe(unknown);
    expect(preparation.states.get(file)?.state).toBe("ready");
    expect(preparation.accepted.get(file)?.url).toBe(media.uri);
    expect(action.mock.calls.filter(([name]) => name === "media")).toHaveLength(1);
    expect(action.mock.calls.filter(([name]) => name === "send")).toHaveLength(1);
    forgetComposerUploads(owner, [file]);
  });
});
