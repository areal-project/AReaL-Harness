import { createRoot } from "react-dom/client";
import { applyShellDelta, readShell } from "@areal/client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button, Input } from "@areal/ui";
import { FolderGit2, Monitor, Settings } from "lucide-react";
import { FeedbackNotice } from "@areal/ui/experimental";
import { applyThemeWithoutTransitions } from "@areal/ui/theme";
import { SettingsGroupCard, SettingsRow } from "@areal/ui/compositions";
import { ApplicationIntlProvider, useI18n, type MessageId } from "../i18n/IntlProvider.js";
import type { Data } from "../services.js";
import { MobileClient } from "./mobile-client.mjs";
import { MobileWorkspace } from "./mobile-workspace.mjs";
import { MobileCommands } from "./mobile-commands.mjs";
import { MobileWorkspaceView } from "./MobileWorkspace.js";
import { MobileCacheStore, type MobileHostCacheView } from "./mobile-cache.js";
import {
  formatCacheBytes,
  MobileProjectCacheSheet,
  OfflineCachedWorkspace,
  projectDisplayName,
  visibleAuthorizedProjects,
} from "./MobileProjectCacheSheet.js";
import {
  clientKind,
  keychain,
  observeBack,
  observeLifecycle,
  scanPairingLink,
  minimizeApp,
} from "./platform.js";
import "../styles.css";
import "../workbench.css";
import "./mobile.layout.css";

const cacheStore = new MobileCacheStore();
const client = new MobileClient({
  keychain,
  clientKind,
  capabilities: ["gui-read-v1", "gui-write-v1"],
});
const workspace = new MobileWorkspace(client, {
  readShell,
  applyShellDelta,
  saveShell: (
    ready: { hostId: string; grantRevision: number },
    shell: Parameters<typeof cacheStore.saveShell>[2],
  ) => {
    void cacheStore.saveShell(ready.hostId, ready.grantRevision, shell).catch(() => {});
  },
  saveSession: (ready: { hostId: string }, projectId: string | undefined, detail: Data) => {
    if (!projectId) return;
    void cacheStore
      .saveSession(ready.hostId, {
        projectId,
        threadId: detail.snapshot.threadId,
        serviceGeneration: detail.serviceGeneration,
        subscriptionId: detail.subscriptionId,
        connectionId: detail.connectionId,
        gatewayGeneration: detail.gatewayGeneration,
        sequence: detail.sequence,
        view: "conversation",
        snapshot: { mobileTurns: detail.snapshot.turns },
      })
      .catch(() => {});
  },
});
const commands = new MobileCommands(client, workspace);
client.onRevoked = async (hostId) => {
  if (hostId) await cacheStore.clearHost(hostId);
};
client.onCleared = async (hostId) => {
  if (hostId) await cacheStore.clearHost(hostId);
};

function MobileApp() {
  const { t } = useI18n();
  const state = useSyncExternalStore(client.subscribe, client.snapshot);
  const stale = useSyncExternalStore(workspace.subscribe, () => workspace.snapshot().stale);
  const accessChanged = useSyncExternalStore(
    workspace.subscribe,
    () => workspace.snapshot().accessChanged,
  );
  const [name, setName] = useState(t("mobile.deviceFallback"));
  const [link, setLink] = useState("");
  const [paste, setPaste] = useState(false);
  const [settings, setSettings] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [cacheSheetOpen, setCacheSheetOpen] = useState(false);
  const [endpointPaste, setEndpointPaste] = useState(false);
  const [endpointLink, setEndpointLink] = useState("");
  const [endpointNotice, setEndpointNotice] = useState<{
    tone: "info" | "error";
    id: MessageId;
  } | null>(null);
  const [error, setError] = useState<MessageId | null>(null);
  const dismissComposerSheet = useRef<(() => void) | null>(null);
  const [cacheView, setCacheView] = useState<MobileHostCacheView | null>(null);

  const pairedHostId = "hostId" in state ? state.hostId : undefined;

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const style = document.documentElement.style;
    const resize = () => {
      if (viewport.scale !== 1) return;
      style.setProperty("--mobile-viewport-height", `${viewport.height}px`);
      style.setProperty("--mobile-viewport-top", `${viewport.offsetTop}px`);
    };
    resize();
    viewport.addEventListener("resize", resize);
    viewport.addEventListener("scroll", resize);
    return () => {
      viewport.removeEventListener("resize", resize);
      viewport.removeEventListener("scroll", resize);
      style.removeProperty("--mobile-viewport-height");
      style.removeProperty("--mobile-viewport-top");
    };
  }, []);

  useEffect(() => {
    client.onReady = async (ready) => {
      await cacheStore.syncGrantRevision(ready.hostId, ready.grantRevision).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (state.kind === "unpaired" || state.kind === "revoked") setCacheSheetOpen(false);
  }, [state.kind]);

  useEffect(() => {
    if (!pairedHostId) {
      setCacheView(null);
      return;
    }
    let live = true;
    const refresh = () => {
      void cacheStore
        .loadView(pairedHostId)
        .then((view) => {
          if (live) setCacheView(view);
        })
        .catch(() => {});
    };
    refresh();
    const unsubscribe = cacheStore.subscribe(refresh);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [pairedHostId]);

  useEffect(() => {
    void keychain
      .deviceName()
      .then(({ name }) => setName(name))
      .catch(() => {});
    let disposed = false;
    let backgroundTimer: ReturnType<typeof setTimeout> | undefined;
    const clearBackgroundTimer = () => {
      if (backgroundTimer !== undefined) {
        clearTimeout(backgroundTimer);
        backgroundTimer = undefined;
      }
    };
    const lifecycle = observeLifecycle((active) => {
      if (disposed) return;
      if (active) {
        const cancelledGrace = backgroundTimer !== undefined;
        clearBackgroundTimer();
        // 短暂切后台（系统弹窗、下拉通知栏等）在宽限期内恢复时保持原连接不断开。
        if (!cancelledGrace && !client.active) void client.setActive(true);
      } else if (client.active && backgroundTimer === undefined) {
        backgroundTimer = setTimeout(() => {
          backgroundTimer = undefined;
          if (!disposed) void client.setActive(false);
        }, 4000);
      }
    });
    const close = () => {
      clearBackgroundTimer();
      void client.setActive(false);
    };
    window.addEventListener("pagehide", close);
    const theme = matchMedia("(prefers-color-scheme: dark)");
    const update = () =>
      applyThemeWithoutTransitions(document.documentElement, () =>
        document.documentElement.classList.toggle("dark", theme.matches),
      );
    update();
    theme.addEventListener("change", update);
    return () => {
      disposed = true;
      clearBackgroundTimer();
      window.removeEventListener("pagehide", close);
      void lifecycle.then((remove) => remove());
      theme.removeEventListener("change", update);
      void client.setActive(false);
    };
  }, []);

  useEffect(() => {
    const listener = observeBack(() => {
      if (cacheSheetOpen) setCacheSheetOpen(false);
      else if (clearConfirm) setClearConfirm(false);
      else if (settings) setSettings(false);
      else if (paste) setPaste(false);
      else if (dismissComposerSheet.current) dismissComposerSheet.current();
      else if (workspace.snapshot().page.kind !== "projects") void workspace.back();
      else void minimizeApp();
    });
    return () => {
      void listener.then((remove) => remove());
    };
  }, [cacheSheetOpen, clearConfirm, settings, paste]);

  const pair = (value: string) => {
    setError(null);
    setLink("");
    setPaste(false);
    void client.pair(value, name.trim() || t("mobile.deviceFallback"));
  };
  const scan = async () => {
    setError(null);
    try {
      const value = await scanPairingLink();
      if (value) pair(value);
    } catch {
      setError("mobile.scanFailed");
    }
  };
  const updateEndpoint = async (value: string) => {
    setEndpointNotice(null);
    try {
      await client.updateEndpoint(value);
      setEndpointLink("");
      setEndpointPaste(false);
      setEndpointNotice({ tone: "info", id: "mobile.endpoint.updated" });
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setEndpointNotice({
        tone: "error",
        id: code === "HOST_MISMATCH" ? "mobile.endpoint.mismatch" : "mobile.invalidLink",
      });
    }
  };
  const scanEndpoint = async () => {
    setEndpointNotice(null);
    try {
      const value = await scanPairingLink();
      if (value) await updateEndpoint(value);
    } catch {
      setEndpointNotice({ tone: "error", id: "mobile.scanFailed" });
    }
  };
  const clear = async () => {
    try {
      await client.clear();
      setSettings(false);
      setClearConfirm(false);
      setError(null);
    } catch {
      setError("mobile.clearFailed");
    }
  };

  const authorizedProjects = visibleAuthorizedProjects(cacheView);
  const selectedProject = authorizedProjects.find(
    (p) => p.projectId === cacheView?.meta?.selectedProjectId,
  );
  const totalCachedSessions = Object.values(cacheView?.statsByProject ?? {}).reduce(
    (sum, s) => sum + s.count,
    0,
  );
  const totalCachedBytes = Object.values(cacheView?.statsByProject ?? {}).reduce(
    (sum, s) => sum + s.bytes,
    0,
  );
  const cacheMeta = cacheView?.meta;
  const cachedProjects =
    !accessChanged &&
    cacheMeta?.hostId === pairedHostId &&
    cacheMeta?.shell &&
    (state.kind !== "connected" || cacheMeta.grantRevision === state.ready.grantRevision)
      ? authorizedProjects.flatMap((project) =>
          project.alias
            ? [{ projectId: project.alias.projectId, name: projectDisplayName(project) }]
            : [],
        )
      : undefined;
  const connectingWithCache =
    (state.kind === "loading" || state.kind === "connecting") && cachedProjects !== undefined;
  const showWorkspace = state.kind === "connected" || stale || connectingWithCache;

  function selectCachedProject(projectId: string, threadId?: string) {
    if (!pairedHostId) return;
    void cacheStore.setSelection(pairedHostId, projectId, threadId);
    const project = cacheView?.meta?.shell?.snapshot.projects.find(
      (value) => value.projectId === projectId,
    );
    if (!project?.alias?.projectId) return;
    const alias = project.alias.projectId;
    void workspace.navigate(
      threadId
        ? { kind: "session", projectId: alias, threadId }
        : { kind: "work", projectId: alias },
    );
  }

  const statusKey: MessageId =
    state.kind === "connected"
      ? state.ready.capabilities.includes("submit")
        ? "mobile.connected"
        : "mobile.observer"
      : state.kind === "loading" || state.kind === "connecting"
        ? "mobile.connecting"
        : state.kind === "offline"
          ? "mobile.offline"
          : state.kind === "revoked"
            ? "mobile.revoked"
            : state.kind === "background"
              ? "mobile.background"
              : "mobile.blocked";

  return (
    <main
      className="mobile-page [&_h1]:[line-height:1.3] [&_h1]:font-semibold [&_h2]:[line-height:1.3] [&_h2]:font-semibold [&_h3]:[line-height:1.3] [&_h3]:font-semibold [&_[data-action=new-session]]:text-fixed-control [&_[data-action=new-session]]:font-semibold [&_[data-action=new-session]]:bg-primary [&_[data-action=new-session]]:text-primary-foreground flex flex-col gap-section [padding:calc(env(safe-area-inset-top)+var(--spacing-panel))_var(--spacing-panel)_calc(env(safe-area-inset-bottom)+var(--spacing-panel))] min-h-dvh box-border bg-background text-foreground font-sans text-fixed-body"
      data-state={state.kind}
      data-workspace={showWorkspace ? "" : undefined}
      data-remembered={state.kind === "connected" ? state.remembered : undefined}
    >
      {(!showWorkspace || settings) && (
        <header className="mobile-header shrink-0 min-h-[var(--size-touch-target)] flex items-center justify-between gap-inline">
          {pairedHostId && !settings && (
            <Monitor
              className="mobile-host-icon size-[var(--spacing-section)]"
              aria-hidden="true"
            />
          )}
          <div
            className={
              pairedHostId && !settings
                ? "mobile-host-copy flex-1 min-w-0 [&_h1]:block [&_h1]:min-w-0 [&_h1]:max-w-full [&_h1]:truncate [&_h1]:text-fixed-body"
                : "mobile-host-copy flex-1 min-w-0 [&_h1]:block [&_h1]:min-w-0 [&_h1]:max-w-full [&_h1]:truncate"
            }
          >
            <h1
              className={
                pairedHostId && !settings ? "text-fixed-emphasis" : "text-fixed-page-title"
              }
            >
              {t(
                settings
                  ? "mobile.settings"
                  : state.kind === "unpaired"
                    ? "mobile.connect"
                    : state.kind === "pairing"
                      ? "mobile.waiting"
                      : pairedHostId
                        ? "mobile.computer"
                        : "mobile.projects",
              )}
            </h1>
            {pairedHostId && !settings && (
              <p className="mobile-host-status m-0 flex items-center gap-[calc(var(--spacing-inline)/2)] text-foreground-subtle text-fixed-caption">
                <span
                  className={
                    state.kind === "connected"
                      ? "bg-success mobile-status-dot inline-block size-[var(--size-status-dot)] [border-radius:var(--radius-pill)]"
                      : "bg-foreground-subtle mobile-status-dot inline-block size-[var(--size-status-dot)] [border-radius:var(--radius-pill)]"
                  }
                />
                {t(statusKey)}
                {selectedProject ? ` · ${projectDisplayName(selectedProject)}` : ""}
              </p>
            )}
          </div>
          {pairedHostId && !settings && state.kind !== "revoked" && (
            <Button
              className="mobile-touch min-h-[var(--size-touch-target)] gap-1.5 px-2.5"
              variant="outline"
              size="sm"
              data-action="projects-cache"
              onClick={() => setCacheSheetOpen(true)}
            >
              <FolderGit2 className="size-4" aria-hidden="true" />
              <span>
                {t("mobile.cache.button")}
                {authorizedProjects.length ? ` (${authorizedProjects.length})` : ""}
              </span>
            </Button>
          )}
          {state.kind !== "unpaired" && state.kind !== "pairing" && (
            <Button
              className="mobile-touch size-[var(--size-touch-target)] min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)] p-inline"
              variant="ghost"
              data-action="settings"
              aria-label={t(settings ? "mobile.back" : "mobile.settings")}
              onClick={() => setSettings(!settings)}
            >
              {settings ? t("mobile.back") : <Settings aria-hidden="true" />}
            </Button>
          )}
        </header>
      )}
      {error && <FeedbackNotice tone="error" message={t(error)} />}
      {state.kind === "unpaired" && !settings ? (
        <section className="mobile-stack flex flex-col gap-field">
          {state.cleared && <FeedbackNotice tone="info" message={t("mobile.cleared")} />}
          {state.error && (
            <FeedbackNotice tone="error" message={t(`mobile.${state.error}` as MessageId)} />
          )}
          <p>{t("mobile.instructions")}</p>
          <label className="mobile-field flex flex-col gap-inline">
            {t("mobile.deviceName")}
            <Input
              className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)] text-mobile-input-safe md:text-mobile-input-safe"
              aria-label={t("mobile.deviceName")}
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <Button
            className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)]"
            onClick={() => void scan()}
          >
            {t("mobile.scan")}
          </Button>
          <Button
            className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)]"
            variant="outline"
            data-action="paste"
            onClick={() => setPaste(!paste)}
          >
            {t("mobile.paste")}
          </Button>
          {paste && (
            <form
              className="mobile-stack flex flex-col gap-field"
              onSubmit={(event) => {
                event.preventDefault();
                pair(link);
              }}
            >
              <label className="mobile-field flex flex-col gap-inline">
                {t("mobile.link")}
                <Input
                  className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)] text-mobile-input-safe md:text-mobile-input-safe"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  data-field="pairing-link"
                  aria-label={t("mobile.link")}
                  value={link}
                  onChange={(event) => setLink(event.target.value)}
                />
              </label>
              <Button
                className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)]"
                data-action="pair"
                type="submit"
                disabled={!link.trim()}
              >
                {t("mobile.continue")}
              </Button>
            </form>
          )}
          <p className="text-foreground-subtle">{t("mobile.access")}</p>
        </section>
      ) : state.kind === "pairing" ? (
        <section className="mobile-stack flex flex-col gap-field">
          <p role="status">{t("mobile.fingerprint")}</p>
          <code
            className="mobile-fingerprint [overflow-wrap:anywhere] p-field font-mono bg-hover rounded-[var(--radius-card)]"
            data-field="fingerprint"
          >
            {state.fingerprint}
          </code>
          <p>{t("mobile.access")}</p>
          <Button
            className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)]"
            variant="outline"
            onClick={() => {
              client.disconnect();
              void client.restore();
            }}
          >
            {t("mobile.cancel")}
          </Button>
        </section>
      ) : settings ? (
        <section className="mobile-stack flex flex-col gap-field">
          <SettingsGroupCard>
            <SettingsRow label={t("mobile.deviceName")} control={name} />
            <SettingsRow label={t("mobile.notificationUnavailable")} control={null} />
            {pairedHostId && (
              <SettingsRow
                label={t("mobile.cache.storageSummary", {
                  projects: authorizedProjects.length,
                  sessions: totalCachedSessions,
                  size: formatCacheBytes(totalCachedBytes),
                })}
                control={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSettings(false);
                      setCacheSheetOpen(true);
                    }}
                  >
                    {t("mobile.cache.button")}
                  </Button>
                }
              />
            )}
          </SettingsGroupCard>
          {pairedHostId && state.kind !== "revoked" && (
            <SettingsGroupCard>
              <div className="flex flex-col gap-2 p-field">
                <strong>{t("mobile.endpoint.title")}</strong>
                <p className="text-fixed-caption text-foreground-subtle">
                  {t("mobile.endpoint.description")}
                </p>
                {endpointNotice && (
                  <FeedbackNotice tone={endpointNotice.tone} message={t(endpointNotice.id)} />
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    className="mobile-touch"
                    onClick={() => void scanEndpoint()}
                  >
                    {t("mobile.endpoint.scan")}
                  </Button>
                  <Button
                    variant="outline"
                    className="mobile-touch"
                    onClick={() => setEndpointPaste(!endpointPaste)}
                  >
                    {t("mobile.endpoint.paste")}
                  </Button>
                </div>
                {endpointPaste && (
                  <form
                    className="flex flex-col gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void updateEndpoint(endpointLink);
                    }}
                  >
                    <Input
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      aria-label={t("mobile.link")}
                      value={endpointLink}
                      onChange={(event) => setEndpointLink(event.target.value)}
                    />
                    <Button type="submit" disabled={!endpointLink.trim()}>
                      {t("mobile.endpoint.apply")}
                    </Button>
                  </form>
                )}
              </div>
            </SettingsGroupCard>
          )}
          <Button
            className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)]"
            variant="outline"
            data-action="clear"
            onClick={() => setClearConfirm(true)}
          >
            {t("mobile.clear")}
          </Button>
          {clearConfirm && (
            <FeedbackNotice
              tone="warning"
              message={t("mobile.clearConfirm")}
              actions={
                <>
                  <Button
                    className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)]"
                    variant="destructive"
                    data-action="confirm-clear"
                    onClick={() => void clear()}
                  >
                    {t("mobile.clear")}
                  </Button>
                  <Button
                    className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)]"
                    variant="ghost"
                    onClick={() => setClearConfirm(false)}
                  >
                    {t("mobile.cancel")}
                  </Button>
                </>
              }
            />
          )}
        </section>
      ) : null}
      {showWorkspace && (
        <section
          className={settings ? "hidden" : "mobile-stack flex flex-col gap-field"}
          aria-hidden={settings}
        >
          {state.kind === "connected" && !state.remembered && (
            <FeedbackNotice tone="warning" message={t("mobile.storageFailed")} />
          )}
          {stale && (state.kind === "offline" || state.kind === "connecting") && (
            <FeedbackNotice
              tone="info"
              message={t(state.kind === "offline" ? "mobile.draftOffline" : "mobile.connecting")}
              actions={
                state.kind === "offline" ? (
                  <Button size="sm" variant="ghost" onClick={() => void client.setActive(true)}>
                    {t("mobile.retry")}
                  </Button>
                ) : undefined
              }
            />
          )}
          <MobileWorkspaceView
            key={workspace.lastReady?.grantRevision ?? cacheMeta?.grantRevision}
            client={client}
            workspace={workspace}
            cachedProjects={cachedProjects}
            commands={commands}
            dismissComposerSheet={dismissComposerSheet}
            onSettings={() => setSettings(true)}
            onSelection={(projectId, threadId) => {
              if (pairedHostId && projectId)
                void cacheStore.setSelection(pairedHostId, projectId, threadId);
            }}
          />
        </section>
      )}
      {!settings && !showWorkspace && state.kind !== "unpaired" && state.kind !== "pairing" && (
        <section className="mobile-stack flex flex-col gap-field">
          {pairedHostId && state.kind !== "revoked" && !accessChanged && cacheView?.meta?.shell ? (
            <OfflineCachedWorkspace
              hostId={pairedHostId}
              cacheStore={cacheStore}
              cacheView={cacheView}
              connecting={state.kind === "loading" || state.kind === "connecting"}
              onRetry={() => void client.setActive(true)}
              onOpenProjectSheet={() => setCacheSheetOpen(true)}
              onSelectProject={selectCachedProject}
            />
          ) : (
            <>
              <p role="status" className="mobile-status inline-flex gap-inline items-center">
                {t(statusKey)}
              </p>
              {["offline", "blocked"].includes(state.kind) && (
                <Button
                  className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)]"
                  onClick={() => void client.setActive(true)}
                >
                  {t("mobile.retry")}
                </Button>
              )}
            </>
          )}
        </section>
      )}
      {pairedHostId && (
        <MobileProjectCacheSheet
          open={cacheSheetOpen}
          onClose={() => setCacheSheetOpen(false)}
          cacheView={cacheView}
          onSelectProject={(projectId) => {
            const remembered = cacheView?.meta?.selectedThreads[projectId];
            selectCachedProject(projectId, remembered);
            setSettings(false);
          }}
          onToggleProjectCache={(projectId, enabled) => {
            void cacheStore.toggleProjectCache(pairedHostId, projectId, enabled);
          }}
          onEnableAllCache={() => {
            void cacheStore.setCachedProjects(pairedHostId, null);
          }}
          onClearProjectSessions={(projectId) => {
            void cacheStore.clearProjectSessions(pairedHostId, projectId);
          }}
          onClearAllSessions={() => {
            void cacheStore.clearHostSessions(pairedHostId);
          }}
        />
      )}
    </main>
  );
}

export function mountMobileApp() {
  createRoot(document.getElementById("root")!).render(
    <ApplicationIntlProvider>
      <MobileApp />
    </ApplicationIntlProvider>,
  );
}
