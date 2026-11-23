import { TitleTooltip } from "@areal/ui";
import { useEffect, useRef, useState } from "react";
import { GitBranch, GitFork } from "lucide-react";
import { useI18n } from "./i18n/IntlProvider.js";
import { isProjectHibernated } from "./state/userStates.js";
import {
  WorkspacePreparationStatus,
  type WorkspacePreparationState,
} from "./WorkspacePreparationStatus.js";
import type { Action, Data } from "./services.js";

export function ComposerWorkspaceContext({
  project,
  threadId,
  action,
  backendReady = false,
  showBranch = true,
  cloud = false,
  quietConnecting = false,
}: {
  project: Data;
  threadId?: string;
  action: Action;
  backendReady?: boolean;
  showBranch?: boolean;
  cloud?: boolean;
  /** 本地项目草稿态下隐藏常态“正在连接…”，仅保留真实故障与显式停止恢复入口。 */
  quietConnecting?: boolean;
}) {
  const { t } = useI18n();
  const suppressed = project.scheduling?.suppressed === true;
  const error = project.error || project.state?.error;
  const hostState = project.state?.hostState;
  const unavailable =
    !cloud && backendReady && (suppressed || Boolean(error) || hostState === "unavailable");
  const hibernated = !cloud && isProjectHibernated(project);
  const connected = !cloud && backendReady && !!project.state?.connected && !suppressed;
  const targetOwner = JSON.stringify([project.id, threadId, project.root, cloud]);
  const fetchOwner = JSON.stringify([project.id, threadId, project.root, connected, cloud]);
  const request = useRef(action);
  request.current = action;
  const silentWakeOwner = useRef<string | null>(null);
  if (hibernated) silentWakeOwner.current = targetOwner;
  else if (
    connected ||
    unavailable ||
    (silentWakeOwner.current !== null && silentWakeOwner.current !== targetOwner)
  )
    silentWakeOwner.current = null;
  const silentWarming =
    !connected &&
    !unavailable &&
    !hibernated &&
    hostState === "starting" &&
    silentWakeOwner.current === targetOwner;
  const [result, setResult] = useState<{
    targetOwner: string;
    fetchOwner: string;
    info?: Data;
    error?: string;
  }>();
  useEffect(() => {
    if (!connected) return;
    let active = true;
    void request
      .current("workspace", {
        projectId: project.id,
        ...(threadId ? { threadId } : {}),
        operation: "info",
      })
      .then(
        (info) => {
          if (active) setResult({ targetOwner, fetchOwner, info });
        },
        (cause) => {
          if (active)
            setResult((prev) =>
              prev?.targetOwner === targetOwner && prev.info
                ? { ...prev, fetchOwner }
                : { targetOwner, fetchOwner, error: (cause as Error).message },
            );
        },
      );
    return () => {
      active = false;
    };
  }, [fetchOwner]);
  const cachedInfo = result?.targetOwner === targetOwner ? result.info : undefined;
  const currentError = result?.fetchOwner === fetchOwner ? result.error : undefined;
  const preparation: WorkspacePreparationState = unavailable
    ? { kind: "unavailable", detail: error || "" }
    : { kind: "preparing" };
  return (
    <div className="composer-workspace-context" role="group" aria-label={t("workspace.context")}>
      {cloud ? null : unavailable ? (
        <WorkspacePreparationStatus
          key={fetchOwner}
          state={preparation}
          onRetry={() =>
            request.current("connect", {
              projectId: project.id,
              resumeScheduling: true,
            })
          }
        />
      ) : cachedInfo ? (
        <>
          {cachedInfo.target && (
            <TitleTooltip title={cachedInfo.root ?? project.root}>
              <span className="composer-workspace-location">
                <GitFork className="size-3.5" aria-hidden="true" />
                {t("workspace.worktree")}
              </span>
            </TitleTooltip>
          )}
          {showBranch && cachedInfo.git !== false && cachedInfo.branch && (
            <TitleTooltip title={cachedInfo.branch}>
              <span className="composer-workspace-branch" aria-label={t("workspace.currentBranch")}>
                <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
                <span>
                  {cachedInfo.branch === "(detached)"
                    ? t("workspace.detachedHead")
                    : cachedInfo.branch}
                </span>
              </span>
            </TitleTooltip>
          )}
        </>
      ) : quietConnecting || hibernated || silentWarming ? null : !connected ? (
        <WorkspacePreparationStatus key={fetchOwner} state={preparation} />
      ) : currentError ? null : ( // 分支与工作树只是补充信息，读不到就不显示，不打断输入。
        <span>{t("workspace.readingInfo")}</span>
      )}
    </div>
  );
}
