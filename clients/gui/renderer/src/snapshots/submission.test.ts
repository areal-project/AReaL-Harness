import "fake-indexeddb/auto";
import { IDBDatabase, indexedDB } from "fake-indexeddb";
import { describe, expect, it, vi } from "vite-plus/test";
import type { Action } from "../services.js";
import { submitMessage } from "../ComposerSubmission.js";
import { attachmentDrafts } from "../composerDraftAttachments.js";
import {
  acceptSnapShot,
  pinSnapShot,
  restoreSnapShotDrafts,
  snapShotDraftRecords,
} from "./drafts.js";

vi.hoisted(() => {
  vi.stubGlobal("window", new EventTarget());
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
vi.stubGlobal("indexedDB", indexedDB);
async function prepare() {
  const id = crypto.randomUUID();
  const key = `draft:${id}`;
  await pinSnapShot(id, key);
  await acceptSnapShot({
    id,
    name: "window.png",
    mimeType: "image/png",
    sizeBytes: 3,
    dataUrl: "data:image/png;base64,AQID",
    source: {
      kind: "snap-shot",
      capturedAt: new Date().toISOString(),
      appName: "Editor",
      windowTitle: "Document",
      accessibleText: "Untrusted app instructions",
    },
  });
  return { id, key, files: attachmentDrafts.get(key) as File[] };
}
describe("screenshot submission acceptance", () => {
  it("preserves explicit Core acceptance when local draft cleanup fails", async () => {
    const { key, files } = await prepare();
    const invoke = vi
      .fn<Action>()
      .mockResolvedValueOnce({ uri: "areal://blob/image", mimeType: "image/png" })
      .mockResolvedValueOnce({ threadId: "thread" });
    const fault = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });
    await expect(
      submitMessage(invoke as Action, "project", "thread", "Question", files, { appMessage: true }),
    ).resolves.toBeUndefined();
    fault.mockRestore();
    expect(invoke).toHaveBeenLastCalledWith(
      "send",
      expect.objectContaining({
        attachments: [expect.objectContaining({ type: "image", url: "areal://blob/image" })],
        text: expect.stringContaining('"imageUri":"areal://blob/image"'),
      }),
    );
    expect(invoke).toHaveBeenCalledTimes(2);
    attachmentDrafts.delete(key);
    await restoreSnapShotDrafts();
    expect(attachmentDrafts.has(key)).toBe(false);
  });
  it("retains the exact screenshot and source after UNKNOWN send for receipt reconciliation", async () => {
    const { id, key, files } = await prepare();
    const invoke = vi
      .fn<Action>()
      .mockResolvedValueOnce({ uri: "areal://blob/image", mimeType: "image/png" })
      .mockRejectedValueOnce(
        Object.assign(new Error("receipt lost"), { submissionUnknown: true, requestId: "request" }),
      );
    await expect(
      submitMessage(invoke as Action, "project", "thread", "Question", files, { appMessage: true }),
    ).rejects.toMatchObject({ submissionUnknown: true });
    expect((await snapShotDraftRecords()).find((record) => record.id === id)?.state).toBe(
      "attached",
    );
    attachmentDrafts.delete(key);
    await restoreSnapShotDrafts();
    expect(attachmentDrafts.get(key)).toHaveLength(1);
  });
});
