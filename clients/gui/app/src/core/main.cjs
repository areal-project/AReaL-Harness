// @ts-check
"use strict";
const { startupTrace } = require("@areal/workbench/node/startup-timing");
const startupTraceMain = startupTrace("gui.startup");
startupTraceMain.advance("imports");

const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  nativeTheme,
  nativeImage,
  WebContentsView,
  shell,
  Notification,
  crashReporter,
  session,
} = require("electron");
const { join, resolve } = require("node:path");
const {
  handleDesktopIpc,
  onDesktopIpc,
  sendDesktopEvent,
  registerUiProtocol,
  desktopDialogs,
  registerDesktopShell,
} = require("./desktop-ipc.cjs");
const { createOwner } = require("@areal/workbench/node/application-owner");
const { setupUpdater } = require("../update/electron.cjs");
const {
  showCoreNotification,
  readNotificationTarget,
  nativeNotificationDelivery,
} = require("@areal/workbench/node/native-notifications");
const { MenuBar } = require("./menu-bar.cjs");
const { fileWorkspace } = require("./file-open.cjs");
const { normalizeNativeImage, exportDiagnostics: saveDiagnostics } = require("./bug-reports.cjs");
const { CorePreview, developmentApproval } = require("./preview.cjs");
const diagnostics = require("@areal/workbench/node/diagnostics");
const { startSnapShots } = require("./snapshots/host.cjs");
const cfg = require("./service-config.cjs");
const { readLibraryStartupSettings } = require("@areal/workbench/node/library-startup");
const { applyDesktopSessionNetworkPolicy } = require("@areal/workbench/node/desktop-network");
const { SharedCoreBackend } = require("./service-client.cjs");
const { nativeText } = require("@areal/workbench/node/native-i18n");
const { confirmHostQuit, confirmHostStop, hostActivityLabel } = require("./host-quit.cjs");
const { loadThemes, desktopTheme } = require("../themes");
/** @type {typeof import("./bundle-guard.js")} */
const { createBundleGuard } = require("./generated/bundle-guard.cjs");
/** @type {typeof import("./window-controller.js")} */
const { createWindowController } = require("./generated/window-controller.cjs");
/** @type {typeof import("./quit-coordinator.js")} */
const { createQuitCoordinator } = require("./generated/quit-coordinator.cjs");
/** @type {typeof import("./desktop-ipc-handlers.js")} */
const { registerDesktopIpcHandlers } = require("./generated/desktop-ipc-handlers.cjs");

startDesktop();

function startDesktop() {
  startupTraceMain.advance("app_ready");
  app.setName("AReaL Harness GUI");
  cfg.configureUserData(app);
  const applicationOwner = createOwner(app.getPath("userData"));
  app.setPath("userData", applicationOwner.profile);
  /** @type {ReturnType<typeof readLibraryStartupSettings>|undefined} */
  let startupSettings;
  /** @type {unknown} */
  let settingsError;
  try {
    startupSettings = readLibraryStartupSettings(cfg.serviceHome(app));
    if (startupSettings.hardwareAcceleration === false) app.disableHardwareAcceleration();
  } catch (error) {
    settingsError = error;
    console.error("Desktop startup settings could not be read", error);
  }
  // Acquire before loading resources or registering shutdown hooks. The userData
  // directory scopes the lock, so explicitly isolated development/test homes coexist.
  if (!app.requestSingleInstanceLock()) {
    console.info("AReaL Harness 界面已在运行，已请求显示已有窗口。");
    startupTraceMain.finish("skipped");
    app.exit(0);
    return;
  }
  if (process.argv.some((value) => value.startsWith("--areal-host-import-source="))) {
    const options = cfg.serviceOptions(app);
    void require("@areal/client/gui-source")
      .prepareGuiSource({
        app,
        guiUserData: applicationOwner.profile,
        coreHome: options.home,
        legacyServiceHome: options.harnessHome,
        encryption: require("electron").safeStorage,
      })
      .then(
        (result) => app.exit(result?.kind === "ready" ? 0 : 2),
        (error) => {
          console.error(error);
          app.exit(1);
        },
      );
    return;
  }
  const diagnosticsRoots = {
    mainRoot: join(applicationOwner.profile, "diagnostics", "main"),
    desktopRoot: join(cfg.serviceHome(app), "diagnostics", "desktop"),
  };
  diagnostics.start({
    role: "main",
    root: diagnosticsRoots.mainRoot,
    appRunId: applicationOwner.appRunId,
    version: app.getVersion(),
    packaged: app.isPackaged,
  });
  diagnostics.startCrashReporter({ app, crashReporter });
  registerDesktopShell(app, diagnostics);

  const guiRoot = app.isPackaged
    ? join(process.resourcesPath, "areal-gui")
    : resolve(__dirname, "../../../renderer/dist");

  const bundleGuard = createBundleGuard({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });

  /** @type {import("./snapshots/DesktopSnapShots.js").DesktopSnapShots|undefined} */
  let snapShots;
  /** @type {InstanceType<typeof SharedCoreBackend>|undefined} */
  let backend;
  /** @type {InstanceType<typeof CorePreview>|undefined} */
  let preview;
  /** @type {Awaited<ReturnType<typeof setupUpdater>>|undefined} */
  let updates;
  let themeId = "system";

  /** @type {ReturnType<typeof createQuitCoordinator>} */
  let quitCoordinator;
  /** @type {ReturnType<typeof createWindowController>} */
  let windowController;

  const checkStaleBundle = () =>
    bundleGuard.triggerRelaunchIfReplaced({
      isBusy: () => quitCoordinator.isBusy(),
      requestRelaunchQuit: (execPath) => quitCoordinator.requestRelaunchQuit(execPath),
    });

  windowController = createWindowController({
    BrowserWindow,
    diagnostics,
    sendDesktopEvent,
    preloadPath: join(__dirname, "preload.cjs"),
    isQuitting: () => quitCoordinator.isQuitting(),
    isExitReady: () => quitCoordinator.isExitReady(),
    hasActiveQuitPhase: () => quitCoordinator.hasActiveQuitPhase(),
    shouldPreventUnload: (contents) => quitCoordinator.shouldPreventUnload(contents),
    onBeforeReveal: checkStaleBundle,
    onDidFailLoad: checkStaleBundle,
    onWindowBlur: () => snapShots?.setSnapShotShortcutSuppressed(false),
    onRendererReset: () => snapShots?.setSnapShotShortcutSuppressed(false),
    onDisposePreview: async () => {
      await preview?.dispose();
    },
    onReportLifecycleError: (error) => backend?.reportLifecycleError(error),
  });

  const { showMessageBox, showOpenDialog, showSaveDialog } = desktopDialogs(() =>
    windowController.getWindow(),
  );

  quitCoordinator = createQuitCoordinator({
    app,
    dialog,
    diagnostics,
    showMessageBox,
    confirmHostQuit,
    confirmHostStop,
    sendDesktopEvent,
    getWindow: () => windowController.getWindow(),
    isRendererAlive: () => windowController.isRendererAlive(),
    isRendererResponsive: () => windowController.isRendererResponsive(),
    hasPreloadFailed: () => windowController.hasPreloadFailed(),
    isPreloadActive: () => windowController.isPreloadActive(),
    revealWindow: (opts) => windowController.revealWindow(opts),
    announceWindowOpened: () => windowController.announceWindowOpened(),
    settleWindow: (owner) => windowController.settleWindow(owner),
    getBackend: () => backend,
    getPreview: () => preview,
  });

  const bugReports = new (require("./bug-reports.cjs").BugReports)({
    endpoint: process.env.AREAL_BUG_REPORT_URL,
    root: join(applicationOwner.profile, "bug-reports"),
    collect: () => diagnostics.collect({ ...diagnosticsRoots, coreRoot: cfg.serviceHome(app) }),
    normalizeImage: (data) => normalizeNativeImage(data, nativeImage),
  });
  const exportDiagnostics = () => saveDiagnostics(app, diagnosticsRoots, showSaveDialog);
  const stopAndQuitFromMenu = () => {
    void quitCoordinator.requestStopAndQuit().catch((error) => {
      backend?.reportLifecycleError(error);
      windowController.revealWindow();
    });
  };
  const menuBar = new MenuBar(() => {
    if (windowController.isStartupPresented()) windowController.revealWindow();
  }, stopAndQuitFromMenu);
  app.on("will-quit", () => menuBar?.close());

  /** @type {(import("@areal/workbench/desktop-contract").NotificationTarget & {id:number})|null} */
  let notificationTarget = null;
  let notificationSequence = 0;
  const acceptNotice = nativeNotificationDelivery();
  /** @param {unknown} target */
  function openNotificationTarget(target) {
    const parsed = readNotificationTarget(target);
    if (!parsed) return;
    notificationTarget = { ...parsed, id: ++notificationSequence };
    const window = windowController.getWindow();
    if (!window || window.isDestroyed()) return;
    if (windowController.isStartupPresented()) windowController.revealWindow();
    sendDesktopEvent(window.webContents, "areal-core:notification-open");
  }
  const themes = loadThemes();
  app.on("second-instance", () => windowController.revealWindow());

  function theme() {
    return desktopTheme(themes, themeId, nativeTheme.shouldUseDarkColors);
  }

  let publishPending = false;
  let hostActivityPending = false;
  let hostActivityRefreshedAt = 0;
  function refreshHostMenu() {
    const item = Menu.getApplicationMenu()?.getMenuItemById("shared-host-activity");
    if (
      !backend ||
      !item ||
      quitCoordinator.isQuitting() ||
      hostActivityPending ||
      Date.now() - hostActivityRefreshedAt < 5000
    )
      return;
    hostActivityPending = true;
    void backend
      .readHostActivity()
      .catch(() => null)
      .then((activity) => {
        item.label = hostActivityLabel(activity);
      })
      .finally(() => {
        hostActivityPending = false;
        hostActivityRefreshedAt = Date.now();
      });
  }

  let diagnosticTopology = "";
  function desktopSnapshot() {
    if (!backend) throw new Error(nativeText("lifecycle.preparing"));
    const state = backend.snapshot();
    const topology = {
      type: /** @type {const} */ ("service-topology"),
      state: state.connection?.state,
      projects: state.projects.length,
      connectedProjects: state.projects.filter((project) => project.state?.connected === true)
        .length,
    };
    const topologyKey = JSON.stringify(topology);
    if (diagnosticTopology !== topologyKey) {
      diagnosticTopology = topologyKey;
      diagnostics.record(topology);
    }
    // Wait for the authoritative saved Library before applying the default.
    // A temporary disconnect must not reset the native preference.
    if (state.connection?.state === "ready" && state.library && !quitCoordinator.isQuitting()) {
      menuBar?.sync(state.library.settings?.showInMenuBar !== false);
      void updates?.setChannel(state.library.settings?.betaUpdates === true);
      void snapShots
        ?.configure(state.library.settings?.snapShot)
        .catch((error) => console.error("SnapShots settings failed", error));
    }
    return { ...state, menuBar: menuBar?.snapshot() ?? null };
  }

  function nativeState() {
    const snapshot = desktopSnapshot();
    const settings = snapshot.library.settings;
    return {
      projects: [],
      verifiedDesktopHost: snapshot.verifiedDesktopHost,
      connection: snapshot.connection,
      desktopCapabilities: snapshot.desktopCapabilities,
      serviceSummary: snapshot.serviceSummary,
      backendUpdate: snapshot.backendUpdate,
      lifecycle: snapshot.lifecycle,
      menuBar: snapshot.menuBar,
      projectless: snapshot.projectless,
      power: snapshot.power,
      subscription: snapshot.subscription,
      library: {
        settings: {
          httpProxy: settings.httpProxy,
          httpProxyNoProxy: settings.httpProxyNoProxy,
          httpProxyCaCertPath: settings.httpProxyCaCertPath,
        },
      },
    };
  }

  function publish() {
    refreshHostMenu();
    preview?.releaseInvalidOwners();
    if (publishPending) return;
    publishPending = true;
    setImmediate(() => {
      publishPending = false;
      if (!backend) return;
      windowController.publishNativeState(nativeState);
    });
  }

  app
    .whenReady()
    .then(() =>
      diagnostics.withOperation(
        "startup",
        {},
        async () => {
          startupTraceMain.advance("upgrade");
          if (await cfg.upgrade(app, dialog, cfg.serviceOptions, settingsError)) return;
          startupTraceMain.advance("snapshots");
          snapShots = startSnapShots({
            window: () => windowController.getWindow() ?? null,
            revealWindow: () => windowController.revealWindow(),
            trusted: windowController.trusted,
          });
          startupTraceMain.advance("network_policy");
          await Promise.all(
            [session.defaultSession, session.fromPartition("persist:areal-embedded-browser")].map(
              (target) => applyDesktopSessionNetworkPolicy(target, startupSettings),
            ),
          );
          startupTraceMain.advance("protocol_setup");
          require("../ipc/generated/host-ticket.cjs").registerHostTicket({
            home: cfg.serviceOptions(app).hostHome,
            profile: app.getPath("userData"),
            trusted: windowController.trusted,
          });
          if (process.platform === "darwin")
            app.dock?.setIcon(join(__dirname, "../../assets/icon-1024.png"));
          registerUiProtocol(guiRoot);
          startupTraceMain.finish("ok");

          const serviceBackend = new SharedCoreBackend({
            app,
            ...cfg.serviceOptions(app),
            applicationOwner,
            onChange: publish,
            onNotification: (notice) => {
              const window = windowController.getWindow();
              if (!backend || !window || window.isDestroyed() || quitCoordinator.isQuitting())
                return;
              const delivery = acceptNotice(
                notice,
                backend.snapshot().library?.settings ?? {},
                window.isFocused(),
              );
              if (delivery)
                showCoreNotification(Notification, window, delivery, openNotificationTarget);
            },
          });
          backend = serviceBackend;
          let connectedOnce = false;
          const connectBackend = async () => {
            // 重新打开应用是显式连接；成功连接过的窗口才按自动重连保留停止意图。
            await serviceBackend.init({ automatic: connectedOnce });
            if (serviceBackend.status.connected) connectedOnce = true;
          };

          /** @type {typeof import("./native-browser-tools")} */
          const { NativeBrowserTools } = require("./generated/native-browser-tools.cjs");
          const nativeBrowserTools = new NativeBrowserTools({
            preview: () => {
              const window = windowController.getWindow();
              if (quitCoordinator.isQuitting() || !preview || !window || window.isDestroyed())
                throw new Error("Browser host unavailable");
              return preview;
            },
            current: (frame) => {
              const window = windowController.getWindow();
              return (
                !quitCoordinator.isQuitting() &&
                !!window &&
                !window.isDestroyed() &&
                serviceBackend.nativeBrowserCurrent(frame)
              );
            },
            call: (method, params) => serviceBackend.nativeBrowserCall(method, params),
            reveal: (projectId, threadId, pageId) => {
              const window = windowController.getWindow();
              if (window && !window.isDestroyed())
                sendDesktopEvent(window.webContents, "areal-core:preview-event", {
                  kind: "reveal",
                  projectId,
                  threadId,
                  pageId,
                });
            },
          });
          serviceBackend.onNativeBrowserRequest = (frame, signal) =>
            nativeBrowserTools.callback(frame, signal);
          serviceBackend.onNativeBrowserRevoked = (projectId, threadId) =>
            preview?.revokeThread(projectId, threadId);
          serviceBackend.onBrowserDisconnected = () => {
            preview?.revokeAll();
          };

          /** @param {Parameters<InstanceType<typeof CorePreview>["openDocument"]>[0]} request */
          const openHtml = async (request) => {
            const window = windowController.getWindow();
            if (!preview || !window || window.isDestroyed())
              throw new Error("Browser host unavailable");
            const result = await preview.openDocument(request);
            if (result.dispatch === "confirmed" && !window.isDestroyed())
              sendDesktopEvent(window.webContents, "areal-core:preview-event", {
                kind: "reveal",
                projectId: request.projectId,
                threadId: request.threadId,
                pageId: result.pageId,
              });
            return result;
          };

          let recoveryPending = 0;
          const hasUpdateWork = async () => {
            const lifecycle = serviceBackend.snapshot().lifecycle;
            const unsettled =
              (lifecycle && "phase" in lifecycle && lifecycle.phase === "admissionUnconfirmed") ||
              lifecycle?.operations?.some(
                (operation) => !["completed", "blocked"].includes(operation.phase),
              );
            return recoveryPending > 0 || unsettled || (await serviceBackend.hasUpdateWork());
          };
          const recoverInstall = async () => {
            recoveryPending++;
            try {
              await confirmHostStop(serviceBackend, (options) => showMessageBox(options));
            } finally {
              recoveryPending--;
              if (recoveryPending === 0 && updates?.state().status === "deferred")
                void updates.install();
            }
          };
          const updater = (updates = setupUpdater({
            recoverInstall,
            hasWork: hasUpdateWork,
            onState: (state) => {
              const window = windowController.getWindow();
              if (window && !window.isDestroyed())
                sendDesktopEvent(window.webContents, "areal-core:update-changed", state);
            },
            prepareInstall: async () => {
              if (quitCoordinator.isQuitting() || (await hasUpdateWork()))
                throw Object.assign(new Error(nativeText("lifecycle.activeWork")), {
                  code: "LIFECYCLE_BLOCKED",
                });
              const result = await quitCoordinator.requestQuit("install");
              if (!("stopped" in result) || result.stopped !== true)
                throw Object.assign(new Error(nativeText("lifecycle.installCanceled")), {
                  code: "LIFECYCLE_BLOCKED",
                });
            },
          }));

          const requestStopService = () => confirmHostStop(serviceBackend, showMessageBox);

          registerDesktopIpcHandlers({
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
            getPreview: () => preview,
            openHtml,
            bugReports,
            exportDiagnostics,
            showMessageBox,
            showOpenDialog,
            showSaveDialog,
            desktopSnapshot,
            nativeState,
            getNotificationTarget: () => notificationTarget,
            consumeNotificationTarget: (id) => {
              if (notificationTarget?.id === id) notificationTarget = null;
            },
            themes,
            getTheme: theme,
            setThemeId: (id) => {
              themeId = id;
            },
            requestStopService,
            updater,
            recoverInstall,
          });

          Menu.setApplicationMenu(
            Menu.buildFromTemplate([
              {
                label: "AReaL Harness",
                submenu: [
                  { role: "about" },
                  {
                    label: "检查更新…",
                    click: () => void updater.check(true),
                  },
                  {
                    label: "导出诊断包…",
                    click: async () => {
                      try {
                        await exportDiagnostics();
                      } catch {
                        dialog.showErrorBox(
                          nativeText("diagnostics.saveFailedTitle"),
                          nativeText("diagnostics.retryLocation"),
                        );
                      }
                    },
                  },
                  {
                    label: "检查后台资源…",
                    click: () => {
                      void serviceBackend
                        .checkLifecycle()
                        .catch((error) => serviceBackend.reportLifecycleError(error));
                    },
                  },
                  {
                    id: "shared-host-activity",
                    label: nativeText("host.unknown"),
                    enabled: false,
                  },
                  {
                    label: nativeText("host.stopMenu"),
                    click: async () => {
                      try {
                        await confirmHostStop(serviceBackend, showMessageBox);
                        hostActivityRefreshedAt = 0;
                        refreshHostMenu();
                      } catch (error) {
                        serviceBackend.reportLifecycleError(error);
                      }
                    },
                  },
                  { type: "separator" },
                  {
                    label: "退出 AReaL Harness",
                    accelerator: "CmdOrCtrl+Q",
                    click: () => app.quit(),
                  },
                ],
              },
              { role: "editMenu" },
              { role: "viewMenu" },
              { role: "windowMenu" },
            ]),
          );

          // 先启动后台初始化（与窗口创建并行），避免等待 createWindow 同步阶段之后才触发依赖与指纹检查。
          /** @type {Promise<Electron.BrowserWindow> | undefined} */
          let windowLoaded;
          const serviceStarted = (async () => {
            const trace = startupTrace("gui.backend_init");
            trace.advance("initialize");
            try {
              await connectBackend();
              await windowLoaded;
              trace.advance("initial_project");
              if (serviceBackend.status.connected && process.env.AREAL_CORE_WORKSPACE)
                await serviceBackend.addProject(process.env.AREAL_CORE_WORKSPACE);
              trace.finish(serviceBackend.status.connected ? "ok" : "skipped");
            } catch (error) {
              trace.finish("error", error);
            } /* 错误由后台连接快照展示，用户显式重试。 */
            publish();
          })();

          windowLoaded = windowController.createWindow((createdWindow) => {
            preview = new CorePreview(
              createdWindow,
              WebContentsView,
              (projectId, threadId) => serviceBackend.ownsThread(projectId, threadId),
              () => serviceBackend.snapshot().library?.settings ?? {},
              (projectId, threadId) => serviceBackend.browserCoreIdentity(projectId, threadId),
              () => serviceBackend.status.browserControlEndpoints ?? [],
              developmentApproval(
                createdWindow,
                () =>
                  !quitCoordinator.isQuitting() &&
                  serviceBackend.status.connected === true &&
                  serviceBackend.nativeBrowser?.closed === false,
                () => preview,
              ),
              undefined,
              (projectId, threadId) =>
                fileWorkspace(serviceBackend, { projectId, threadId, operation: "openDocument" }),
            );
          });
          let createdWindow;
          try {
            createdWindow = await windowLoaded;
          } catch (error) {
            // 首次加载失败时先消费 bundleGuard 与 quitCoordinator 结果，避免在重拉清理完成前 app.exit(1)。
            const recovery = await bundleGuard.recoverStartupLoadFailure({
              isBusy: () => quitCoordinator.isBusy(),
              isExitReady: () => quitCoordinator.isExitReady(),
              getPendingQuit: () => quitCoordinator.getQuitAttempt()?.promise ?? null,
              requestRelaunchQuit: (execPath) => quitCoordinator.requestRelaunchQuit(execPath),
            });
            if (recovery === "handled") return false;
            if (recovery === "retry") {
              const existing = windowController.getWindow();
              if (existing && !existing.isDestroyed()) {
                await existing.loadURL("areal-ui://app/");
                createdWindow = existing;
              } else {
                throw error;
              }
            } else {
              throw error;
            }
          }
          const menuTimer = setInterval(refreshHostMenu, 5000);
          createdWindow
            .on("focus", refreshHostMenu)
            .on("blur", refreshHostMenu)
            .on("hide", refreshHostMenu)
            .on("minimize", refreshHostMenu)
            .on("restore", refreshHostMenu);
          app.on("will-quit", () => clearInterval(menuTimer));
          refreshHostMenu();
          await serviceStarted;
          refreshHostMenu();
          return !createdWindow.isDestroyed() && serviceBackend.status.connected;
        },
        (ready) => (ready ? "ok" : "unknown"),
      ),
    )
    .catch((error) => {
      startupTraceMain.finish("error", error);
      if (quitCoordinator.isExitReady()) return;
      if (error.code !== "STARTUP_CANCELLED") {
        console.error(error);
        dialog.showErrorBox(nativeText("gui.startupFailed"), error.message);
      }
      diagnostics.record({
        type: "exit-requested",
        exitCode: error.code === "STARTUP_CANCELLED" ? 0 : 1,
      });
      app.exit(error.code === "STARTUP_CANCELLED" ? 0 : 1);
    });

  app.on("activate", () => windowController.revealWindow());
  app.on("window-all-closed", () => {});
  app.on("before-quit", (event) => quitCoordinator.handleBeforeQuit(event));
}
