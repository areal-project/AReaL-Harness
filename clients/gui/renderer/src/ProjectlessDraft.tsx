import type { ImageAnnotationTarget } from "./imageAnnotations.js";
import { currentErrorText } from "./errors/currentErrorText.js";
import { useEffect, useState } from "react";
import {
  WorkspacePreparationStatus,
  type WorkspacePreparationState,
} from "./WorkspacePreparationStatus.js";
import { DraftComposer } from "./DraftComposer.js";
import type { Action, Data, PlatformServices, Snapshot } from "./services.js";
import { call } from "./services.js";

const key = "areal-gui:draft:projectless:new";
export function ProjectlessDraft({
  snapshot,
  services,
  action,
  readAction,
  onOpen,
  onPanel,
  onAnnotate,
}: {
  snapshot: Snapshot;
  services: PlatformServices;
  action: Action;
  readAction: Action;
  onOpen: (pid: string, tid: string) => Promise<void>;
  onPanel: (panel: string) => void;
  onAnnotate?: (target: ImageAnnotationTarget) => void;
}) {
  const deferred = localStorage.getItem(`${key}:intent`) === "schedule";
  const [catalog, setCatalog] = useState<Data>();
  const [preparing, setPreparing] = useState(false);
  const [prepared, setPrepared] = useState<Data>();
  const [error, setError] = useState("");
  const [ownerId, setOwnerId] = useState(() => localStorage.getItem(`${key}:project`));
  const owner = snapshot.projects.find((p) => p.id === ownerId) ?? prepared;
  const ready = snapshot.connection?.state === "ready";
  const prepare = async () => {
    setPreparing(true);
    setError("");
    try {
      let requestId = localStorage.getItem(`${key}:workspace-request`);
      if (!requestId) {
        requestId = crypto.randomUUID();
        localStorage.setItem(`${key}:workspace-request`, requestId);
      }
      const result = await call(services, "projectless", { operation: "prepare", requestId });
      localStorage.setItem(`${key}:project`, result.projectId);
      setOwnerId(result.projectId);
      const project = (await services.snapshot()).projects.find((p) => p.id === result.projectId);
      if (!project?.state?.connected) throw new Error("项目外任务目录尚未准备好，请重试");
      setPrepared(project);
      return project;
    } catch (cause) {
      setError((cause as Error).message);
      throw cause;
    } finally {
      setPreparing(false);
    }
  };
  useEffect(() => {
    if (ownerId && ready && !owner?.state?.connected)
      void readAction("connect", { projectId: ownerId }).catch(() => {});
  }, [ownerId, ready]);
  useEffect(() => {
    if (!ready || ownerId || deferred) return;
    let active = true;
    void prepare().catch((cause) => {
      if (active) setError(currentErrorText(cause));
    });
    return () => {
      active = false;
    };
  }, [ready, ownerId]);
  useEffect(() => {
    if (!ready || !deferred || ownerId) return;
    let active = true;
    void call(services, "projectless", { operation: "catalog" })
      .then((result) => {
        if (active) setCatalog(result);
      })
      .catch((cause) => {
        if (active) setError(currentErrorText(cause));
      });
    return () => {
      active = false;
    };
  }, [ready, deferred, ownerId, services]);
  const draftOwner = owner ?? {
    id: "projectless",
    root: "",
    profiles: [],
    models: catalog?.models ?? [],
    lastAcceptedModel: catalog?.lastAcceptedModel,
    pending: [],
    state: { connected: false },
    outcomes: {},
  };
  const preparation: WorkspacePreparationState =
    ready && owner?.state?.connected
      ? { kind: "ready" }
      : deferred && catalog && !preparing && !error
        ? { kind: "ready" }
        : ready && (error || owner?.error || owner?.state?.error)
          ? { kind: "unavailable", detail: error || owner?.error || owner?.state?.error }
          : { kind: "preparing" };
  const retry = async () => {
    setError("");
    try {
      if (ownerId) await readAction("connect", { projectId: ownerId });
      else if (deferred) setCatalog(await call(services, "projectless", { operation: "catalog" }));
      else await prepare();
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  return (
    <>
      <DraftComposer
        onAnnotate={onAnnotate}
        project={draftOwner}
        backendReady={ready}
        modelCatalogReady={deferred && !!catalog}
        preparationStatus={
          <WorkspacePreparationStatus
            state={preparation}
            scope={ownerId ? "connection" : "workspace"}
            onRetry={preparation.kind === "unavailable" ? retry : undefined}
          />
        }
        draftKey={key}
        prepareProject={prepare}
        action={action}
        readAction={readAction}
        onPanel={onPanel}
        onOpen={async (pid, tid) => {
          localStorage.removeItem(`${key}:intent`);
          localStorage.removeItem(`${key}:project`);
          localStorage.removeItem(`${key}:workspace-request`);
          await onOpen(pid, tid);
        }}
      />
    </>
  );
}
