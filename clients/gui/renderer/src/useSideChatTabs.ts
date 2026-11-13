import { useI18n } from "./i18n/IntlProvider.js";
import { currentErrorText } from "./errors/currentErrorText.js";
import { useEffect, useRef, useState } from "react";
import type { Action, Data } from "./services.js";
import {
  recoveredOutcome,
  recoveryMessage,
  type RecoveryFailure,
  type RecoveryOperation,
} from "./recoveryPresentation.js";
import { attachmentDrafts, attachmentErrors } from "./Composer.js";
import { registerTransientComposer, forgetTransientComposer } from "./composerDraftStorage.js";
import {
  clearConversationSelections,
  conversationSelectionScope,
} from "./conversationSelectionReference.js";

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
export const sideResourceTab = (childId: string, resource: string) =>
  `side-resource:${childId}:${resource}`;
export function parseSideResourceTab(
  id: string,
): { childId: string; resource: string } | undefined {
  if (!id.startsWith("side-resource:")) return;
  const separator = id.indexOf(":", "side-resource:".length);
  if (separator < 0) return;
  return {
    childId: id.slice("side-resource:".length, separator),
    resource: id.slice(separator + 1),
  };
}
export type SideResourceBinding = { close: (resource: string) => Promise<void> };
type PendingCreation = {
  projectId: string;
  sourceThreadId: string;
  requestId: string;
  operation?: RecoveryOperation;
};

export function useSideChatTabs(action: Action, projects: Data[]) {
  const { t } = useI18n();
  const [tabs, updateTabs] = useState<SideChatTab[]>([]);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const pending = useRef(new Map<string, PendingCreation>());
  const [unconfirmed, setUnconfirmed] = useState<Record<string, PendingCreation>>({});
  const [creationErrors, setCreationErrors] = useState<Record<string, string>>({});
  const setCreationError = (owner: string, message: string) =>
    setCreationErrors((current) =>
      current[owner] === message ? current : { ...current, [owner]: message },
    );
  const clearPending = (owner: string) => {
    pending.current.delete(owner);
    setUnconfirmed((current) => {
      if (!current[owner]) return current;
      const next = { ...current };
      delete next[owner];
      return next;
    });
  };
  const setTabs = (next: SideChatTab[]) => {
    tabsRef.current = next;
    updateTabs(next);
  };
  const add = (projectId: string, parentId: string, childId: string) => {
    const existing = tabsRef.current.find(
      (tab) => tab.projectId === projectId && tab.childId === childId,
    );
    if (existing) return existing;
    let ordinal = 1;
    const siblings = tabsRef.current.filter(
      (tab) => tab.projectId === projectId && tab.parentId === parentId,
    );
    while (siblings.some((tab) => tab.ordinal === ordinal)) ordinal++;
    const tab: SideChatTab = { id: `side:${childId}`, projectId, parentId, childId, ordinal };
    registerTransientComposer(projectId, childId);
    setTabs([...tabsRef.current, tab]);
    return tab;
  };
  useEffect(() => {
    // journal 是恢复的权威；本地只保留响应到达前的身份，缺记录不代表未受理。
    for (const project of projects) {
      for (const entry of project.pending ?? []) {
        if (
          entry.method !== "areal/side/create" ||
          !entry.params?.sourceThreadId ||
          !entry.params.requestId
        )
          continue;
        const owner = `${project.id}:${entry.params.sourceThreadId}`;
        const request: PendingCreation = {
          projectId: project.id,
          sourceThreadId: entry.params.sourceThreadId,
          requestId: entry.params.requestId,
          operation: entry.operation,
        };
        pending.current.set(owner, request);
        const operation = request.operation ?? {
          requestId: request.requestId,
          method: entry.method,
          target: { kind: "project" as const },
        };
        if (
          !entry.awaitingResponse &&
          !recoveredOutcome(project, request.requestId, request.sourceThreadId, operation)
        )
          setUnconfirmed((current) =>
            current[owner]?.requestId === request.requestId
              ? current
              : { ...current, [owner]: request },
          );
      }
    }
    for (const [owner, request] of pending.current) {
      const project = projects.find((item) => item.id === request.projectId);
      if (!project) continue;
      const operation = request.operation ?? {
        requestId: request.requestId,
        method: "areal/side/create",
        target: { kind: "project" as const },
      };
      const outcome = recoveredOutcome(
        project,
        request.requestId,
        request.sourceThreadId,
        operation,
      );
      if (!outcome) continue;
      clearPending(owner);
      if (outcome.status === "failed" || outcome.accepted === false)
        setCreationError(
          owner,
          recoveryMessage({ message: outcome.message || t("chat.side.unavailable") }),
        );
      else if (outcome.threadId) {
        setCreationError(owner, "");
        add(request.projectId, request.sourceThreadId, outcome.threadId);
      }
    }
  }, [projects, unconfirmed]);
  const create = async (projectId: string, sourceThreadId: string, firstText = "") => {
    const owner = `${projectId}:${sourceThreadId}`;
    if (
      pending.current.has(owner) ||
      projects.some(
        (project) =>
          project.id === projectId &&
          project.pending?.some(
            (entry: Data) =>
              entry.method === "areal/side/create" &&
              entry.params?.sourceThreadId === sourceThreadId,
          ),
      )
    )
      throw new Error(t("chat.side.pendingCreation"));
    setCreationError(owner, "");
    const requestId = crypto.randomUUID();
    const request = { projectId, sourceThreadId, requestId };
    pending.current.set(owner, request);
    try {
      const result = await action("side", {
        operation: "create",
        ...request,
        ...(firstText ? { firstInput: { text: firstText } } : {}),
      });
      if (!result.threadId)
        throw Object.assign(new Error(t("chat.side.missingIdentity")), {
          submissionUnknown: true,
          requestId,
        });
      clearPending(owner);
      return add(projectId, sourceThreadId, result.threadId);
    } catch (cause) {
      const failure = cause as RecoveryFailure;
      if (
        failure.submissionUnknown ||
        failure.outcome?.kind === "unconfirmed" ||
        failure.outcome?.kind === "admitted"
      ) {
        const operation =
          failure.outcome && "operation" in failure.outcome ? failure.outcome.operation : undefined;
        const original = {
          ...request,
          requestId: operation?.requestId ?? failure.requestId ?? requestId,
          operation,
        };
        pending.current.set(owner, original);
        setUnconfirmed((current) => ({ ...current, [owner]: original }));
      } else {
        clearPending(owner);
        setCreationError(owner, recoveryMessage(failure));
      }
      throw cause;
    }
  };
  const recoverCreation = async (projectId: string, sourceThreadId: string) => {
    const owner = `${projectId}:${sourceThreadId}`;
    const request = pending.current.get(owner);
    if (!request) return;
    try {
      const result = await action("side", {
        operation: "recover",
        method: "areal/side/create",
        projectId: request.projectId,
        sourceThreadId: request.sourceThreadId,
        requestId: request.requestId,
      });
      if (!result.confirmed) return;
      clearPending(owner);
      if (result.status === "failed" || result.accepted === false) {
        setCreationError(
          owner,
          recoveryMessage({ message: result.message || t("chat.side.unavailable") }),
        );
        return;
      }
      setCreationError(owner, "");
      return result.threadId ? add(projectId, sourceThreadId, result.threadId) : undefined;
    } catch (cause) {
      setCreationError(owner, recoveryMessage(cause as RecoveryFailure));
      throw cause;
    }
  };
  const forget = (tab: SideChatTab) => {
    forgetTransientComposer(tab.projectId, tab.childId);
    const key = `areal-gui:draft:${tab.projectId}:${tab.childId}`;
    attachmentDrafts.delete(key);
    attachmentErrors.delete(key);
    clearConversationSelections(conversationSelectionScope(tab.projectId, tab.childId));
    setTabs(tabsRef.current.filter((item) => item !== tab && item.id !== tab.id));
  };
  const close = async (tab: SideChatTab) => {
    const current = tabsRef.current.find((item) => item.id === tab.id);
    if (!current) return;
    let requestId = current.closeRequestId ?? crypto.randomUUID();
    setTabs(
      tabsRef.current.map((item) =>
        item.id === current.id
          ? { ...item, closeRequestId: requestId, closeError: undefined }
          : item,
      ),
    );
    try {
      const result: Data = await action(
        "side",
        current.closeRequestId
          ? {
              operation: "recover",
              method: "areal/side/close",
              projectId: current.projectId,
              threadId: current.childId,
              requestId,
            }
          : {
              operation: "close",
              projectId: current.projectId,
              threadId: current.childId,
              requestId,
            },
      );
      if (typeof result.requestId === "string") requestId = result.requestId;
      if (!result.cleanupConfirmed) throw new Error(t("chat.side.closeUnconfirmed"));
      forget(current);
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean; outcome?: { kind: string } };
      const rejected = failure.outcome?.kind === "rejected";
      setTabs(
        tabsRef.current.map((item) =>
          item.id === current.id
            ? {
                ...item,
                closeRequestId: rejected ? undefined : requestId,
                closeError: currentErrorText(failure),
              }
            : item,
        ),
      );
      throw cause;
    }
  };
  return {
    tabs,
    create,
    close,
    forget,
    recoverCreation,
    getTab: (projectId: string, childId: string) =>
      tabsRef.current.find((tab) => tab.projectId === projectId && tab.childId === childId),
    hasChild: (projectId: string, childId: string) =>
      tabsRef.current.some((tab) => tab.projectId === projectId && tab.childId === childId),
    creationError: (projectId: string, parentId: string) =>
      creationErrors[`${projectId}:${parentId}`],
    pendingCreation: (projectId: string, parentId: string) =>
      unconfirmed[`${projectId}:${parentId}`],
  };
}
