import { useSyncExternalStore } from "react";
import type { Attachment } from "./services.js";
import type { Data } from "./services.js";
import { executionGeneration } from "./serviceGeneration.js";

export type ComposerUploadState =
  | { state: "pending" | "reading" | "uploading" }
  | { state: "ready"; receipt: Attachment }
  | { state: "failed"; message: string }
  | { state: "unknown"; message: string; error: Error };
type Preparation = {
  accepted: Map<File, Attachment>;
  states: Map<File, ComposerUploadState>;
  inFlight: Map<File, Promise<Attachment>>;
};
const preparations = new Map<string, Preparation>();
const listeners = new Set<() => void>();
export function composerUploadOwner(project: Data, threadId: string) {
  return JSON.stringify([project.id, threadId, executionGeneration(project, threadId) ?? null]);
}
export function composerUploads(owner: string) {
  const current = preparations.get(owner);
  if (current) return current;
  const value: Preparation = { accepted: new Map(), states: new Map(), inFlight: new Map() };
  preparations.set(owner, value);
  return value;
}
export function setComposerUploadState(owner: string, file: File, state: ComposerUploadState) {
  composerUploads(owner).states.set(file, state);
  listeners.forEach((listener) => listener());
}
export function useComposerUploadState(owner: string | undefined, file: File | null) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => (owner && file ? preparations.get(owner)?.states.get(file) : undefined),
    () => undefined,
  );
}
export function forgetComposerUploads(owner: string, files: readonly File[]) {
  const preparation = preparations.get(owner);
  if (!preparation) return;
  for (const file of files) {
    preparation.accepted.delete(file);
    preparation.states.delete(file);
  }
  if (!preparation.states.size && !preparation.inFlight.size) preparations.delete(owner);
  listeners.forEach((listener) => listener());
}
