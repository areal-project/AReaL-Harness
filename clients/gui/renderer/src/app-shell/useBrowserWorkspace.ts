import { useCallback, useEffect, useRef, useState } from "react";
import type { Data, PlatformServices } from "../services.js";
import type { OwnedPreviewRequest } from "@areal/workbench/desktop-contract";

type WithoutOwner<Request> = Request extends unknown
  ? {
      [
        Key in keyof Request as string extends Key
          ? never
          : Key extends "projectId" | "threadId"
            ? never
            : Key
      ]: Request[Key];
    }
  : never;
export type BrowserWorkspaceRequest = WithoutOwner<OwnedPreviewRequest>;

export const browserTabId = (pageId: string) => `browser:${pageId}`;
export const isBrowserTab = (id: string) => id.startsWith("browser:");
export const browserPageId = (id: string) => (isBrowserTab(id) ? id.slice(8) : undefined);
export interface BrowserPage {
  pageId: string;
  title: string;
  url: string;
  resource: string;
}

// One window-local projection of Main's pages, also while a file/terminal is active.
// Page identity, selection, permissions and native lifetime remain with Main/Core.
export function useBrowserWorkspace(
  services: PlatformServices,
  projectId: string,
  threadId: string,
  activePageId?: string,
) {
  const owner = `${projectId}:${threadId}`;
  const current = useRef({ owner, activePageId });
  current.current = { owner, activePageId };
  const [projection, setProjection] = useState<{ owner: string; value: Data }>({
    owner,
    value: {},
  });
  const publish = useCallback(
    (value: Data) => {
      if (current.current.owner !== owner) return;
      setProjection((previous) =>
        previous.owner === owner &&
        previous.value.workspace?.workspaceId === value.workspace?.workspaceId &&
        previous.value.workspace?.sequence > value.workspace?.sequence
          ? previous
          : { owner, value },
      );
    },
    [owner],
  );
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (!projectId || !threadId) return;
    let alive = true,
      reading = false,
      again = false,
      subscribedWorkspace = "",
      lastValue = "";
    const refresh = async () => {
      if (!alive) return;
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      const target = current.current.activePageId;
      try {
        const value = await services.preview({
          operation: "state",
          projectId,
          threadId,
          ...(target ? { pageId: target } : {}),
        });
        if (!alive || current.current.owner !== owner) return;
        if (target !== current.current.activePageId) {
          again = true;
          return;
        }
        const serialized = JSON.stringify(value);
        if (serialized !== lastValue) {
          lastValue = serialized;
          publish(value);
        }
        if (value.workspace?.workspaceId && value.workspace.workspaceId !== subscribedWorkspace) {
          const snapshot = await services.preview({ operation: "subscribe", projectId, threadId });
          if (alive) {
            subscribedWorkspace = snapshot.workspaceId;
            again = true;
          }
        }
      } catch {
        /* Connection/ownership failures remain on the existing desktop surface. */
      } finally {
        reading = false;
        if (alive && again) {
          again = false;
          void refresh();
        }
      }
    };
    refreshRef.current = refresh;
    const off = services.onPreviewEvent?.((event) => {
      if (
        event.workspaceId === subscribedWorkspace ||
        (event.projectId === projectId && event.threadId === threadId)
      )
        void refresh();
    });
    void refresh();
    const timer = setInterval(() => void refresh(), 500);
    return () => {
      alive = false;
      clearInterval(timer);
      off?.();
      void services.preview({ operation: "unsubscribe", projectId, threadId }).catch(() => {});
    };
  }, [services, projectId, threadId, owner, publish]);
  useEffect(() => {
    void refreshRef.current();
  }, [activePageId]);
  const request = useCallback(
    async (request: BrowserWorkspaceRequest) => {
      if (current.current.owner !== owner) throw new Error("页面归属已变化");
      const result = await services.preview({ ...request, projectId, threadId });
      if (current.current.owner === owner) {
        if (
          result.workspace?.workspaceId &&
          result.browser?.pageId === current.current.activePageId
        )
          publish(result);
        await refreshRef.current();
      }
      return result;
    },
    [services, projectId, threadId, owner, publish],
  );
  const value = projection.owner === owner ? projection.value : {};
  const state =
    !activePageId || value.browser?.pageId === activePageId
      ? value
      : { workspace: value.workspace };
  return {
    state,
    pages: (value.workspace?.pages ?? []) as BrowserPage[],
    workspace: value.workspace,
    request,
  };
}
