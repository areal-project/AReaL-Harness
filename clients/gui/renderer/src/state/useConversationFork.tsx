import { useRef, useState } from "react";
import { currentErrorText } from "../errors/currentErrorText.js";
import { ForkTargetDialog } from "../ForkTargetDialog.js";
import type { Action, Data } from "../services.js";

export function useConversationFork(
  project: Data | undefined,
  thread: Data | undefined,
  resourceAction: Action,
  open: (projectId: string, threadId: string) => Promise<void>,
  setError: (message: string) => void,
) {
  const activeConversation = useRef("");
  activeConversation.current = `${project?.id ?? ""}:${thread?.id ?? ""}`;
  const [forkIntent, setForkIntent] = useState<{
    projectId: string;
    sourceThreadId: string;
    turnId: string;
    route: string;
    anchor?: HTMLElement;
    resolve: () => void;
  } | null>(null);
  const forkFromTurn = (turnId: string, anchor?: HTMLElement): Promise<void> => {
    if (!project || !thread) return Promise.resolve();
    const owner = project.id;
    const sourceThreadId = thread.id;
    const route = `${owner}:${sourceThreadId}`;
    return new Promise((resolve) =>
      setForkIntent({
        projectId: owner,
        sourceThreadId,
        turnId,
        route,
        anchor:
          anchor ??
          document.querySelector<HTMLElement>(
            `[data-turn-id="${CSS.escape(turnId)}"] .turn-fork-trigger`,
          ) ??
          undefined,
        resolve,
      }),
    );
  };
  return {
    forkFromTurn,
    dialog: (
      <>
        {forkIntent && (
          <ForkTargetDialog
            anchor={forkIntent.anchor}
            onClose={() => {
              forkIntent.resolve();
              setForkIntent((current) => (current === forkIntent ? null : current));
            }}
            onCheck={async () => {
              await resourceAction("reconcile", { projectId: forkIntent.projectId });
            }}
            onCreate={async () => {
              const result = await resourceAction("fork", {
                projectId: forkIntent.projectId,
                sourceThreadId: forkIntent.sourceThreadId,
                anchor: { turnId: forkIntent.turnId, boundary: "after" },
                workspaceMode: "sharedCurrent",
              });
              forkIntent.resolve();
              setForkIntent((current) => (current === forkIntent ? null : current));
              if (activeConversation.current === forkIntent.route)
                void open(forkIntent.projectId, result.threadId).catch((cause) =>
                  setError(currentErrorText(cause)),
                );
            }}
          />
        )}
      </>
    ),
  };
}
