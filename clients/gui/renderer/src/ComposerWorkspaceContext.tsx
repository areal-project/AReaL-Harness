import { useEffect, useRef, useState } from "react";
import { GitBranch, GitFork } from "lucide-react";
import { WorkspaceLocalIcon } from "./homeChromeIcons.js";
import { useI18n } from "./i18n/IntlProvider.js";
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
}: {
    project: Data;
    threadId?: string;
    action: Action;
    backendReady?: boolean;
    showBranch?: boolean;
}) {
    const { t } = useI18n();
    const connected = backendReady && !!project.state?.connected;
    const owner = JSON.stringify([project.id, threadId, project.root, connected]);
    const request = useRef(action);
    request.current = action;
    const [result, setResult] = useState<{ owner: string; info?: Data; error?: string }>();
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
                    if (active) setResult({ owner, info });
                },
                (error) => {
                    if (active) setResult({ owner, error: (error as Error).message });
                },
            );
        return () => {
            active = false;
        };
    }, [owner]);
    const current = result?.owner === owner ? result : undefined;
    const error = project.error || project.state?.error;
    const preparation: WorkspacePreparationState = connected
        ? { kind: "ready" }
        : backendReady && error
          ? { kind: "unavailable", detail: error }
          : { kind: "preparing" };
    return (
        <div
            className="composer-workspace-context"
            role="group"
            aria-label={t("workspace.context")}
        >
            {!connected ? (
                <WorkspacePreparationStatus
                    key={owner}
                    state={preparation}
                    onRetry={
                        preparation.kind === "unavailable"
                            ? () => request.current("connect", { projectId: project.id })
                            : undefined
                    }
                />
            ) : current?.error ? (
                <WorkspacePreparationStatus
                    state={{ kind: "unavailable", detail: current.error }}
                    scope="info"
                />
            ) : !current?.info ? (
                <span>{t("workspace.readingInfo")}</span>
            ) : (
                <>
                    <span
                        className="composer-workspace-location"
                        title={current.info.root ?? project.root}
                    >
                        {current.info.target ? (
                            <GitFork className="size-3.5" aria-hidden="true" />
                        ) : (
                            <WorkspaceLocalIcon />
                        )}
                        {t(current.info.target ? "workspace.worktree" : "workspace.local")}
                    </span>
                    {showBranch && current.info.git !== false && current.info.branch && (
                        <span
                            className="composer-workspace-branch"
                            aria-label={t("workspace.currentBranch")}
                            title={current.info.branch}
                        >
                            <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
                            <span>
                                {current.info.branch === "(detached)"
                                    ? t("workspace.detachedHead")
                                    : current.info.branch}
                            </span>
                        </span>
                    )}
                </>
            )}
        </div>
    );
}
