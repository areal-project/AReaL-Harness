import { useSyncExternalStore } from "react";
import type { Data } from "./services.js";

export interface BrowserAnnotation {
  id: string;
  comment: string;
  label: string;
  url: string;
  capturedAt: string;
  captureId: string;
  region: { x: number; y: number; width: number; height: number };
  point?: { x: number; y: number };
  evidence: string;
}
export type SentBrowserAnnotation = BrowserAnnotation & { imageUri: string };
// 标注元信息随既有附件 File 存活；不另建历史或持久图片副本。
const annotations = new WeakMap<File, BrowserAnnotation>();
export const browserAnnotation = (file: File) => annotations.get(file);
export const attachBrowserAnnotation = (file: File, note: BrowserAnnotation) =>
  annotations.set(file, note);
const editing = new Set<string>();
const listeners = new Set<() => void>();
export function setBrowserAnnotationEditing(key: string, active: boolean) {
  if (editing.has(key) === active) return;
  if (active) editing.add(key);
  else editing.delete(key);
  listeners.forEach((listener) => listener());
}
export const useBrowserAnnotationEditing = (key: string) =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => editing.has(key),
  );
const prefix = "浏览器标注 v1：";
// 自动生成的聊天标题只呈现用户正文，版本化证据留在消息展开区。
export function browserAnnotationTitle(text: string): string {
  const index = text.indexOf(prefix);
  return index < 0 ? text : text.slice(0, index).trim() || "浏览器标注";
}
export const browserAnnotationText = (note: BrowserAnnotation, imageUri: string) =>
  prefix + JSON.stringify({ ...note, imageUri });

// 仅将能关联到同一条 Core 消息图片的完整标注投影成卡片；其他文本原样显示。
export function sentBrowserAnnotations(text: string, attachments: Data[]) {
  const notes: SentBrowserAnnotation[] = [];
  const lines = text.split("\n").filter((line) => {
    if (!line.startsWith(prefix)) return true;
    try {
      const note = JSON.parse(line.slice(prefix.length));
      if (
        !["id", "comment", "label", "url", "capturedAt", "captureId", "evidence", "imageUri"].every(
          (k) => typeof note[k] === "string",
        ) ||
        !note.comment.trim() ||
        !/^areal:\/\/blob\/[A-Za-z0-9_-]+$/.test(note.imageUri) ||
        !attachments.some(
          (part) => part.type === "image" && (part.url ?? part.uri) === note.imageUri,
        ) ||
        !note.region ||
        !["x", "y", "width", "height"].every(
          (k) => Number.isSafeInteger(note.region[k]) && note.region[k] >= 0,
        ) ||
        !note.region.width ||
        !note.region.height
      )
        return true;
      notes.push(note);
      return false;
    } catch {
      return true;
    }
  });
  return { text: lines.join("\n").trim(), notes };
}
