import type { Translate } from "./i18n/IntlProvider.js";
import { useSyncExternalStore } from "react";

export const CONVERSATION_SELECTION_MAX_TEXT_LENGTH = 8_000;
export const CONVERSATION_SELECTION_MAX_COUNT = 8;
export const CONVERSATION_SELECTION_MAX_TOTAL_LENGTH = 16_000;
export type ConversationSelectionContentType = "user" | "assistant" | "reasoning" | "tool";
export interface ConversationSelectionReference {
  id: string;
  sourceSessionId: string;
  sourceRowId: string;
  contentType: ConversationSelectionContentType;
  text: string;
}
export type ConversationSelectionAppendResult =
  | { ok: true; references: readonly ConversationSelectionReference[]; duplicate: boolean }
  | { ok: false; reason: "single" | "count" | "total" };
const empty: readonly ConversationSelectionReference[] = [];
const referencesByScope = new Map<string, readonly ConversationSelectionReference[]>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const publish = () => listeners.forEach(listener => listener());
export const conversationSelectionScope = (projectId: string, threadId: string) => `${projectId}\0${threadId}`;
export const readConversationSelections = (scope: string) => referencesByScope.get(scope) ?? empty;
export const useConversationSelections = (scope: string) => useSyncExternalStore(subscribe, () => readConversationSelections(scope));
const dedupeKey = (reference: ConversationSelectionReference) =>
  [reference.sourceSessionId, reference.sourceRowId, reference.contentType, reference.text].join("\0");

export function appendConversationSelectionReference(current: readonly ConversationSelectionReference[], reference: ConversationSelectionReference): ConversationSelectionAppendResult {
  if (reference.text.length > CONVERSATION_SELECTION_MAX_TEXT_LENGTH) return { ok: false, reason: "single" };
  if (current.some(item => dedupeKey(item) === dedupeKey(reference))) return { ok: true, references: current, duplicate: true };
  if (current.length >= CONVERSATION_SELECTION_MAX_COUNT) return { ok: false, reason: "count" };
  if (current.reduce((sum, item) => sum + item.text.length, 0) + reference.text.length > CONVERSATION_SELECTION_MAX_TOTAL_LENGTH) return { ok: false, reason: "total" };
  return { ok: true, references: [...current, reference], duplicate: false };
}
export function addConversationSelection(scope: string, reference: ConversationSelectionReference) {
  const result = appendConversationSelectionReference(readConversationSelections(scope), reference);
  if (result.ok && !result.duplicate) { referencesByScope.set(scope, result.references); publish(); }
  return result;
}
export function consumeConversationSelections(scope: string, captured: readonly ConversationSelectionReference[]) {
  const ids = new Set(captured.map(reference => reference.id));
  const next = readConversationSelections(scope).filter(reference => !ids.has(reference.id));
  if (next.length) referencesByScope.set(scope, next); else referencesByScope.delete(scope);
  publish();
}
export function clearConversationSelections(scope: string) { referencesByScope.delete(scope); publish(); }
export function selectionLimitMessage(t: Translate, reason: "single" | "count" | "total") {
  return t(reason === "single" ? "chat.selection.singleLimit" : reason === "count" ? "chat.selection.countLimit" : "chat.selection.totalLimit");
}
const USER_SELECT_BLOCK_PATTERN = /(?:\n\n)?# userselect:\n```userselect\n([\s\S]*?)\n```\s*$/;
const LEGACY_BLOCK_PATTERN = /(?:\n\n)?# Conversation selections:\n```zcode-conversation-selections\n([\s\S]*?)\n```\s*$/;
export function parsePromptConversationSelections(text: string): { visibleContent: string; references: readonly { text: string }[] } {
  const match = text.match(USER_SELECT_BLOCK_PATTERN) ?? text.match(LEGACY_BLOCK_PATTERN);
  if (!match) return { visibleContent: text, references: [] };
  try {
    const parsed: unknown = JSON.parse(match[1] ?? "[]");
    if (!Array.isArray(parsed) || parsed.some(value => !value || typeof value !== "object" || typeof value.text !== "string")) return { visibleContent: text, references: [] };
    return { visibleContent: text.slice(0, match.index).trimEnd(), references: parsed.map(value => ({ text: value.text })) };
  } catch { return { visibleContent: text, references: [] }; }
}
