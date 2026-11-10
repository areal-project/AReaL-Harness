import { attachmentDrafts } from "../composerDraftAttachments.js";
import { currentErrorText } from "../errors/currentErrorText.js";
import type { DesktopSnapShot, SnapShotSource } from "../services.js";
import { registerSnapShotFile, snapShotFile } from "./source.js";

type DraftRecord = {
  id: string;
  draftKey: string;
  state: "pinned" | "attached" | "removed";
  file?: Blob;
  name?: string;
  source?: SnapShotSource;
};
const removed = new Set<string>();
const targets = new Map<string, string>();
export const snapShotDraftTarget = (id: string, fallback: string) => targets.get(id) ?? fallback;
function localFailure(cause: unknown) {
  window.dispatchEvent(
    new CustomEvent("areal-snapshot-local-error", {
      detail: currentErrorText(cause),
    }),
  );
}
let database: Promise<IDBDatabase> | undefined;
function open() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("areal-snapshot-drafts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("captures", { keyPath: "id" });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  return database;
}
async function transaction<T>(
  operation: (store: IDBObjectStore, set: (value: T) => void) => void,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("captures", "readwrite");
    let result: T;
    operation(tx.objectStore("captures"), (value) => {
      result = value;
    });
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () =>
      reject(tx.error ?? new Error("Screenshot draft could not be saved."));
  });
}
export function pinSnapShot(id: string, draftKey: string) {
  if (!targets.has(id)) targets.set(id, draftKey);
  return transaction<void>((store) => {
    const read = store.get(id);
    read.onsuccess = () => {
      if (!read.result)
        store.put({
          id,
          draftKey: snapShotDraftTarget(id, draftKey),
          state: "pinned",
        } satisfies DraftRecord);
    };
  });
}
export async function snapShotDraftRecords() {
  return transaction<DraftRecord[]>((store, set) => {
    const request = store.getAll();
    request.onsuccess = () => {
      for (const record of request.result as DraftRecord[])
        if (!targets.has(record.id) && record.state !== "removed")
          targets.set(record.id, record.draftKey);
      set(request.result);
    };
  });
}
function stage(record: DraftRecord) {
  if (removed.has(record.id) || record.state !== "attached" || !record.file || !record.source)
    return;
  const draftKey = snapShotDraftTarget(record.id, record.draftKey);
  if (!targets.has(record.id)) targets.set(record.id, draftKey);
  const files = attachmentDrafts.get(draftKey) ?? [];
  if (files.some((file) => file instanceof File && snapShotFile(file)?.id === record.id)) return;
  const file = new File([record.file], record.name ?? "snapshot.png", { type: record.file.type });
  registerSnapShotFile(file, { id: record.id, source: record.source });
  attachmentDrafts.set(draftKey, [...files, file]);
  window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: draftKey }));
}
export async function restoreSnapShotDrafts() {
  const records = await snapShotDraftRecords();
  records.forEach(stage);
}
export async function acceptSnapShot(capture: DesktopSnapShot) {
  if (removed.has(capture.id)) return true;
  const bytes = Uint8Array.from(atob(capture.dataUrl.split(",")[1]), (character) =>
    character.charCodeAt(0),
  );
  const file = new Blob([bytes], { type: capture.mimeType });
  const record = await transaction<DraftRecord | undefined>((store, set) => {
    const request = store.get(capture.id);
    request.onsuccess = () => {
      const pin = request.result as DraftRecord | undefined;
      if (!pin) return set(undefined);
      if (pin.state !== "pinned") return set(pin);
      const attached: DraftRecord = {
        ...pin,
        state: "attached",
        file,
        name: capture.name,
        source: capture.source,
      };
      store.put(attached);
      set(attached);
    };
  });
  if (!record) return false;
  stage(record);
  return true;
}
export async function moveSnapShotDraft(from: string, to: string) {
  if (from === to) return;
  const ids = new Set([...targets].filter(([, key]) => key === from).map(([id]) => id));
  ids.forEach((id) => targets.set(id, to));
  const moved = await transaction<DraftRecord[]>((store, set) => {
    const request = store.getAll();
    request.onsuccess = () => {
      const records = (request.result as DraftRecord[])
        .filter((record) => ids.has(record.id) && record.state !== "removed")
        .map((record) => ({ ...record, draftKey: to }));
      for (const record of records) store.put(record);
      set(records);
    };
  }).catch((cause: unknown) => {
    localFailure(cause);
    return [];
  });
  moved.forEach(stage);
}
export async function consumeSnapShotFiles(files: readonly File[]) {
  const ids = new Set(files.flatMap((file) => snapShotFile(file)?.id ?? []));
  if (!ids.size) return;
  ids.forEach((id) => removed.add(id));
  await transaction<void>((store) => {
    const request = store.getAll();
    request.onsuccess = () => {
      for (const record of request.result as DraftRecord[])
        if (ids.has(record.id))
          store.put({
            id: record.id,
            draftKey: record.draftKey,
            state: "removed",
          } satisfies DraftRecord);
    };
  }).catch(localFailure);
}
