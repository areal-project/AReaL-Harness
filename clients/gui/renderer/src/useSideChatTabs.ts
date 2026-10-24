import { useI18n } from "./i18n/IntlProvider.js";
import { useRef, useState } from "react";
import type { Action, Data } from "./services.js";
import { attachmentDrafts, attachmentErrors } from "./Composer.js";
import { registerTransientComposer, forgetTransientComposer } from "./composerDraftStorage.js";
import { clearConversationSelections, conversationSelectionScope } from "./conversationSelectionReference.js";

export type SideChatTab = {
  id: `side:${string}`;
  projectId: string;
  parentId: string;
  childId: string;
  ordinal: number;
  closeRequestId?: string;
  closeError?: string;
};
export const isSideChatTab = (id: string) => id.startsWith("side:");
export const sideResourceTab = (childId: string, resource: string) => `side-resource:${childId}:${resource}`;
export function parseSideResourceTab(id: string): { childId: string; resource: string } | undefined {
  if (!id.startsWith("side-resource:")) return;
  const separator = id.indexOf(":", "side-resource:".length);
  if (separator < 0) return;
  return { childId: id.slice("side-resource:".length, separator), resource: id.slice(separator + 1) };
}
export type SideResourceBinding = { close: (resource: string) => Promise<void> };
type PendingCreation = { projectId: string; sourceThreadId: string; requestId: string };

export function useSideChatTabs(action: Action) {
  const { t } = useI18n();
  const [tabs, updateTabs] = useState<SideChatTab[]>([]);
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const pending = useRef(new Map<string, PendingCreation>());
  const setTabs = (next: SideChatTab[]) => { tabsRef.current = next; updateTabs(next); };
  const add = (projectId: string, parentId: string, childId: string) => {
    const existing = tabsRef.current.find(tab => tab.projectId === projectId && tab.childId === childId);
    if (existing) return existing;
    let ordinal = 1;
    const siblings = tabsRef.current.filter(tab => tab.projectId === projectId && tab.parentId === parentId);
    while (siblings.some(tab => tab.ordinal === ordinal)) ordinal++;
    const tab: SideChatTab = { id: `side:${childId}`, projectId, parentId, childId, ordinal };
    registerTransientComposer(projectId, childId);
    setTabs([...tabsRef.current, tab]);
    return tab;
  };
  const create = async (projectId: string, sourceThreadId: string, firstText = "") => {
    const owner = `${projectId}:${sourceThreadId}`;
    if (pending.current.has(owner)) throw new Error(t("chat.side.pendingCreation"));
    const requestId = crypto.randomUUID();
    const request = { projectId, sourceThreadId, requestId };
    pending.current.set(owner, request);
    try {
      const result = await action("side", { operation: "create", ...request, ...(firstText ? { firstInput: { text: firstText } } : {}) });
      if (!result.threadId) throw Object.assign(new Error(t("chat.side.missingIdentity")), { submissionUnknown: true, requestId });
      pending.current.delete(owner);
      return add(projectId, sourceThreadId, result.threadId);
    } catch (cause) {
      if (!(cause as { submissionUnknown?: boolean }).submissionUnknown) pending.current.delete(owner);
      throw cause;
    }
  };
  const recoverCreation = async (projectId: string, sourceThreadId: string) => {
    const owner = `${projectId}:${sourceThreadId}`;
    const request = pending.current.get(owner);
    if (!request) return;
    const result = await action("side", { operation: "recover", method: "areal/side/create", ...request });
    if (!result.confirmed) throw new Error(t("chat.side.unknownCreation"));
    pending.current.delete(owner);
    return result.threadId && result.accepted !== false ? add(projectId, sourceThreadId, result.threadId) : undefined;
  };
  const forget = (tab: SideChatTab) => {
    forgetTransientComposer(tab.projectId, tab.childId);
    const key = `areal-gui:draft:${tab.projectId}:${tab.childId}`;
    attachmentDrafts.delete(key); attachmentErrors.delete(key);
    clearConversationSelections(conversationSelectionScope(tab.projectId, tab.childId));
    setTabs(tabsRef.current.filter(item => item !== tab && item.id !== tab.id));
  };
  const close = async (tab: SideChatTab) => {
    const current = tabsRef.current.find(item => item.id === tab.id);
    if (!current) return;
    let requestId = current.closeRequestId ?? crypto.randomUUID();
    setTabs(tabsRef.current.map(item => item.id === current.id ? { ...item, closeRequestId: requestId, closeError: undefined } : item));
    try {
      const result: Data = await action("side", current.closeRequestId
        ? { operation: "recover", method: "areal/side/close", projectId: current.projectId, threadId: current.childId, requestId }
        : { operation: "close", projectId: current.projectId, threadId: current.childId, requestId });
      if (typeof result.requestId === "string") requestId = result.requestId;
      if (!result.cleanupConfirmed) throw new Error(t("chat.side.closeUnconfirmed"));
      forget(current);
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean; outcome?: { kind: string } };
      const rejected = failure.outcome?.kind === "rejected";
      setTabs(tabsRef.current.map(item => item.id === current.id ? { ...item, closeRequestId: rejected ? undefined : requestId, closeError: failure.message } : item));
      throw cause;
    }
  };
  return { tabs, create, close, forget, recoverCreation, getTab: (projectId: string, childId: string) => tabsRef.current.find(tab => tab.projectId === projectId && tab.childId === childId), hasChild: (projectId: string, childId: string) => tabsRef.current.some(tab => tab.projectId === projectId && tab.childId === childId), hasPendingCreation: (projectId: string, parentId: string) => pending.current.has(`${projectId}:${parentId}`) };
}
