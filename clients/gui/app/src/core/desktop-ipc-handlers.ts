import type {
  App,
  MessageBoxOptions,
  MessageBoxReturnValue,
  NativeTheme,
  OpenDialogOptions,
  OpenDialogReturnValue,
  SaveDialogOptions,
  SaveDialogReturnValue,
  Shell,
} from "electron";
import { realpath, stat } from "node:fs/promises";
import type { createQuitCoordinator } from "./quit-coordinator.js";
import type { createWindowController } from "./window-controller.js";

const { readCommandInvocation, desktopError } =
  require("@areal/workbench/desktop-contract") as typeof import("@areal/workbench/desktop-contract");
const validatePreview: typeof import("@areal/workbench/desktop-contract").validatePreview = (
  require("@areal/workbench/desktop-contract") as typeof import("@areal/workbench/desktop-contract")
).validatePreview;
const { modelRecord } =
  require("@areal/workbench/core-model-contract") as typeof import("@areal/workbench/core-model-contract");
const { setNativeLocale, nativeText } =
  require("@areal/workbench/node/native-i18n") as typeof import("@areal/workbench/node/native-i18n");
const { fileOpen } = require("../file-open.cjs") as typeof import("./file-open.cjs");
const { PluginArchives } =
  require("../plugin-archives.cjs") as typeof import("./plugin-archives.cjs");

export interface DesktopIpcHandlerDeps {
  app: App;
  shell: Shell;
  nativeTheme: NativeTheme;
  cfg: typeof import("./service-config.cjs");
  diagnostics: typeof import("@areal/workbench/node/diagnostics");
  handleDesktopIpc: typeof import("./desktop-ipc.cjs").handleDesktopIpc;
  onDesktopIpc: typeof import("./desktop-ipc.cjs").onDesktopIpc;
  sendDesktopEvent: typeof import("./desktop-ipc.cjs").sendDesktopEvent;
  windowController: ReturnType<typeof createWindowController>;
  quitCoordinator: ReturnType<typeof createQuitCoordinator>;
  serviceBackend: InstanceType<typeof import("./service-client.cjs").SharedCoreBackend>;
  getPreview: () => InstanceType<typeof import("./preview.cjs").CorePreview> | undefined;
  openHtml: (
    request: Parameters<
      InstanceType<typeof import("./preview.cjs").CorePreview>["openDocument"]
    >[0],
  ) => ReturnType<InstanceType<typeof import("./preview.cjs").CorePreview>["openDocument"]>;
  bugReports: InstanceType<typeof import("./bug-reports.cjs").BugReports>;
  exportDiagnostics: () => Promise<unknown>;
  showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
  showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>;
  showSaveDialog: (options: SaveDialogOptions) => Promise<SaveDialogReturnValue>;
  desktopSnapshot: () => ReturnType<
    InstanceType<typeof import("./service-client.cjs").SharedCoreBackend>["snapshot"]
  > & { menuBar: unknown };
  nativeState: () => unknown;
  getNotificationTarget: () =>
    | (import("@areal/workbench/desktop-contract").NotificationTarget & { id: number })
    | null;
  consumeNotificationTarget: (id: unknown) => void;
  themes: ReturnType<typeof import("../themes").loadThemes>;
  getTheme: () => unknown;
  setThemeId: (id: string) => void;
  requestStopService: () => Promise<unknown>;
  updater: ReturnType<typeof import("../update/electron.cjs").setupUpdater>;
  recoverInstall: () => Promise<void>;
}

/**
 * 集中注册桌面端特权 IPC 通道，保持每个通道的 sender 鉴权、参数校验和退出门禁边界清晰可见。
 */
export function registerDesktopIpcHandlers(deps: DesktopIpcHandlerDeps) {
  const {
    app,
    shell,
    nativeTheme,
    cfg,
    diagnostics,
    handleDesktopIpc,
    onDesktopIpc,
    sendDesktopEvent,
    windowController,
    quitCoordinator,
    serviceBackend,
    getPreview,
    openHtml,
    bugReports,
    exportDiagnostics,
    showMessageBox,
    showOpenDialog,
    showSaveDialog,
    desktopSnapshot,
    nativeState,
    getNotificationTarget,
    consumeNotificationTarget,
    themes,
    getTheme,
    setThemeId,
    requestStopService,
    updater,
    recoverInstall,
  } = deps;

  const { trusted, trustedSender } = windowController;
  const previewSubscriptions = new Map<string, () => void>();

  handleDesktopIpc("areal-core:preview", async (event, request) => {
    const ownerWindow = trustedSender(event);
    const ownerFrame = ownerWindow.webContents.mainFrame;
    validatePreview(request);
    const preview = getPreview();
    if (quitCoordinator.isQuitting()) {
      if (preview?.suppressedPresentation && request.operation === "show") return null;
      throw new Error(nativeText("boundary.quitting"));
    }
    if (!preview) throw new Error(nativeText("browser.previewUnavailable"));
    const activePreview = preview;
    if (
      request.operation === "newPage" ||
      request.operation === "openLink" ||
      request.operation === "subscribe"
    ) {
      await serviceBackend.ensureBrowserThread(request.projectId, request.threadId);
      // await 返回后再次校验发起 frame 与退出态，防止旧 frame 迟到结果撤销新 frame 订阅。
      const currentWindow = trustedSender(event);
      if (
        currentWindow !== ownerWindow ||
        currentWindow.isDestroyed() ||
        currentWindow.webContents.isDestroyed() ||
        currentWindow.webContents.mainFrame !== ownerFrame
      )
        throw new Error(nativeText("boundary.untrustedSender"));
      if (quitCoordinator.isQuitting()) throw new Error(nativeText("boundary.quitting"));
    }
    if (request?.operation === "subscribe") {
      const key = JSON.stringify([request.projectId, request.threadId]);
      previewSubscriptions.get(key)?.();
      const subscription = activePreview.subscribe(
        request.projectId,
        request.threadId,
        (update) => {
          if (
            !ownerWindow.isDestroyed() &&
            !ownerWindow.webContents.isDestroyed() &&
            ownerWindow.webContents.mainFrame === ownerFrame
          )
            sendDesktopEvent(ownerWindow.webContents, "areal-core:preview-event", update);
        },
      );
      previewSubscriptions.set(key, subscription.unsubscribe);
      return subscription.snapshot;
    }
    if (request?.operation === "unsubscribe") {
      const key = JSON.stringify([request.projectId, request.threadId]);
      previewSubscriptions.get(key)?.();
      previewSubscriptions.delete(key);
      return null;
    }
    if (
      windowController.isBrowserWindowClosed() &&
      ["show", "newPage", "navigate", "reload"].includes(request?.operation)
    )
      throw new Error(nativeText("browser.windowClosed"));
    if (request?.operation === "claim") {
      const identity = await activePreview.claim(
        request.projectId,
        request.threadId,
        request.pageId,
      );
      const currentClaimPage = () => {
        const page = activePreview.page(request.projectId, request.threadId, request.pageId);
        return page &&
          activePreview.pageStillOwned(page) &&
          page.view &&
          !page.view.webContents.isDestroyed() &&
          page.control === "agent" &&
          page.coreInstanceId === identity.coreInstanceId &&
          activePreview.browserHostId === identity.browserHostId &&
          activePreview.hostGeneration === identity.hostGeneration &&
          page.pageGeneration === identity.pageGeneration &&
          page.controlEpoch === identity.controlEpoch
          ? page
          : null;
      };
      try {
        await serviceBackend.browserClaim(identity);
        trusted(event);
        if (!currentClaimPage()) throw new Error(nativeText("browser.claimExpired"));
      } catch (error) {
        if (currentClaimPage())
          activePreview.takeover(request.projectId, request.threadId, request.pageId);
        throw error;
      }
      return activePreview.state(
        activePreview.page(request.projectId, request.threadId, request.pageId),
      );
    }
    if (request?.operation === "takeover") {
      return activePreview.takeover(request.projectId, request.threadId, request.pageId);
    }
    try {
      return await activePreview.command(request);
    } catch (error) {
      return { previewFailure: desktopError(error) };
    }
  });

  handleDesktopIpc("areal-core:notification-target", (event) => {
    trusted(event);
    return getNotificationTarget();
  });

  handleDesktopIpc("areal-core:notification-consumed", (event, id) => {
    trusted(event);
    consumeNotificationTarget(id);
  });

  handleDesktopIpc("areal-core:snapshot", (event) => {
    trusted(event);
    return desktopSnapshot();
  });

  handleDesktopIpc("areal-core:install-command-line-tools", async (event) => {
    trusted(event);
    if (
      serviceBackend.connectionState.state !== "unavailable" ||
      !modelRecord(serviceBackend.connectionState.prerequisite) ||
      serviceBackend.connectionState.prerequisite.kind !== "macos-command-line-tools"
    ) {
      return { started: false, message: nativeText("prerequisite.installUnavailable") };
    }
    const { requestCommandLineToolsInstallation } =
      require("../host-prerequisites.cjs") as typeof import("./host-prerequisites.cjs");
    const result = await requestCommandLineToolsInstallation();
    trusted(event);
    return result;
  });

  // 传入 thunk，确保 trusted(event) 通过后才执行 nativeState() 及其副作用。
  handleDesktopIpc("areal-core:native-state", (event) =>
    windowController.subscribeNativeState(event, nativeState),
  );

  handleDesktopIpc("areal-core:present-ready", (event) => {
    trusted(event);
    windowController.markPresentReady();
  });

  handleDesktopIpc("areal-core:theme", (event, id) => {
    trusted(event);
    if (id !== undefined) {
      if (typeof id !== "string" || (id !== "system" && !themes.some((item) => item.id === id)))
        throw new Error(nativeText("gui.unknownTheme"));
      setThemeId(id);
    }
    return getTheme();
  });

  nativeTheme.on("updated", () => {
    const window = windowController.getWindow();
    if (window && !window.isDestroyed())
      sendDesktopEvent(window.webContents, "areal-core:theme-changed", getTheme());
  });

  handleDesktopIpc("areal-core:choose-project", async (event) => {
    trusted(event);
    const result = await showOpenDialog({
      title: nativeText("picker.project"),
      properties: ["openDirectory"],
    });
    if (result.canceled) return null;
    const path = await realpath(result.filePaths[0]);
    trusted(event);
    return serviceBackend.addProject(path);
  });

  handleDesktopIpc("areal-core:choose-task-directory", async (event) => {
    trusted(event);
    const result = await showOpenDialog({
      title: nativeText("picker.taskDirectory"),
      properties: ["openDirectory"],
    });
    if (result.canceled) return null;
    const cwd = await realpath(result.filePaths[0]);
    if (!(await stat(cwd)).isDirectory()) throw new Error(nativeText("picker.existingDirectory"));
    trusted(event);
    return { cwd };
  });

  handleDesktopIpc("areal-core:choose-projectless-directory", async (event) => {
    trusted(event);
    const result = await showOpenDialog({
      title: nativeText("picker.projectlessDirectory"),
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled) return null;
    trusted(event);
    return serviceBackend.command("projectless", {
      operation: "directory",
      path: result.filePaths[0],
    });
  });

  // 登录授权页等外部链接只交给系统浏览器；只放行 https 与本机回环 http。
  handleDesktopIpc("areal-core:open-external", async (event, url) => {
    trusted(event);
    const target = new URL(String(url));
    if (
      target.protocol !== "https:" &&
      !(
        target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
      )
    )
      throw new Error(nativeText("auth.unsupportedUrl"));
    await shell.openExternal(target.href);
  });

  handleDesktopIpc("areal-core:file-open", async (event, request) => {
    trusted(event);
    return fileOpen(
      {
        backend: serviceBackend,
        shell,
        home: app.getPath("home"),
        openHtml,
        authorize: () => trusted(event),
        chooseSave: (options) => showSaveDialog(options),
      },
      request,
    );
  });

  const pluginArchives = new PluginArchives({
    backend: serviceBackend,
    choose: (options) => showOpenDialog(options),
  });

  handleDesktopIpc("areal-core:command", async (event, rawName, rawParams) => {
    trusted(event);
    const started = performance.now();
    let succeeded = true;
    try {
      if (typeof rawName !== "string") throw new Error("Invalid command name");
      const { name, request: params } = readCommandInvocation(rawName, rawParams, {
        serviceOnly: false,
      });
      if (name === "bugReport") {
        if (params.operation !== "export")
          return { ok: true, value: await bugReports.command(params) };
        const report = await bugReports.read(params.id);
        const result = await showSaveDialog({
          defaultPath: `areal-bug-${report.id}.json`,
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        trusted(event);
        if (result.canceled || !result.filePath) return { ok: true, value: { canceled: true } };
        await (require("../bug-reports.cjs") as typeof import("./bug-reports.cjs")).exportReport(
          result.filePath,
          report,
        );
        return { ok: true, value: { path: result.filePath } };
      }
      if (name === "browserData") {
        const preview = getPreview();
        if (!preview) throw new Error(nativeText("browser.previewUnavailable"));
        const value = await preview.browserData(params.operation, {
          importChrome: (options) =>
            (
              require("@areal/browser-data") as typeof import("@areal/browser-data")
            ).importChromeBrowserData({
              ...options,
              logger: console,
            }),
        });
        trusted(event);
        return { ok: true, value };
      }
      if (name === "providers" && params.operation === "revealKey") {
        const value = await (
          require("../../ipc/generated/provider-key.cjs") as typeof import("../ipc/provider-key.js")
        ).revealProviderKey(
          {
            home: cfg.serviceOptions(app).hostHome,
            binary: cfg.serviceOptions(app).binary,
            profile: app.getPath("userData"),
            trusted: () => trusted(event),
          },
          params,
        );
        return { ok: true, value };
      }
      // 非原生资料库写入只允许 Host 的带回执入口，不能从 IPC 绕过准入。
      if (name === "library")
        throw Object.assign(new Error("资料库操作请通过 Host 提交"), {
          code: "CAPABILITY_UNAVAILABLE",
          outcome: { kind: "noMutation" },
        });
      if (name === "exportDiagnostics") return { ok: true, value: await exportDiagnostics() };
      if (
        name === "manage" &&
        ["pluginArchivePick", "pluginArchiveImport"].includes(params.operation)
      )
        return {
          ok: true,
          value: await pluginArchives.command(params, () => trusted(event)),
        };
      if (name === "serviceLifecycle") {
        if (params.operation === "quitInterface")
          return { ok: true, value: await quitCoordinator.requestQuit() };
        if (params.operation === "stopAndQuit")
          return { ok: true, value: await quitCoordinator.requestStopAndQuit() };
        const value =
          params.operation === "update"
            ? await serviceBackend.applyUpdate({
                notify: (options) => showMessageBox(options),
              })
            : params.operation === "stop"
              ? await requestStopService()
              : params.operation === "recover"
                ? await serviceBackend.recoverBackend()
                : await serviceBackend.checkLifecycle();
        return { ok: true, value };
      }
      if (name === "serviceStatus")
        return { ok: true, value: await serviceBackend.serviceStatus() };
      if (name === "hostUpdate")
        return { ok: true, value: await serviceBackend.hostUpdate(params) };
      if (name === "hostInstallation") {
        return {
          ok: true,
          value: await serviceBackend.hostInstallation(params.operation, requestStopService),
        };
      }
      if (name === "stopService") return { ok: true, value: await requestStopService() };
      if (name === "recoverResources") {
        return {
          ok: true,
          value: await serviceBackend.recoverBackend(),
        };
      }
      if (name === "connectService") {
        await serviceBackend.init();
        return { ok: true, value: null };
      }
      trusted(event);
      const value = await serviceBackend.command(name, params);
      return { ok: true, value };
    } catch (error) {
      succeeded = false;
      return { ok: false, error: desktopError(error) };
    } finally {
      diagnostics.record({
        type: "command-complete",
        command: rawName,
        outcome: succeeded ? "ok" : "failed",
        durationMs: Math.round(performance.now() - started),
      });
    }
  });

  handleDesktopIpc("areal-core:update-state", (event) => {
    trusted(event);
    return updater.state();
  });

  handleDesktopIpc("areal-core:update-download", (event) => {
    trusted(event);
    void updater.download();
    return updater.state();
  });

  handleDesktopIpc("areal-core:update-recover-resources", async (event) => {
    trusted(event);
    await recoverInstall();
    return updater.state();
  });

  onDesktopIpc("areal-core:interface-locale", (event, locale) => {
    try {
      trustedSender(event);
    } catch {
      return;
    }
    setNativeLocale(locale);
  });

  onDesktopIpc("areal-core:window-close-decision", (event, decision) => {
    windowController.decideWindowClose(event, decision);
  });

  onDesktopIpc("areal-core:quit-decision", (event, decision) => {
    quitCoordinator.handleQuitDecision(event, decision);
  });
}
