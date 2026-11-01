import "fake-indexeddb/auto";
import { IDBDatabase } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopSnapShot } from "@areal/workbench/desktop-contract/snapshots";
import { attachmentDrafts } from "../composerDraftAttachments.js";
import {
  acceptSnapShot,
  consumeSnapShotFiles,
  moveSnapShotDraft,
  pinSnapShot,
  restoreSnapShotDrafts,
  snapShotDraftRecords,
} from "./drafts.js";
import { snapShotFile } from "./source.js";

vi.stubGlobal("window", new EventTarget());
const capture = (): DesktopSnapShot => ({
  id: crypto.randomUUID(),
  name: "window.png",
  mimeType: "image/png",
  sizeBytes: 3,
  dataUrl: "data:image/png;base64,AQID",
  source: {
    kind: "snap-shot",
    capturedAt: new Date().toISOString(),
    appName: "Editor",
    windowTitle: "A document",
    accessibleText: "Untrusted document text",
  },
});
beforeEach(() => attachmentDrafts.clear());

describe("durable screenshot draft intake", () => {
  it("pins the requested draft even if the active chat changes and delivery repeats", async () => {
    const item = capture();
    const key = `draft:${item.id}:original`;
    await pinSnapShot(item.id, key);
    await pinSnapShot(item.id, "draft:other-chat");
    expect(await acceptSnapShot(item)).toBe(true);
    expect(await acceptSnapShot(item)).toBe(true);
    expect(attachmentDrafts.get(key)).toHaveLength(1);
    expect(attachmentDrafts.has("draft:other-chat")).toBe(false);
    const durable = (await snapShotDraftRecords()).find((record) => record.id === item.id);
    expect(durable?.state).toBe("attached");
    expect(durable?.draftKey).toBe(key);
  });

  it("restores image bytes, file name and source after renderer memory is lost", async () => {
    const item = capture();
    const key = `draft:${item.id}`;
    await pinSnapShot(item.id, key);
    await acceptSnapShot(item);
    attachmentDrafts.clear();
    await restoreSnapShotDrafts();
    const file = attachmentDrafts.get(key)?.[0] as File;
    expect(file.name).toBe(item.name);
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(snapShotFile(file)).toEqual({ id: item.id, source: item.source });
  });

  it("moves a pending capture to the accepted new thread before bytes arrive", async () => {
    const item = capture();
    await pinSnapShot(item.id, `new:${item.id}`);
    await moveSnapShotDraft(`new:${item.id}`, `thread:${item.id}`);
    await acceptSnapShot(item);
    expect(attachmentDrafts.has(`new:${item.id}`)).toBe(false);
    expect(attachmentDrafts.get(`thread:${item.id}`)).toHaveLength(1);
  });

  it("moves an already received capture without dropping captures added during creation", async () => {
    const item = capture();
    await pinSnapShot(item.id, `new:${item.id}`);
    await acceptSnapShot(item);
    await moveSnapShotDraft(`new:${item.id}`, `thread:${item.id}`);
    expect(snapShotFile(attachmentDrafts.get(`thread:${item.id}`)?.[0] as File)?.id).toBe(item.id);
  });

  it("retains deletion receipts so a delayed Main acknowledgement cannot reattach removed images", async () => {
    const item = capture();
    const key = `draft:${item.id}`;
    await pinSnapShot(item.id, key);
    await acceptSnapShot(item);
    await consumeSnapShotFiles(attachmentDrafts.get(key) as File[]);
    attachmentDrafts.clear();
    expect(await acceptSnapShot(item)).toBe(true);
    await restoreSnapShotDrafts();
    expect(attachmentDrafts.has(key)).toBe(false);
  });

  it("leaves captures without a durable destination pending for explicit recovery", async () => {
    const item = capture();
    expect(await acceptSnapShot(item)).toBe(false);
    expect((await snapShotDraftRecords()).some((record) => record.id === item.id)).toBe(false);
  });
});

it("retains current-session consumption if the post-acceptance durable cleanup fails", async () => {
  const item = capture();
  const key = `draft:${item.id}`;
  await pinSnapShot(item.id, key);
  await acceptSnapShot(item);
  const warning = vi.fn();
  window.addEventListener("areal-snapshot-local-error", warning);
  const fault = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementationOnce(() => {
    throw new Error("disk unavailable");
  });
  await expect(consumeSnapShotFiles(attachmentDrafts.get(key) as File[])).resolves.toBeUndefined();
  fault.mockRestore();
  attachmentDrafts.clear();
  await restoreSnapShotDrafts();
  expect(attachmentDrafts.has(key)).toBe(false);
  expect(await acceptSnapShot(item)).toBe(true);
  expect(attachmentDrafts.has(key)).toBe(false);
  expect(warning).toHaveBeenCalledTimes(1);
  window.removeEventListener("areal-snapshot-local-error", warning);
});

it("moves only captures pinned in that generation when a reusable new-chat draft is promoted", async () => {
  const first = capture();
  const second = capture();
  const key = `new:${crypto.randomUUID()}`;
  await pinSnapShot(first.id, key);
  const fault = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementationOnce(() => {
    throw new Error("disk unavailable");
  });
  await expect(moveSnapShotDraft(key, "thread:first")).resolves.toBeUndefined();
  fault.mockRestore();
  await pinSnapShot(second.id, key);
  await moveSnapShotDraft(key, "thread:second");
  await acceptSnapShot(first);
  await acceptSnapShot(second);
  expect(snapShotFile(attachmentDrafts.get("thread:first")?.[0] as File)?.id).toBe(first.id);
  expect(snapShotFile(attachmentDrafts.get("thread:second")?.[0] as File)?.id).toBe(second.id);
});
