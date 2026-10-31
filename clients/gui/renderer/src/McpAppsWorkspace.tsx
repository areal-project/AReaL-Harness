import { observeResize } from "@areal/ui/observe-resize";
import { composerDraftStorage } from "./composerDraftStorage.js";
import { useI18n, formatUiMessage, UiMessageError, type UiMessage } from "./i18n/IntlProvider.js";
import { Button } from "./components/ui/button.js";
import { SettingsSelect } from "./settings/SettingsPageParts.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ProtocolError, type ContentBlock } from "@modelcontextprotocol/client";
import {
  McpAppHost,
  type McpAppMessage,
  type McpAppModelContext,
  type McpAppPlacement,
} from "./McpAppHost.js";
import { McpAppForm, type McpFormResponse } from "./McpAppForm.js";
import {
  mcpResultKey,
  type McpResultSource,
  type McpResultState,
  type McpAppDescriptor,
  type McpMetadataImageLoader,
} from "./mcp-app-services.js";
import { McpContentLabel } from "./McpComposerAttachments.js";
import { appendMcpDraft } from "./mcp-app-draft.js";
import { sending, markSending, submitMessage } from "./Composer.js";
import {
  McpAppEntrypoints,
  McpAppsSettings,
  McpAppsMentions,
  type McpAppServer,
  type McpAppTool,
  type McpAppsCommand,
} from "./settings/McpAppsSettings.js";
import type { Action, Data, PlatformServices } from "./services.js";
import type { ManagementResponseMap } from "@areal/workbench/desktop-contract/management";
import { SettingsDisclosure } from "./settings/SettingsDisclosure.js";
export type McpWorkspaceServer = McpAppServer;
type AppThreadIntent = "reuse-or-create" | "require-current" | "new";
type FormRequest = ManagementResponseMap["mcpForms"]["data"][number];
const appTab = (app: McpAppDescriptor) => `mcp-app:${app.instanceId}`;
const compatibilityHint: UiMessage = { id: "settings.apps.upgradeBackend" };
const visible = (block: ContentBlock) =>
  !(block.annotations?.audience?.length === 1 && block.annotations.audience[0] === "assistant");
function entrypoint(tool: McpAppTool, kind: string) {
  const value = tool._meta?.["openai/ui"] as { entrypoints?: { type?: string }[] } | undefined;
  return value?.entrypoints?.some((entry) => entry.type === kind) === true;
}
export function useMcpAppsWorkspace({
  services,
  project,
  deepLinksEnabled,
  projects,
  activeTab,
  threadId,
  action,
  onOpenThread,
  onReveal,
  onRemoveTab,
  onError,
}: {
  services: Pick<
    PlatformServices,
    "mcpApp" | "onMcpAppEvent" | "onMcpAppDeepLink" | "mcpFormResource"
  >;
  project?: Data;
  deepLinksEnabled: boolean;
  projects: Data[];
  activeTab: string;
  threadId: string;
  action: Action;
  onOpenThread: (projectId: string, threadId: string) => Promise<void>;
  onReveal: (tab: string, owner: { projectId: string; threadId: string }) => void;
  onRemoveTab: (tab: string) => void;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const { mcpApp, onMcpAppEvent, onMcpAppDeepLink, mcpFormResource } = services;
  const hostSupported = !!mcpApp && !!onMcpAppEvent;
  const desktopSupported = hostSupported && project?.desktopCapabilities?.currentCommands !== false;
  const loadMetadataImage = useMemo<McpMetadataImageLoader | undefined>(
    () => (mcpApp ? (source) => mcpApp({ operation: "metadataImage", source }) : undefined),
    [mcpApp],
  );
  const [servers, setServers] = useState<McpWorkspaceServer[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState<string | UiMessage>("");
  const [apps, setApps] = useState<McpAppDescriptor[]>([]),
    [forms, setForms] = useState<FormRequest[]>([]),
    [formError, setFormError] = useState<string | UiMessage>("");
  const [formPreview, setFormPreview] = useState<{
    requestId: string;
    contents: { uri?: string; text?: string; mimeType?: string }[];
  } | null>(null);
  const [resultStates, setResultStates] = useState<Record<string, McpResultState>>({});
  const resultIntents = useRef(
    new Map<
      string,
      {
        requestId: string;
        phase: "opening" | "open" | "closed" | "unknown" | "closing";
        token?: string;
      }
    >(),
  );
  const resultPending = useRef(new Map<string, Promise<void>>());
  const resultState = (key: string, value: McpResultState) =>
    setResultStates((states) => ({ ...states, [key]: value }));
  const appsRef = useRef(apps);
  appsRef.current = apps;
  const current = useRef({
    project,
    projects,
    activeTab,
    threadId,
    action,
    onOpenThread,
    onReveal,
    onRemoveTab,
    onError,
  });
  current.current = {
    project,
    projects,
    activeTab,
    threadId,
    action,
    onOpenThread,
    onReveal,
    onRemoveTab,
    onError,
  };
  const readEpoch = useRef(0),
    formPending = useRef(new Set<string>());
  const refresh = useCallback(async () => {
    const { project, threadId, action } = current.current;
    const epoch = ++readEpoch.current;
    if (
      !hostSupported ||
      !project?.state?.connected ||
      project.desktopCapabilities?.currentCommands === false
    ) {
      setServers([]);
      setLoading(false);
      setError(project?.desktopCapabilities?.currentCommands === false ? compatibilityHint : "");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await action("manage", {
        operation: "mcpApps",
        projectId: project.id,
        ...(threadId ? { threadId } : {}),
      });
      if (epoch !== readEpoch.current) return;
      if (!Array.isArray(result.data))
        throw new UiMessageError({ id: "settings.mcpAppsWorkspace.invalidAppDirectoryFormat" });
      setServers(result.data);
    } catch (cause) {
      if (epoch === readEpoch.current) {
        setServers([]);
        setError(
          cause instanceof UiMessageError
            ? cause.descriptor
            : cause instanceof Error
              ? cause.message
              : { id: "settings.mcpAppsWorkspace.appDirectoryUnavailable" },
        );
      }
    } finally {
      if (epoch === readEpoch.current) setLoading(false);
    }
  }, [hostSupported]);
  useEffect(() => {
    void refresh();
    return () => {
      readEpoch.current++;
    };
  }, [project?.id, project?.state?.connected, desktopSupported, threadId, refresh]);
  const removeApps = useCallback((tokens: Set<string>) => {
    const removed = appsRef.current.filter((app) => tokens.has(app.token));
    if (!removed.length) return;
    appsRef.current = appsRef.current.filter((app) => !tokens.has(app.token));
    setApps(appsRef.current);
    for (const app of removed) current.current.onRemoveTab(appTab(app));
  }, []);
  const close = useCallback(
    async (tab: string) => {
      const app = appsRef.current.find((item) => appTab(item) === tab);
      if (!app) return;
      const key = app.resultSource && mcpResultKey(app.resultSource);
      const intent = key ? resultIntents.current.get(key) : undefined;
      if (intent) intent.phase = "closing";
      try {
        if (!mcpApp) throw Error(t(compatibilityHint.id));
        await mcpApp({ operation: "close", token: app.token });
        if (intent) intent.phase = "closed";
        removeApps(new Set([app.token]));
      } catch (cause) {
        if (key)
          resultState(key, { message: "关闭结果待确认，请再次点击核对。原始记录仍可查看。" });
        throw cause;
      }
    },
    [removeApps, mcpApp, t],
  );
  const validationEpoch = useRef(0);
  const revalidate = useCallback(async () => {
    const epoch = ++validationEpoch.current;
    const { projects, action } = current.current;
    const owners = new Map<string, McpAppDescriptor[]>();
    const stale = new Set<string>();
    for (const app of appsRef.current) {
      const owner = projects.find((project) => project.id === app.projectId);
      if (
        !owner ||
        (owner.state?.connected &&
          (!owner.state.threads[app.threadId] ||
            owner.state.threads[app.threadId].desktop?.archived))
      ) {
        stale.add(app.token);
        continue;
      }
      if (!owner.state?.connected || owner.desktopCapabilities?.currentCommands === false) continue;
      const key = `${app.projectId}:${app.threadId}`;
      owners.set(key, [...(owners.get(key) ?? []), app]);
    }
    await Promise.allSettled(
      [...owners.values()].map(async (apps) => {
        const owner = apps[0];
        const result = await action("manage", {
          operation: "mcpApps",
          projectId: owner.projectId,
          threadId: owner.threadId,
        });
        if (!Array.isArray(result.data)) throw Error("应用目录格式无效");
        for (const app of apps) {
          const intent =
            app.resultSource && resultIntents.current.get(mcpResultKey(app.resultSource));
          if (
            !result.data.some(
              (server: McpWorkspaceServer) =>
                server.serverId === app.serverId && server.generation === app.generation,
            ) ||
            (app.resultSource &&
              (!intent || intent.requestId.split(".")[1] !== result.requestEpoch))
          )
            stale.add(app.token);
        }
      }),
    );
    if (epoch !== validationEpoch.current) return;
    for (const app of appsRef.current.filter((app) => stale.has(app.token))) {
      void close(appTab(app)).catch(() => {});
      if (app.resultSource)
        resultState(mcpResultKey(app.resultSource), {
          message: "交互结果暂不可用，原始记录仍可查看。",
        });
    }
    removeApps(stale);
  }, [removeApps, close]);
  const ownerVersion = JSON.stringify(
    apps.map((app) => {
      const owner = projects.find((project) => project.id === app.projectId);
      return [
        app.token,
        !!owner,
        owner?.state?.connected,
        owner?.core?.instanceId,
        owner?.core?.connectionGeneration,
        owner?.state?.threads[app.threadId]
          ? owner.state.threads[app.threadId].desktop?.archived === true
          : null,
      ];
    }),
  );
  useEffect(() => {
    void revalidate();
    return () => {
      validationEpoch.current++;
    };
  }, [ownerVersion, revalidate]);
  useEffect(() => {
    const listener = () => {
      void refresh();
      void revalidate();
    };
    window.addEventListener("areal-plugins-changed", listener);
    return () => window.removeEventListener("areal-plugins-changed", listener);
  }, [refresh, revalidate]);
  useEffect(() => {
    if (!hostSupported || !onMcpAppEvent) return;
    return onMcpAppEvent((event) => {
      if (
        "method" in event.notification &&
        event.notification.method === "ui/notifications/closed"
      ) {
        removeApps(new Set([event.token]));
        return;
      }
      if (
        !("method" in event.notification) ||
        event.notification.method !== "ui/notifications/host-context-changed"
      )
        return;
      const context = event.notification.params;
      if (context && typeof context === "object")
        setApps((items) =>
          items.map((app) =>
            app.token === event.token
              ? { ...app, hostContext: { ...app.hostContext, ...context } }
              : app,
          ),
        );
    });
  }, [hostSupported, onMcpAppEvent, removeApps]);
  useEffect(
    () => () => {
      if (!mcpApp) return;
      for (const app of appsRef.current)
        void mcpApp({ operation: "close", token: app.token }).catch(() => {});
    },
    [mcpApp],
  );
  async function ensureThread(intent: AppThreadIntent = "reuse-or-create") {
    const { project, threadId, action, onOpenThread } = current.current;
    if (!project?.state?.connected)
      throw Error(t("settings.mcpAppsWorkspace.connectTheProjectFirst"));
    if (!hostSupported || project.desktopCapabilities?.currentCommands === false)
      throw Error(t(compatibilityHint.id));
    if (intent !== "new" && threadId) {
      if (!project.state.threads[threadId] || project.state.threads[threadId].desktop?.archived)
        throw Error(t("settings.mcpAppsWorkspace.theAppConversationIsNoLongerAvailable"));
      return { projectId: project.id, threadId };
    }
    if (intent === "require-current")
      throw Error(t("settings.mcpAppsWorkspace.chooseAnAppConversationFirst"));
    const result = await action("create", { projectId: project.id });
    if (typeof result.threadId !== "string")
      throw Error(t("settings.mcpAppsWorkspace.couldNotCreateAnAppConversation"));
    await onOpenThread(project.id, result.threadId);
    return { projectId: project.id, threadId: result.threadId };
  }
  const pendingOpens = useRef(0);
  async function openApp(
    server: McpWorkspaceServer,
    tool: McpAppTool,
    options: {
      kind?: "global" | "thread" | "file";
      filePath?: string;
      deepLink?: string;
      arguments?: Record<string, unknown>;
    } = {},
  ) {
    const { project } = current.current;
    if (!project) throw Error(t("settings.mcpAppsWorkspace.chooseAProjectFirst"));
    if (!mcpApp || !onMcpAppEvent || project.desktopCapabilities?.currentCommands === false)
      throw Error(t(compatibilityHint.id));
    const global = options.kind === "global";
    const existing = appsRef.current.find(
      (app) =>
        !app.resultSource &&
        app.projectId === project.id &&
        app.serverId === server.serverId &&
        app.generation === server.generation &&
        app.toolMetadata?.name === tool.name &&
        !options.arguments &&
        (global || (app.threadId === current.current.threadId && !options.filePath)),
    );
    if (existing) {
      if (!project.state?.connected)
        throw Error(t("settings.mcpAppsWorkspace.connectTheProjectFirst"));
      if (
        !project.state.threads[existing.threadId] ||
        project.state.threads[existing.threadId].desktop?.archived
      )
        throw Error(t("settings.mcpAppsWorkspace.theAppConversationIsNoLongerAvailable"));
      if (options.deepLink)
        setApps((items) =>
          items.map((app) =>
            app.token === existing.token
              ? {
                  ...app,
                  hostContext: {
                    ...app.hostContext,
                    "openai/deepLink": { url: options.deepLink },
                  },
                }
              : app,
          ),
        );
      await current.current.onOpenThread(existing.projectId, existing.threadId);
      current.current.onReveal(appTab(existing), existing);
      return;
    }
    if (appsRef.current.length + pendingOpens.current >= 8)
      throw Error("最多可同时打开 8 个应用页面，请先关闭一个页面。");
    pendingOpens.current++;
    try {
      const owner = await ensureThread(global ? "require-current" : "reuse-or-create");
      const directory = await current.current.action("manage", {
        operation: "mcpApps",
        projectId: owner.projectId,
        threadId: owner.threadId,
      });
      if (current.current.project?.id !== project.id || owner.projectId !== project.id)
        throw Error(t("settings.mcpAppsWorkspace.theAppSProjectHasChangedOpen"));
      if (!Array.isArray(directory.data))
        throw new UiMessageError({ id: "settings.mcpAppsWorkspace.invalidAppDirectoryFormat" });
      const servers: McpWorkspaceServer[] = directory.data;
      const connectedServer = servers.find(
        (candidate) =>
          candidate.serverId === server.serverId &&
          candidate.pluginId === server.pluginId &&
          candidate.installedDigest === server.installedDigest,
      );
      const connectedTool = connectedServer?.tools.find(
        (candidate) => candidate.name === tool.name,
      );
      if (!connectedServer || !connectedTool)
        throw Error(t("settings.mcpAppsWorkspace.theAppConnectionOrPluginVersionHas"));
      // The initial tool can wait for ordinary approval in its owning conversation.
      await current.current.onOpenThread(owner.projectId, owner.threadId);
      const selectedProject = current.current.project;
      if (!selectedProject || selectedProject.id !== owner.projectId)
        throw Error(t("settings.mcpAppsWorkspace.theAppSProjectHasChangedOpen"));
      if (!selectedProject.state?.connected)
        throw Error(t("settings.mcpAppsWorkspace.connectTheProjectFirst"));
      if (selectedProject.desktopCapabilities?.currentCommands === false)
        throw Error(t(compatibilityHint.id));
      if (
        current.current.threadId !== owner.threadId ||
        !selectedProject.state.threads[owner.threadId] ||
        selectedProject.state.threads[owner.threadId].desktop?.archived
      )
        throw Error(t("settings.mcpAppsWorkspace.theAppConversationIsNoLongerAvailable"));
      const app = await mcpApp({
        operation: "open",
        ...owner,
        serverId: connectedServer.serverId,
        expectedGeneration: connectedServer.generation,
        toolName: connectedTool.name,
        ...(options.filePath ? { filePath: options.filePath } : {}),
        ...(options.deepLink ? { deepLink: options.deepLink } : {}),
        ...(options.arguments ? { arguments: options.arguments } : {}),
      });
      appsRef.current = [...appsRef.current, app];
      setApps(appsRef.current);
      current.current.onReveal(appTab(app), app);
    } finally {
      pendingOpens.current--;
    }
  }
  const openResult = useCallback(
    (source: McpResultSource): Promise<void> => {
      const key = mcpResultKey(source);
      const pending = resultPending.current.get(key);
      if (pending) return pending;
      const task = (async () => {
        const owner = current.current.projects.find((project) => project.id === source.projectId);
        if (
          !mcpApp ||
          !onMcpAppEvent ||
          !owner?.state?.connected ||
          owner.desktopCapabilities?.currentCommands === false
        ) {
          resultState(key, { message: "交互结果暂不可用，原始记录仍可查看。" });
          return;
        }
        let intent = resultIntents.current.get(key);
        resultState(key, { opening: true });
        try {
          if (intent?.phase === "closing") {
            await mcpApp({ operation: "close", token: intent.token });
            intent.phase = "closed";
          }
          const existing = appsRef.current.find(
            (app) => app.resultSource && mcpResultKey(app.resultSource) === key,
          );
          if (existing) {
            const directory = await current.current.action("manage", {
              operation: "mcpApps",
              projectId: source.projectId,
              threadId: source.threadId,
            });
            if (typeof directory.requestEpoch !== "string") throw Error("结果打开不可用");
            if (intent?.requestId.split(".")[1] !== directory.requestEpoch) {
              const closing = close(appTab(existing));
              removeApps(new Set([existing.token]));
              await closing;
              resultState(key, { message: "交互结果暂不可用，原始记录仍可查看。" });
              return;
            }
            if (
              current.current.project?.id === source.projectId &&
              current.current.threadId === source.threadId &&
              resultIntents.current.get(key) === intent &&
              intent?.phase === "open" &&
              appsRef.current.some((app) => app.token === existing.token)
            )
              current.current.onReveal(appTab(existing), existing);
            resultState(key, {});
            return;
          }
          if (!intent || intent.phase === "closed") {
            const directory = await current.current.action("manage", {
              operation: "mcpApps",
              projectId: source.projectId,
              threadId: source.threadId,
            });
            if (typeof directory.requestEpoch !== "string") throw Error("结果打开不可用");
            intent = {
              requestId: `result-v1.${directory.requestEpoch}.${crypto.randomUUID()}`,
              phase: "opening",
            };
            resultIntents.current.set(key, intent);
          }
          const reply = await mcpApp({
            operation: "openFromResult",
            ...source,
            requestId: intent.requestId,
          });
          if (reply.status === "open") {
            const app = { ...reply.app, resultSource: source };
            intent.phase = "open";
            intent.token = app.token;
            if (!appsRef.current.some((item) => item.token === app.token)) {
              appsRef.current = [...appsRef.current, app];
              setApps(appsRef.current);
            }
            if (
              current.current.project?.id === source.projectId &&
              current.current.threadId === source.threadId
            )
              current.current.onReveal(appTab(app), app);
            resultState(key, {});
          } else {
            intent.phase = "closed";
            resultState(key, {
              message:
                reply.status === "closed"
                  ? "交互结果已关闭，可再次打开。"
                  : "交互结果暂不可用，原始记录仍可查看。",
            });
          }
        } catch {
          if (intent?.phase === "opening") intent.phase = "unknown";
          resultState(key, {
            message:
              intent?.phase === "closing"
                ? "关闭结果待确认，请再次点击核对。原始记录仍可查看。"
                : "打开结果待确认，请再次点击核对。原始记录仍可查看。",
          });
        }
      })();
      resultPending.current.set(key, task);
      void task.finally(() => resultPending.current.delete(key));
      return task;
    },
    [close, removeApps, mcpApp, onMcpAppEvent],
  );
  const resultPageFailed = (app: McpAppDescriptor) => {
    if (!app.resultSource) return;
    const key = mcpResultKey(app.resultSource);
    resultState(key, { message: "交互结果无法打开，原始记录仍可查看。" });
    void close(appTab(app)).catch(() => {});
  };
  async function message(value: McpAppMessage) {
    const { projects, action, activeTab } = current.current;
    const project = projects.find((owner) => owner.id === value.projectId);
    const app = appsRef.current.find(
      (app) =>
        app.instanceId === value.instanceId &&
        app.projectId === value.projectId &&
        app.threadId === value.threadId,
    );
    if (!app) throw Error("应用已关闭");
    const foreground =
      current.current.project?.id === value.projectId &&
      current.current.threadId === value.threadId &&
      activeTab === appTab(app);
    if (!foreground && (value.target === "new" || !value.send))
      throw new ProtocolError(-32000, "后台应用无法打开会话或修改输入草稿。", {
        reason: "app_hidden",
      });
    if (project?.desktopCapabilities?.currentCommands === false)
      throw Error(t(compatibilityHint.id));
    if (
      !project ||
      project.id !== value.projectId ||
      !project.state?.threads[value.threadId] ||
      project.state.threads[value.threadId].desktop?.archived
    )
      throw Error(t("settings.mcpAppsWorkspace.theAppConversationIsNoLongerAvailable"));
    const owner =
      value.target === "new"
        ? await ensureThread("new")
        : { projectId: value.projectId, threadId: value.threadId };
    const key = `areal-gui:draft:${owner.projectId}:${owner.threadId}`;
    if (
      sending.has(key) ||
      project.pending?.some((entry: Data) => entry.params?.threadId === owner.threadId)
    )
      throw Error(t("settings.mcpAppsWorkspace.aSubmissionInThisConversationNeedsConfirmation"));
    if (!value.send) {
      appendMcpDraft(key, value.content);
      await current.current.onOpenThread(owner.projectId, owner.threadId);
      return;
    }
    const plain = value.content
      .filter((block) => block.type === "text" && !block._meta?.["openai/title"])
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    const content = value.content.filter(
      (block) => block.type !== "text" || block._meta?.["openai/title"],
    );
    const running = project.state.threads[owner.threadId]?.turns?.some(
      (turn: Data) => turn.status === "inProgress",
    );
    markSending(key, true);
    try {
      await submitMessage(action, owner.projectId, owner.threadId, plain, [], {
        appMessage: true,
        mcpContent: content,
        enqueue: !!running,
      });
    } finally {
      markSending(key, false);
    }
  }
  async function modelContext(value: McpAppModelContext) {
    setApps((items) =>
      items.map((app) =>
        app.instanceId === value.instanceId &&
        app.projectId === value.projectId &&
        app.threadId === value.threadId
          ? {
              ...app,
              hostContext: {
                ...app.hostContext,
                "openai/modelContext": {
                  content: value.content ?? [],
                  ...(value.structuredContent
                    ? { structuredContent: value.structuredContent }
                    : {}),
                },
              },
            }
          : app,
      ),
    );
  }
  async function clearContext(app: McpAppDescriptor) {
    if (
      !mcpApp ||
      !onMcpAppEvent ||
      current.current.project?.desktopCapabilities?.currentCommands === false
    )
      throw Error(t(compatibilityHint.id));
    const reply = await mcpApp({
      operation: "request",
      token: app.token,
      request: {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "ui/update-model-context",
        params: { content: [] },
      },
    });
    if (reply.error) throw Error(t("settings.mcpAppsWorkspace.couldNotRemoveAppContext"));
    setApps((items) =>
      items.map((item) =>
        item.token === app.token
          ? { ...item, hostContext: { ...item.hostContext, "openai/modelContext": null } }
          : item,
      ),
    );
  }
  useEffect(() => {
    if (!desktopSupported || !deepLinksEnabled || !onMcpAppDeepLink) return;
    return onMcpAppDeepLink(async (link) => {
      if (link.marketplace) throw Error(t("settings.mcpAppsWorkspace.theLinkDoesNotMatchASingle"));
      const candidates = servers.filter((server) => server.pluginId === link.pluginId);
      const matches = candidates.flatMap((server) =>
        server.tools
          .filter((tool) => tool.name === link.toolName && entrypoint(tool, "global"))
          .map((tool) => ({ server, tool })),
      );
      if (matches.length !== 1)
        throw Error(t("settings.mcpAppsWorkspace.theLinkDoesNotMatchASingle"));
      await openApp(matches[0].server, matches[0].tool, {
        kind: "global",
        deepLink: link.path,
      });
    });
  }, [servers, project?.id, deepLinksEnabled, desktopSupported, onMcpAppDeepLink]);
  useEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    if (!project?.state?.connected || !threadId || !desktopSupported) {
      setForms([]);
      setFormPreview(null);
      setFormError("");
      return;
    }
    const pid = project.id,
      tid = threadId;
    setForms([]);
    setFormError("");
    const read = async () => {
      if (current.current.project?.desktopCapabilities?.currentCommands === false) return;
      try {
        const result = await current.current.action("manage", {
          operation: "mcpForms",
          projectId: pid,
          threadId: tid,
        });
        if (active) {
          if (!Array.isArray(result.data))
            throw new UiMessageError({ id: "settings.mcpAppsWorkspace.invalidFormListFormat" });
          setForms(result.data.filter((form: FormRequest) => form.threadId === tid));
          setFormError("");
        }
      } catch (cause) {
        if (active)
          setFormError(
            cause instanceof UiMessageError
              ? cause.descriptor
              : cause instanceof Error
                ? cause.message
                : { id: "settings.mcpAppsWorkspace.couldNotReadPendingForms" },
          );
      } finally {
        if (active) timer = setTimeout(() => void read(), 3000);
      }
    };
    void read();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [project?.id, project?.state?.connected, desktopSupported, threadId]);
  async function respond(form: FormRequest, response: McpFormResponse | { unsupported: true }) {
    const key = `${form.threadId}:${form.requestId}`;
    if (formPending.current.has(key))
      throw Error(t("settings.mcpAppsWorkspace.theOriginalFormResponseIsBeingChecked"));
    const owner = current.current.project;
    if (owner?.desktopCapabilities?.currentCommands === false) throw Error(t(compatibilityHint.id));
    if (
      !owner ||
      current.current.threadId !== form.threadId ||
      !forms.some(
        (item) => item.requestId === form.requestId && item.generation === form.generation,
      )
    )
      throw Error(t("settings.mcpAppsWorkspace.thisFormHasExpired"));
    formPending.current.add(key);
    try {
      await current.current.action("manage", {
        operation: "mcpFormRespond",
        projectId: owner.id,
        threadId: form.threadId,
        requestId: form.requestId,
        response,
      });
      setForms((items) => items.filter((item) => item.requestId !== form.requestId));
      formPending.current.delete(key);
    } catch (cause) {
      if (!(cause as { submissionUnknown?: boolean }).submissionUnknown)
        formPending.current.delete(key);
      throw cause;
    }
  }
  async function previewForm(form: FormRequest, target: unknown) {
    const owner = current.current.project;
    if (owner?.desktopCapabilities?.currentCommands === false) throw Error(t(compatibilityHint.id));
    if (!owner || current.current.threadId !== form.threadId)
      throw Error(t("settings.mcpAppsWorkspace.thisFormHasExpired"));
    const result = await current.current.action("manage", {
      operation: "mcpFormPreview",
      projectId: owner.id,
      threadId: form.threadId,
      requestId: form.requestId,
      target,
    });
    if (current.current.project?.id !== owner.id || current.current.threadId !== form.threadId)
      return;
    if (
      target &&
      typeof target === "object" &&
      "type" in target &&
      target.type === "mcp_app_tool"
    ) {
      if (!("name" in target) || typeof target.name !== "string")
        throw Error(t("settings.mcpAppsWorkspace.invalidPreviewAppName"));
      const advertised = target as { name: string; arguments?: Record<string, unknown> };
      const server = servers.find(
        (item) => item.serverId === form.serverId && item.generation === form.generation,
      );
      const tool = server?.tools.find((item) => item.name === advertised.name);
      if (!server || !tool)
        throw Error(t("settings.mcpAppsWorkspace.thePreviewAppIsNoLongerAvailable"));
      await openApp(server, tool, { arguments: advertised.arguments ?? {} });
    } else {
      if (result.type !== "resource_link")
        throw Error(t("settings.mcpAppsWorkspace.invalidResourcePreviewFormat"));
      setFormPreview({ requestId: form.requestId, contents: result.resource.contents });
    }
  }
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<McpAppPlacement | null>(null);
  const displaySlot = useCallback((element: HTMLDivElement | null) => {
    setSlot(element);
  }, []);
  useLayoutEffect(() => {
    if (!slot || !activeTab) {
      setPlacement(null);
      return;
    }
    const measure = () => {
      const rect = slot.getBoundingClientRect();
      const next =
        rect.width > 0 && rect.height > 0 && getComputedStyle(slot).visibility !== "hidden"
          ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
          : null;
      setPlacement((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };
    measure();
    const ancestors = [];
    for (let at: HTMLElement | null = slot; at; at = at.parentElement) ancestors.push(at);
    const stopObserving = observeResize(ancestors, measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      stopObserving();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [slot, activeTab]);
  const contentFor = (app: McpAppDescriptor) => {
    const context = app.hostContext["openai/modelContext"] as
      | { content?: ContentBlock[] }
      | null
      | undefined;
    return context?.content?.filter(visible) ?? [];
  };
  return {
    supported: desktopSupported,
    loadMetadataImage,
    servers: desktopSupported ? servers : [],
    loading,
    error: formatUiMessage(t, error),
    refresh,
    openApp,
    openResult,
    resultStates,
    ensureThread,
    close,
    apps,
    titleFor: (tab: string) => {
      const app = apps.find((item) => appTab(item) === tab);
      return app
        ? (app.toolMetadata?.title ?? app.toolMetadata?.name ?? t("settings.mcpAppsWorkspace.app"))
        : undefined;
    },
    render: (tab: string) => {
      if (!desktopSupported) return <p role="status">{formatUiMessage(t, compatibilityHint)}</p>;
      return apps.some((app) => appTab(app) === tab) ? (
        <div data-mcp-app-slot={tab} ref={displaySlot} style={{ height: "100%", minHeight: 0 }} />
      ) : (
        <p role="status">{t("settings.mcpAppsWorkspace.thisAppIsClosedOpenItAgain")}</p>
      );
    },
    pages: apps.map((app) => (
      <McpAppHost
        key={app.token}
        app={app}
        context={app.hostContext}
        services={services}
        loadMetadataImage={loadMetadataImage}
        placement={
          activeTab === appTab(app) && project?.id === app.projectId && threadId === app.threadId
            ? placement
            : null
        }
        closeOnUnmount={false}
        onMessage={message}
        onModelContext={modelContext}
        onClose={() => {
          void close(appTab(app)).catch((cause) => current.current.onError(cause.message));
        }}
        onError={app.resultSource ? () => resultPageFailed(app) : onError}
      />
    )),
    contexts: (
      <div aria-label={t("settings.mcpAppsWorkspace.appContext")}>
        {(desktopSupported ? apps : [])
          .filter(
            (app) =>
              app.projectId === project?.id &&
              app.threadId === threadId &&
              contentFor(app).length > 0,
          )
          .map((app) => (
            <div key={app.token}>
              <SettingsDisclosure
                title={`${app.toolMetadata?.title ?? app.toolMetadata?.name ?? t("settings.mcpAppsWorkspace.appContext")} ${t("settings.apps.contextItems", { count: contentFor(app).length })}`}
              >
                {contentFor(app).map((block, index) => (
                  <McpContentLabel key={index} block={block} />
                ))}
              </SettingsDisclosure>
              <Button
                unstyled
                data-slot={undefined}
                type="submit"
                onClick={() => void clearContext(app).catch((cause) => onError(cause.message))}
              >
                {t("settings.mcpAppsWorkspace.removeAppContext")}
              </Button>
            </div>
          ))}
      </div>
    ),
    formsView: !desktopSupported ? null : (
      <>
        {forms.map((form) => (
          <McpAppForm
            key={`${form.serverId}:${form.generation}:${form.requestId}`}
            requestId={form.requestId}
            message={form.message}
            requestedSchema={form.requestedSchema}
            loadMetadataImage={loadMetadataImage}
            onRespond={(_id, response) => respond(form, response)}
            onUnsupported={() => respond(form, { unsupported: true })}
            onPreview={(target) => previewForm(form, target)}
            onPickResources={
              mcpFormResource
                ? async (fieldName) => {
                    if (current.current.project?.desktopCapabilities?.currentCommands === false)
                      throw Error(t(compatibilityHint.id));
                    if (
                      !project?.id ||
                      current.current.project?.id !== project.id ||
                      current.current.threadId !== form.threadId
                    )
                      throw new Error("Form owner expired");
                    const owner = {
                      projectId: project.id,
                      threadId: form.threadId,
                      requestId: form.requestId,
                      fieldName,
                    };
                    const result = await mcpFormResource("pick", owner);
                    if (
                      current.current.project?.id !== owner.projectId ||
                      current.current.threadId !== owner.threadId
                    ) {
                      await Promise.all(
                        (result.resources ?? []).map((item) =>
                          mcpFormResource("release", { ...owner, uri: item.uri }),
                        ),
                      );
                      throw new Error("Form owner expired");
                    }
                    return result.resources ?? [];
                  }
                : undefined
            }
            onReleaseResource={
              mcpFormResource
                ? async (fieldName, uri) => {
                    if (!project?.id) throw new Error("Form owner expired");
                    await mcpFormResource("release", {
                      projectId: project.id,
                      threadId: form.threadId,
                      requestId: form.requestId,
                      fieldName,
                      uri,
                    });
                  }
                : undefined
            }
          />
        ))}
        {formPreview && forms.some((form) => form.requestId === formPreview.requestId) && (
          <section aria-label={t("settings.mcpAppsWorkspace.resourcePreview")}>
            <Button
              unstyled
              data-slot={undefined}
              type="submit"
              onClick={() => setFormPreview(null)}
            >
              {t("settings.mcpAppsWorkspace.closeResourcePreview")}
            </Button>
            {formPreview.contents.map((resource, index) => (
              <article key={index}>
                <strong>{resource.mimeType ?? t("settings.mcpAppsWorkspace.resource")}</strong>
                {typeof resource.text === "string" ? (
                  <pre
                    style={{
                      whiteSpace: "pre-wrap",
                      maxHeight: 300,
                      overflow: "auto",
                    }}
                  >
                    {resource.text}
                  </pre>
                ) : (
                  <p>{t("settings.mcpAppsWorkspace.textPreviewIsUnavailableForThisBinary")}</p>
                )}
              </article>
            ))}
          </section>
        )}
        {formError && forms.length > 0 && <p role="alert">{formatUiMessage(t, formError)}</p>}
      </>
    ),
  };
}
export function McpAppsHub({
  workspace,
  project,
  threadId,
  action,
  pluginId,
}: {
  workspace: ReturnType<typeof useMcpAppsWorkspace>;
  project?: Data;
  threadId: string;
  action: Action;
  pluginId?: string;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string | null>(null),
    [feedback, setFeedback] = useState<string | UiMessage>("");
  const servers =
    pluginId === undefined
      ? workspace.servers
      : workspace.servers.filter((server) => server.pluginId === pluginId);
  const settingsServers = servers.filter((server) => server.capabilities?.["openai/settings"]);
  const hasEntrypoint = servers.some((server) =>
    server.tools.some((tool) => entrypoint(tool, "global")),
  );
  const server = settingsServers.find((server) => server.serverId === selected);
  const command: McpAppsCommand = (request) => action("manage", request);
  const run = async (server: McpWorkspaceServer, tool: McpAppTool) => {
    setFeedback("");
    if (tool._meta?.ui || tool._meta?.["ui/resourceUri"]) {
      await workspace.openApp(server, tool);
      return;
    }
    if (!project || !threadId)
      throw new UiMessageError({ id: "settings.mcpAppsWorkspace.chooseAnAppConversationFirst" });
    const result = await command({
      operation: "mcpExtensionCall",
      projectId: project.id,
      threadId,
      serverId: server.serverId,
      expectedGeneration: server.generation,
      kind: "settingsAction",
      arguments: { toolName: tool.name },
      requestId: crypto.randomUUID(),
    });
    if (result.isError)
      throw new UiMessageError({ id: "settings.mcpAppsWorkspace.theAppActionDidNotComplete" });
    setFeedback(
      (result.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n") || { id: "settings.mcpAppsWorkspace.actionCompleted" },
    );
  };
  if (pluginId !== undefined && !workspace.error && !hasEntrypoint && !settingsServers.length)
    return null;
  return (
    <section aria-label={t("settings.mcpAppsWorkspace.pluginApps")} className="plugin-apps-hub">
      <div>
        <h3>{t("settings.mcpAppsWorkspace.connectedApps")}</h3>
        <Button
          variant="outline"
          disabled={workspace.loading || !workspace.supported}
          onClick={() => void workspace.refresh()}
        >
          {t("settings.mcpAppsWorkspace.refreshApps")}
        </Button>
      </div>
      {workspace.error && <p role="alert">{workspace.error}</p>}
      {workspace.supported && !workspace.loading && !servers.length && (
        <p>{t("settings.mcpAppsWorkspace.noAppsAvailableConnectAnMCPServer")}</p>
      )}
      <McpAppEntrypoints
        servers={servers}
        kind="global"
        loadMetadataImage={workspace.loadMetadataImage}
        onOpen={(server, tool) =>
          void workspace
            .openApp(server, tool, { kind: "global" })
            .catch((cause) =>
              setFeedback(cause instanceof UiMessageError ? cause.descriptor : cause.message),
            )
        }
      />
      {settingsServers.length === 1 && !server && (
        <Button variant="outline" onClick={() => setSelected(settingsServers[0].serverId)}>
          {t("settings.mcpAppsWorkspace.openAppSettings")}
        </Button>
      )}
      {settingsServers.length > 1 && (
        <label>
          {t("settings.mcpAppsWorkspace.appSettings")}
          <SettingsSelect
            aria-label={t("settings.mcpAppsWorkspace.appSettings")}
            value={selected ?? ""}
            onValueChange={(value) => setSelected(value || null)}
          >
            <option value="">{t("settings.mcpAppsWorkspace.chooseAnApp")}</option>
            {settingsServers.map((server) => (
              <option key={server.serverId} value={server.serverId}>
                {server.title ?? server.serverId}
              </option>
            ))}
          </SettingsSelect>
        </label>
      )}
      {server &&
        (!threadId ? (
          <Button
            unstyled
            data-slot={undefined}
            type="submit"
            onClick={() =>
              void workspace
                .ensureThread()
                .catch((cause) =>
                  setFeedback(cause instanceof UiMessageError ? cause.descriptor : cause.message),
                )
            }
          >
            {t("settings.mcpAppsWorkspace.createAppConversation")}
          </Button>
        ) : server.capabilities?.["openai/settings"] ? (
          <McpAppsSettings
            key={`${server.serverId}:${server.generation}:${threadId}`}
            server={server}
            projectId={project!.id}
            threadId={threadId}
            command={command}
            onTool={run}
          />
        ) : (
          <p>{t("settings.mcpAppsWorkspace.thisAppDoesNotProvideStructuredSettings")}</p>
        ))}
      {feedback && <p role="status">{formatUiMessage(t, feedback)}</p>}
    </section>
  );
}
export function McpMentionsPicker({
  servers,
  projectId,
  threadId,
  action,
  onClose,
}: {
  servers: McpWorkspaceServer[];
  projectId: string;
  threadId: string;
  action: Action;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const candidates = servers.filter((server) => server.capabilities?.["openai/mentions"]);
  const [selected, setSelected] = useState(candidates[0]?.serverId ?? "");
  const server = candidates.find((item) => item.serverId === selected);
  return (
    <section aria-label={t("settings.mcpAppsWorkspace.chooseAppReference")}>
      <Button unstyled data-slot={undefined} type="submit" onClick={onClose}>
        {t("settings.mcpAppsWorkspace.closeReferencePicker")}
      </Button>
      <select value={selected} onChange={(event) => setSelected(event.target.value)}>
        {candidates.map((server) => (
          <option key={server.serverId} value={server.serverId}>
            {server.title ?? server.serverId}
          </option>
        ))}
      </select>
      {server ? (
        <McpAppsMentions
          server={server}
          projectId={projectId}
          threadId={threadId}
          command={(request) => action("manage", request)}
          onSelect={(item) => {
            const key = `areal-gui:draft:${projectId}:${threadId}`;
            const text = composerDraftStorage.getItem(key) ?? "";
            if (/(^|\s)@$/.test(text)) composerDraftStorage.setItem(key, text.slice(0, -1));
            appendMcpDraft(key, [item]);
            onClose();
          }}
        />
      ) : (
        <p>{t("settings.mcpAppsWorkspace.thisConnectionHasNoSearchableAppReferences")}</p>
      )}
    </section>
  );
}
