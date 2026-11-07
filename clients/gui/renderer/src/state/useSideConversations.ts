import { useRef } from "react";
import { sending } from "../Composer.js";
import {
  addConversationSelection,
  conversationSelectionScope,
  selectionLimitMessage,
  type ConversationSelectionReference,
} from "../conversationSelectionReference.js";
import { useI18n } from "../i18n/IntlProvider.js";
import type { RecoveryFailure } from "../recoveryPresentation.js";
import type { Action, Data, Snapshot } from "../services.js";
import { useSideChatTabs, type SideChatTab } from "../useSideChatTabs.js";
import { projectExecutionBlocked } from "./projectExecution.js";
import type { useWorkspacePanels } from "./useWorkspacePanels.js";

export function useSideConversations(
  project: Data | undefined,
  thread: Data | undefined,
  threadId: string,
  snapshot: Snapshot,
  resourceAction: Action,
  workspacePanels: ReturnType<typeof useWorkspacePanels>,
  annotationVisible: boolean,
  viewRefreshing: boolean,
  rememberPanelTrigger: () => void,
  setError: (message: string) => void,
) {
  const { t } = useI18n();
  const { panel, workspaceView } = workspacePanels.view;
  const panelOwner = `${project?.id ?? ""}:${threadId}`;
  const sideChats = useSideChatTabs(resourceAction, snapshot.projects);
  const sideSource = useRef({ owner: panelOwner, instanceId: project?.core?.instanceId });
  sideSource.current = { owner: panelOwner, instanceId: project?.core?.instanceId };
  const canCreateSide =
    !!project &&
    !!thread &&
    project.core?.features?.sideExecutableV2 === true &&
    !!project.state?.connected &&
    !thread.desktop?.archived &&
    !thread.parentThreadId &&
    thread.conversation?.kind !== "side" &&
    !project.configurations?.[thread.id]?.options?.appendInstructions?.startsWith(
      "AREAL_TASK_DRAFT_V1\n",
    ) &&
    !matchMedia("(max-width: 640px)").matches;
  const revealSide = (tab: SideChatTab) => {
    if (!sideChats.hasChild(tab.projectId, tab.childId)) return;
    workspacePanels.revealSide(tab, matchMedia("(max-width: 1200px)").matches);
  };
  const openSideResource = (tab: SideChatTab, resource: string) => {
    if (!sideChats.hasChild(tab.projectId, tab.childId)) return;
    workspacePanels.openSideResource(tab, resource);
  };
  const removeSideResource = workspacePanels.removeSideResource;
  const createSide = async (text = "") => {
    if (!canCreateSide || !project || !thread) throw new Error(t("chat.side.unavailable"));
    rememberPanelTrigger();
    const owner = sideSource.current;
    const tab = await sideChats.create(project.id, thread.id, text);
    if (
      sideSource.current.owner === owner.owner &&
      sideSource.current.instanceId === owner.instanceId
    )
      revealSide(tab);
    return tab;
  };
  const newSide = () => {
    if (!project || !thread) return;
    const owner = sideSource.current;
    const recovering = sideChats.pendingCreation(project.id, thread.id);
    const operation = recovering
      ? sideChats.recoverCreation(project.id, thread.id).then((tab) => {
          if (
            tab &&
            sideSource.current.owner === owner.owner &&
            sideSource.current.instanceId === owner.instanceId
          )
            revealSide(tab);
        })
      : createSide();
    void operation.catch(() => {});
  };
  const removeSideTab = (tab: SideChatTab) => {
    sideChats.forget(tab);
    workspacePanels.removeSide(tab);
  };
  const reconcileClosedTabs = () => {
    for (const tab of sideChats.tabs) {
      const owner = snapshot.projects.find((project) => project.id === tab.projectId);
      const observed = owner?.state?.threads?.[tab.childId];
      if (
        observed?.conversation?.policy?.kind === "sideExecutableV2" &&
        observed.desktop?.archived &&
        Object.values<Data>(owner?.outcomes ?? {}).some(
          (outcome) =>
            outcome.method === "areal/side/close" &&
            outcome.threadId === tab.childId &&
            outcome.accepted === true &&
            outcome.cleanupConfirmed === true,
        )
      )
        removeSideTab(tab);
    }
  };
  const canStageSelection =
    !!project &&
    !!thread &&
    !thread.desktop?.archived &&
    !thread.parentThreadId &&
    thread.conversation?.kind !== "side" &&
    !!project.state?.connected &&
    !project.observationErrors?.[thread.id] &&
    snapshot.connection?.state === "ready" &&
    !viewRefreshing &&
    !projectExecutionBlocked(snapshot.lifecycle, project.id);
  const addSelectionToChat = (reference: ConversationSelectionReference) => {
    if (!canStageSelection || !project || !thread) return;
    const key = `areal-gui:draft:${project.id}:${thread.id}`;
    if (
      sending.has(key) ||
      localStorage.getItem(`${key}:pending`) ||
      localStorage.getItem(`${key}:queue-edit`) ||
      project.pending?.some((request: Data) => request.params?.threadId === thread.id)
    )
      return;
    const result = addConversationSelection(
      conversationSelectionScope(project.id, thread.id),
      reference,
    );
    if (!result.ok) setError(selectionLimitMessage(t, result.reason));
  };
  const openSideSelection = (
    _selection: Data,
    _excerpt: string,
    _anchor?: Data,
    reference?: ConversationSelectionReference,
  ) => {
    if (!canStageSelection || !canCreateSide || !project || !thread || !reference) return;
    const owner = {
      projectId: project.id,
      parentId: thread.id,
      coreInstanceId: project.core?.instanceId,
    };
    const sourceOwner = `${owner.projectId}:${owner.parentId}`;
    const sourceCurrent = () =>
      sideSource.current.owner === sourceOwner &&
      sideSource.current.instanceId === owner.coreInstanceId;
    const active =
      workspaceView !== "conversation" && !annotationVisible
        ? sideChats.tabs.find(
            (tab) =>
              tab.id === panel &&
              tab.projectId === owner.projectId &&
              tab.parentId === owner.parentId,
          )
        : undefined;
    if (active?.closeRequestId) return;
    void (async () => {
      let tab = active;
      if (tab) {
        try {
          const snapshot = await resourceAction("open", {
            projectId: tab.projectId,
            threadId: tab.childId,
          });
          const current = sideChats.getTab(tab.projectId, tab.childId);
          const observedProject = snapshot.projects?.find(
            (item: Data) => item.id === tab!.projectId,
          );
          const observed = observedProject?.state?.threads?.[tab.childId];
          if (
            !current ||
            current.closeRequestId ||
            !sourceCurrent() ||
            (observed?.executionCore?.instanceId ?? observedProject?.core?.instanceId) !==
              owner.coreInstanceId ||
            observed?.desktop?.archived ||
            (observed?.conversation?.origin &&
            typeof observed.conversation.origin === "object" &&
            "sourceThreadId" in observed.conversation.origin
              ? observed.conversation.origin.sourceThreadId
              : undefined) !== owner.parentId
          )
            return;
          tab = current;
        } catch (cause) {
          const failure = cause as RecoveryFailure;
          if (
            failure.code !== -32004 &&
            failure.code !== "THREAD_NOT_FOUND" &&
            failure.reason !== "thread_not_found"
          )
            throw cause;
          const current = sideChats.getTab(tab.projectId, tab.childId);
          if (!current || current.closeRequestId || !sourceCurrent()) return;
          removeSideTab(current);
          tab = undefined;
        }
      }
      if (!sourceCurrent()) return;
      tab ??= await createSide();
      const current = sideChats.getTab(tab.projectId, tab.childId);
      if (!current || current.closeRequestId || !sourceCurrent()) return;
      const key = `areal-gui:draft:${tab.projectId}:${tab.childId}`;
      if (
        sending.has(key) ||
        project.pending?.some((request: Data) => request.params?.threadId === tab.childId)
      )
        return;
      const result = addConversationSelection(
        conversationSelectionScope(tab.projectId, tab.childId),
        reference,
      );
      if (!result.ok) setError(selectionLimitMessage(t, result.reason));
      revealSide(tab);
    })().catch((cause) => setError(cause.message));
  };
  return {
    sideChats,
    canCreateSide,
    revealSide,
    openSideResource,
    removeSideResource,
    createSide,
    newSide,
    removeSideTab,
    reconcileClosedTabs,
    canStageSelection,
    addSelectionToChat,
    openSideSelection,
  };
}
