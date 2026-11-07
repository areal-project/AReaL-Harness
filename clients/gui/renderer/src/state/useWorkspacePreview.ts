import React, { useCallback } from "react";
import {
  browserPageId,
  browserTabId,
  isBrowserTab,
  useBrowserWorkspace,
} from "../app-shell/useBrowserWorkspace.js";
import { type PlatformServices } from "../services.js";
import { useSessionNavigation } from "../state/useSessionNavigation.js";
import { useWorkspacePanels } from "../state/useWorkspacePanels.js";
export function useWorkspacePreview(
  services: PlatformServices,
  session: ReturnType<typeof useSessionNavigation>,
  workspacePanels: ReturnType<typeof useWorkspacePanels>,
  setError: (message: string) => void,
) {
  const { project, projectId, threadId } = session;
  const { panel } = workspacePanels.view;
  const panelReturnTarget = React.useRef<{ element: HTMLElement; route: string } | null>(null);
  const previewOwner = React.useRef("");
  previewOwner.current = `${project?.id ?? ""}:${threadId}`;
  const browserWorkspace = useBrowserWorkspace(
    services,
    project?.id ?? "",
    threadId,
    browserPageId(panel),
  );
  const rememberPanelTrigger = useCallback(() => {
    const focused = document.activeElement;
    const element =
      focused?.getAttribute("role") === "menuitem"
        ? (document.querySelector<HTMLElement>('[aria-haspopup="menu"][aria-expanded="true"]') ??
          focused)
        : focused;
    if (element instanceof HTMLElement && !element.closest(".side-panel"))
      panelReturnTarget.current = { element, route: `${projectId}:${threadId}` };
  }, [projectId, threadId]);
  const openingBrowser = React.useRef<string | null>(null);
  const openBrowser = useCallback(
    async (create = false, url?: string) => {
      if (!project) return;
      const owner = `${project.id}:${threadId}`;
      if (openingBrowser.current === owner) return;
      openingBrowser.current = owner;
      if (!isBrowserTab(panel)) rememberPanelTrigger();
      if (!threadId || services.capabilities?.native === false) {
        workspacePanels.exposePanel();
        workspacePanels.selectPanel("预览");
        openingBrowser.current = null;
        return;
      }
      try {
        let value = await browserWorkspace.request({ operation: "state" });
        if (previewOwner.current !== owner) return;
        if (create || !value.workspace?.selectedPageId)
          value = await browserWorkspace.request({ operation: "newPage" });
        if (previewOwner.current !== owner) return;
        const pageId = value.browser?.pageId;
        if (!pageId) return;
        if (url) await browserWorkspace.request({ operation: "navigate", pageId, url });
        if (previewOwner.current !== owner) return;
        await browserWorkspace.request({ operation: "selectPage", pageId });
        if (previewOwner.current !== owner) return;
        workspacePanels.exposePanel();
        workspacePanels.selectPanel(browserTabId(pageId));
      } catch (cause) {
        if (previewOwner.current === owner) setError((cause as Error).message);
      } finally {
        if (openingBrowser.current === owner) openingBrowser.current = null;
      }
    },
    [project?.id, threadId, browserWorkspace.request, panel, rememberPanelTrigger],
  );
  const onLink = useCallback(
    (url: string) => {
      if (services.capabilities?.native === false) {
        try {
          const target = new URL(url);
          if (["http:", "https:", "mailto:"].includes(target.protocol))
            window.open(target.href, "_blank", "noopener,noreferrer");
        } catch {}
        return;
      }
      if (!project) return;
      const owner = `${project.id}:${threadId}`;
      void services
        .preview({ operation: "openLink", projectId: project.id, threadId, url })
        .then((result) => {
          if (previewOwner.current !== owner || result.destination !== "internal") return;
          workspacePanels.exposePanel();
          void openBrowser(false, result.url);
        })
        .catch((cause) => {
          if (previewOwner.current === owner) setError(cause.message);
        });
    },
    [services, project?.id, threadId, openBrowser],
  );
  const subscribeReveals = () =>
    services.onPreviewEvent?.((event) => {
      // 仅呈现当前聊天已由 Core 批准的页面，不切换后台聊天或重放导航。
      if (
        event.kind !== "reveal" ||
        previewOwner.current !== `${event.projectId}:${event.threadId}`
      )
        return;
      workspacePanels.selectLayout("split");
      workspacePanels.selectPanel(browserTabId(event.pageId));
    });
  return {
    previewOwner,
    browserWorkspace,
    panelReturnTarget,
    rememberPanelTrigger,
    openBrowser,
    onLink,
    subscribeReveals,
  };
}
