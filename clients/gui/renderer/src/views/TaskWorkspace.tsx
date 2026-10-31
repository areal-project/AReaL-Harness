import { useSyncExternalStore } from "react";
import { Button } from "../components/ui/button.js";
import { Composer } from "../Composer.js";
import { stageComposerDraft } from "../composerDraftStorage.js";
import { SidebarToggleIcon } from "../homeChromeIcons.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { NavigationBackIcon } from "../interfaceIcons.js";
import { Messages } from "../Messages.js";
import type { Action, Snapshot } from "../services.js";
import { projectExecutionBlocked } from "../state/projectExecution.js";
import type { createTaskWorkspace } from "../state/taskWorkspace.js";
import { TaskCenter } from "../TaskCenter.js";
import { TaskResourcesPopover } from "./TaskResourcesPopover.js";

type Props = {
  workspace: ReturnType<typeof createTaskWorkspace>;
  snapshot: Snapshot;
  action: Action;
  dark: boolean;
  sidebar: boolean;
  onShowSidebar: () => void;
  onOpenThread: (projectId: string, threadId: string) => Promise<void>;
  onNewTask: (projectId?: string) => void;
  onPanel: (name: string) => void;
  onFile: (path: string) => void;
  onLink: (url: string) => void;
  onReview: (projectId: string, threadId: string, turnId: string) => void;
};

export function TaskWorkspace({
  workspace,
  snapshot,
  action,
  dark,
  sidebar,
  onShowSidebar,
  onOpenThread,
  onNewTask,
  onPanel,
  onFile,
  onLink,
  onReview,
}: Props) {
  const { t } = useI18n();
  const view = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const library = snapshot.library;
  return (
    <TaskCenter
      target={view.target}
      initialProjectId={view.scope}
      defaultProjectId={view.scope}
      projects={snapshot.projects.map((p) => ({
        ...p,
        name:
          library?.projects?.[p.id]?.title ||
          (p.projectless ? t("operations.schedules.newTitle") : p.root.split(/[\\/]/).pop()),
      }))}
      connected={snapshot.connection?.state === "ready"}
      action={action}
      onOpenThread={(pid, id) => void onOpenThread(pid, id)}
      onStartDraft={(pid, text) => {
        stageComposerDraft(
          pid ? { kind: "project", projectId: pid } : { kind: "projectless" },
          text,
          true,
        );
        onNewTask(pid ?? "");
      }}
      onOpenModelSettings={() => onPanel("设置")}
      renderConversation={(owner, managementThread, beforeTurns, options) => (
        <>
          <Messages
            beforeTurns={beforeTurns}
            afterTurns={options?.afterTurns}
            embedded={options?.embedded}
            readOnly={options?.readOnly}
            decisionShown={!options?.embedded && !options?.readOnly}
            reserveResponseSpace={!options?.embedded && !options?.afterTurns}
            project={owner}
            thread={managementThread}
            action={action}
            dark={dark}
            onLink={onLink}
            onFile={(path) => {
              void onOpenThread(owner.id, managementThread.id).then(() => onFile(path));
            }}
            onReview={(turnId) => {
              void onOpenThread(owner.id, managementThread.id).then(() => {
                onReview(owner.id, managementThread.id, turnId);
              });
            }}
            readTurnReview={(turnId, itemId) =>
              action("workspace", {
                projectId: owner.id,
                threadId: managementThread.id,
                turnId,
                itemId,
                operation: "turnReview",
              })
            }
          />
          {!options?.embedded && !options?.readOnly && (
            <Composer
              key={managementThread.id}
              project={owner}
              thread={managementThread}
              executionBlocked={projectExecutionBlocked(snapshot.lifecycle, owner.id)}
              action={action}
              readAction={action}
              onPanel={(name) => {
                if (name === "设置") {
                  onPanel("设置");
                } else {
                  void onOpenThread(owner.id, managementThread.id).then(() => onPanel(name));
                }
              }}
              onNew={() => void onNewTask()}
            />
          )}
        </>
      )}
      renderResources={(owner, managementThread, scheduledTask, revealKey?: string) => (
        <TaskResourcesPopover
          revealKey={workspace.pendingReveal(revealKey)}
          onReveal={workspace.consumeReveal}
          project={owner}
          thread={managementThread}
          scheduledTask={scheduledTask}
          action={action}
          onPanel={(name) => {
            void onOpenThread(owner.id, managementThread.id).then(() => onPanel(name));
          }}
          onAgent={(id) => void onOpenThread(owner.id, id)}
          onFile={(path) => {
            void onOpenThread(owner.id, managementThread.id).then(() => onFile(path));
          }}
        />
      )}

      navigation={
        <>
          {!sidebar && (
            <Button
              unstyled
              className="icon-button"
              aria-label={t("common.navigation.expandSidebar")}
              onClick={() => onShowSidebar()}
            >
              <SidebarToggleIcon />
            </Button>
          )}
          <Button
            unstyled
            className="icon-button"
            aria-label={t("common.navigation.backToChat")}
            onClick={() => {
              workspace.returnToConversation();
            }}
          >
            <NavigationBackIcon />
          </Button>
        </>
      }
    />
  );
}
