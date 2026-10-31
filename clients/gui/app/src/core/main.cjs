// @ts-check
"use strict";
const { startupTrace } = require("./startup-timing.cjs");
const startupTraceMain = startupTrace("gui.startup");
startupTraceMain.advance("imports");

const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  protocol,
  nativeTheme,
  WebContentsView,
  shell,
  powerMonitor,
  Notification,
  crashReporter,
  session,
} = require("electron");
const { handleDesktopIpc, onDesktopIpc, sendDesktopEvent } = require("./desktop-ipc.cjs");
const { readFile, realpath, stat, writeFile } = require("node:fs/promises");
const { join, resolve, extname, sep } = require("node:path");
const { randomUUID } = require("node:crypto");
const { ProjectionEncoder } = require("@areal/workbench/state-projection");
const { createOwner } = require("./application-owner.cjs");
const { setupUpdater } = require("../update/electron.cjs");
const { showCoreNotification } = require("./notifications.cjs");
const { MenuBar } = require("./menu-bar.cjs");
const { fileOpen } = require("./file-open.cjs");
const { PluginArchives } = require("./plugin-archives.cjs");
const { McpFormResources } = require("./mcp-form-resources.cjs");
const { McpAppsHost, parseDeepLink } = require("./mcp-apps.cjs");
const { McpMetadataImages } = require("./mcp-apps-images.cjs");
const { readCommandInvocation, desktopError } = require("@areal/workbench/desktop-contract");
/** @type {typeof import("@areal/workbench/desktop-contract").validatePreview} */
const validatePreview = require("@areal/workbench/desktop-contract").validatePreview;
const { modelRecord } = require("@areal/workbench/core-model-contract");
const { readBrowserHostRequest, browserHostFailure } = require("./browser-host-request.cjs");
const { CorePreview } = require("./preview.cjs");
const { ComputerControl } = require("./computer-control.cjs");
const { ExternalCua, upstream: cuaUpstream } = require("./external-cua.cjs");
const diagnostics = require("./diagnostics.cjs");
const { configureUserData, serviceOptions, serviceHome } = require("./service-config.cjs");
const { readLibraryStartupSettings } = require("./library.cjs");
const { applyDesktopSessionNetworkPolicy } = require("./desktop-network.cjs");
const { SharedCoreBackend } = require("./service-client.cjs");
const { recoverConnectedService } = require("./startup-recovery.cjs");
const { setNativeLocale, nativeText } = require("./native-i18n.cjs");
const { loadThemes, engineCss, panelCss } = require("../themes");

startDesktop();

function startDesktop() {
  startupTraceMain.advance("app_ready");
  app.setName("AReaL Harness GUI");
  configureUserData(app);
  const applicationOwner = createOwner(app.getPath("userData"));
  app.setPath("userData", applicationOwner.profile);
  /** @type {ReturnType<typeof readLibraryStartupSettings>|undefined} */
  let startupSettings;
  /** @type {unknown} */
  let startupSettingsError;
  try {
    startupSettings = readLibraryStartupSettings(serviceHome(app));
    if (startupSettings.hardwareAcceleration === false) app.disableHardwareAcceleration();
  } catch (error) {
    startupSettingsError = error;
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
  const diagnosticsRoots = {
    mainRoot: join(applicationOwner.profile, "diagnostics", "main"),
    desktopRoot: join(serviceHome(app), "diagnostics", "desktop"),
  };
  diagnostics.start({
    role: "main",
    root: diagnosticsRoots.mainRoot,
    appRunId: applicationOwner.appRunId,
    version: app.getVersion(),
  });
  diagnostics.startCrashReporter({ app, crashReporter });
  app.on("child-process-gone", (_event, details) =>
    diagnostics.record({
      type: "child-process-gone",
      processType: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
    }),
  );
  app.on("render-process-gone", (_event, _contents, details) =>
    diagnostics.record({
      type: "renderer-gone",
      reason: details.reason,
      exitCode: details.exitCode,
    }),
  );
  app.on("will-quit", () => diagnostics.record({ type: "exit-requested", exitCode: 0 }));
  protocol.registerSchemesAsPrivileged([
    { scheme: "areal-mcp", privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: "areal-ui", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);

  const guiRoot = app.isPackaged
    ? join(process.resourcesPath, "areal-gui")
    : resolve(__dirname, "../../../renderer/dist");
  /** @type {Record<string,string>} */
  const mime = {
    ".wasm": "application/wasm",
    ".js": "text/javascript",
    ".css": "text/css",
    ".html": "text/html",
    ".json": "application/json",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".svg": "image/svg+xml",
    ".png": "image/png",
  };
  /** @type {InstanceType<typeof ComputerControl>|undefined} */
  let computer;
  /** @type {InstanceType<typeof ExternalCua>|undefined} */
  let externalCua;
  /** @type {unknown} */
  let computerActivity = null;
  let computerWasEnabled = false,
    computerAdmissionSuspended = false,
    computerUiAvailable = false,
    computerSystemPaused = false;
  /** @type {Map<number,AbortController>} */
  const computerRequests = new Map();
  const computerSelection = () => {
    const settings = backend?.snapshot().library?.settings ?? {};
    return {
      enabled: settings.computerControlEnabled === true,
      provider:
        typeof settings.computerControlProvider === "string"
          ? settings.computerControlProvider
          : "native",
      executable:
        typeof settings.computerControlExecutable === "string"
          ? settings.computerControlExecutable
          : "",
    };
  };
  const computerAvailable = () =>
    backend?.computerHostOwned === true &&
    !quitting &&
    !browserWindowClosed &&
    computerUiAvailable &&
    !computerSystemPaused &&
    !computerAdmissionSuspended;
  /** @param {string} reason */
  const stopComputer = (reason) => Promise.all([computer?.stop(reason), externalCua?.stop(reason)]);
  const closeComputer = () => Promise.all([computer?.close(), externalCua?.close()]);
  /** @type {Electron.BrowserWindow|undefined} */
  let window;
  /** @type {InstanceType<typeof SharedCoreBackend>|undefined} */
  let backend;
  /** @type {InstanceType<typeof CorePreview>|undefined} */
  let preview;
  /** @type {InstanceType<typeof McpAppsHost>|undefined} */
  let mcpApps;
  /** @type {Awaited<ReturnType<typeof setupUpdater>>|undefined} */
  let updates;
  let quitting = false,
    exitReady = false,
    themeId = "system";
  let browserWindowClosed = false;
  /** @type {Promise<void>|null} */
  let windowClosePromise = null;
  /** @type {Map<string,()=>void>} */
  const previewSubscriptions = new Map();
  /** @type {WeakMap<Electron.WebContents,{frame:Electron.WebFrameMain,encoder:InstanceType<typeof ProjectionEncoder>}>} */
  const projections = new WeakMap();
  let startupPresentation = "requested",
    startupPainted = false,
    startupReady = false;
  /** @typedef {import('./service-client.cjs').LifecycleResult|{kind?:string,canceled:boolean}|{stopped:true,quitting:true}} QuitResult */
  /** @typedef {{id:number,intent:string,owner:Electron.WebContents|null,frame:Electron.WebFrameMain|null,decide:((allowed:boolean)=>void)|null,approved:boolean,phase:'checking'|'stopping'|'finishing'|null,startedAt:number,promise:Promise<QuitResult>|null}} QuitAttempt */
  let focusRequested = false,
    quitRequestSequence = 0;
  /** @type {QuitAttempt|null} */
  let quitAttempt = null;
  /** @type {ReturnType<typeof startupTrace>|undefined} */
  let startupShowTrace;
  /** @type {ReturnType<typeof startupTrace>|undefined} */
  let startupPaintTrace;
  /** @type {ReturnType<typeof startupTrace>|undefined} */
  let startupPresentTrace;
  function presentStartup() {
    if (
      startupPresentation !== "requested" ||
      quitting ||
      windowClosePromise ||
      !window ||
      window.isDestroyed() ||
      !startupPainted ||
      !startupReady
    )
      return;
    startupPresentation = "presented";
    browserWindowClosed = false;
    if (backend) backend.guiWindowClosed = false;
    window.show();
    if (focusRequested) {
      focusRequested = false;
      window.focus();
    }
  }
  function revealWindow() {
    if (quitting || exitReady) return;
    if (windowClosePromise) {
      const owner = window;
      void windowClosePromise.then(() => {
        if (window === owner && owner && !owner.isDestroyed()) revealWindow();
      });
      return;
    }
    if (!window || window.isDestroyed()) {
      focusRequested = true;
      return;
    }
    if (startupPresentation !== "presented") {
      startupPresentation = "requested";
      focusRequested = true;
      presentStartup();
      return;
    }
    browserWindowClosed = false;
    if (backend) backend.guiWindowClosed = false;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
  /** @param {QuitAttempt} attempt @returns {Promise<boolean>} */
  function confirmRendererQuit(attempt) {
    if (!window || window.isDestroyed()) return Promise.resolve(false);
    const owner = window.webContents,
      frame = owner.mainFrame;
    if (owner.isDestroyed() || !frame.url.startsWith("areal-ui://app/"))
      return Promise.resolve(false);
    attempt.owner = owner;
    attempt.frame = frame;
    return new Promise((resolveDecision) => {
      const cancel = () => finish(false);
      /** @param {Electron.Event} _event @param {string} _url @param {boolean} _inPlace @param {boolean} mainFrame */
      const navigate = (_event, _url, _inPlace, mainFrame) => {
        if (mainFrame) cancel();
      };
      /** @param {boolean} allowed */
      const finish = (allowed) => {
        if (attempt.decide !== finish) return;
        attempt.decide = null;
        owner.removeListener("destroyed", cancel);
        owner.removeListener("render-process-gone", cancel);
        owner.removeListener("did-start-navigation", navigate);
        resolveDecision(allowed);
      };
      attempt.decide = finish;
      owner.once("destroyed", cancel);
      owner.once("render-process-gone", cancel);
      owner.on("did-start-navigation", navigate);
      revealWindow();
      sendDesktopEvent(owner, "areal-core:quit-request", attempt.id);
    });
  }
  /** @param {QuitAttempt} attempt @param {QuitAttempt["phase"]} phase */
  function setQuitProgress(attempt, phase) {
    if (quitAttempt !== attempt || attempt.intent === "install") return;
    attempt.phase = phase;
    if (attempt.owner && !attempt.owner.isDestroyed() && attempt.owner.mainFrame === attempt.frame)
      sendDesktopEvent(
        attempt.owner,
        "areal-core:quit-progress",
        phase ? { state: "quitting", phase } : { state: "idle" },
      );
  }
  /** @param {QuitAttempt} attempt @param {Extract<import("./diagnostics.cjs").Incident,{type:"quit-stage"}>["stage"]} stage */
  function recordQuitStage(attempt, stage) {
    if (quitAttempt !== attempt) return;
    diagnostics.record({
      type: "quit-stage",
      attempt: attempt.id,
      elapsedMs: Math.floor(performance.now() - attempt.startedAt),
      stage,
    });
  }
  /** @param {string} [intent] @returns {Promise<QuitResult>} */
  function requestQuit(intent = "application") {
    if (quitAttempt?.promise) return quitAttempt.promise;
    if (quitting) return Promise.resolve({ canceled: true });
    /** @type {QuitAttempt} */
    const attempt = {
      id: ++quitRequestSequence,
      intent,
      owner: null,
      frame: null,
      decide: null,
      approved: false,
      phase: null,
      startedAt: performance.now(),
      promise: null,
    };
    quitAttempt = attempt;
    /** @param {QuitAttempt["phase"]} phase */
    const beginQuit = (phase) => {
      attempt.approved = true;
      quitting = true;
      if (intent !== "install") preview?.setPresentationSuppressed(true);
      setQuitProgress(attempt, phase);
    };
    /** @param {Electron.MessageBoxOptions} options */
    const notify = async (options) => {
      recordQuitStage(attempt, "native-confirmation");
      const answer = await (process.platform === "darwin" && intent !== "install"
        ? dialog.showMessageBox(options)
        : showMessageBox(options));
      if (answer.response === 1) {
        beginQuit("stopping");
        recordQuitStage(attempt, "stop");
      }
      return answer;
    };
    /** @returns {Promise<QuitResult>} */
    const runQuit = async () => {
      if (!backend) throw new Error(nativeText("lifecycle.preparing"));
      if (!(await confirmRendererQuit(attempt))) {
        recordQuitStage(attempt, "canceled");
        return { canceled: true };
      }
      if (quitting) {
        recordQuitStage(attempt, "canceled");
        return { canceled: true };
      }
      await backend.closeWindowSideChats();
      if (intent === "install") {
        beginQuit("checking");
        recordQuitStage(attempt, "checking");
      }
      recordQuitStage(attempt, "readiness");
      await backend.waitForApplicationReady();
      recordQuitStage(attempt, "reconcile");
      await backend.checkLifecycle();
      if (backend.foreignOwner && (intent === "install" || backend.desktopLifetimes.size))
        throw Object.assign(new Error(nativeText("lifecycle.foreignOwner")), {
          code: "APPLICATION_OWNER_MISMATCH",
        });
      if (
        !backend.foreignOwner &&
        !backend.serviceExited &&
        (backend.status.connected || backend.metadata || backend.desktopLifetimes.size)
      ) {
        recordQuitStage(attempt, "stop");
        const result = await recoverConnectedService({
          backend,
          notify,
          purpose: intent === "install" ? "update" : "quit",
          forUpdate: intent === "install",
        });
        if (!("stopped" in result) || result.stopped !== true) {
          recordQuitStage(
            attempt,
            "canceled" in result && result.canceled ? "canceled" : "incomplete",
          );
          if (!("canceled" in result) || !result.canceled)
            backend.reportLifecycleError(new Error(nativeText("lifecycle.stopIncomplete")));
          return result;
        }
      } else if (intent !== "install") {
        const answer = await notify({
          type: "question",
          message: nativeText("quit.question"),
          detail: nativeText("quit.interfaceDetail"),
          buttons: [nativeText("common.cancel"), nativeText("common.quit")],
          defaultId: 1,
          cancelId: 0,
          noLink: true,
        });
        if (answer.response !== 1) {
          recordQuitStage(attempt, "canceled");
          return { canceled: true };
        }
      }
      setQuitProgress(attempt, "finishing");
      recordQuitStage(attempt, "terminal");
      await backend.prepareQuit();
      if (intent === "install")
        await require("../update/package-users.cjs").assertPackageUsersReleased({
          packaged: app.isPackaged,
          profile: app.getPath("userData"),
          home: backend.home,
        });
      recordQuitStage(attempt, "finalizing");
      if (!backend.foreignOwner) await backend.completeApplicationQuit();
      recordQuitStage(attempt, "disconnect");
      await backend.shutdown();
      await preview?.dispose();
      await closeComputer();
      exitReady = true;
      recordQuitStage(attempt, "exit-ready");
      if (intent !== "install") setImmediate(() => app.quit());
      return { stopped: true, quitting: true };
    };
    attempt.promise = runQuit()
      .catch((error) => {
        recordQuitStage(attempt, "failed");
        throw error;
      })
      .finally(() => {
        if (!exitReady && quitAttempt === attempt) {
          if (backend) backend.guiWindowClosed = false;
          if (attempt.approved) quitting = false;
          setQuitProgress(attempt, null);
          if (intent !== "install") preview?.setPresentationSuppressed(false);
          quitAttempt = null;
        }
      });
    return attempt.promise;
  }
  /** @param {Electron.MessageBoxOptions} options */
  function showMessageBox(options) {
    return window && !window.isDestroyed()
      ? dialog.showMessageBox(window, options)
      : dialog.showMessageBox(options);
  }
  /** @param {Electron.OpenDialogOptions} options */
  function showOpenDialog(options) {
    return window && !window.isDestroyed()
      ? dialog.showOpenDialog(window, options)
      : dialog.showOpenDialog(options);
  }
  /** @param {Electron.SaveDialogOptions} options */
  function showSaveDialog(options) {
    return window && !window.isDestroyed()
      ? dialog.showSaveDialog(window, options)
      : dialog.showSaveDialog(options);
  }
  async function exportDiagnostics() {
    try {
      const options = {
        title: nativeText("diagnostics.exportTitle"),
        defaultPath: `areal-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      };
      const result = await (window && !window.isDestroyed()
        ? showSaveDialog(options)
        : dialog.showSaveDialog(options));
      if (result.canceled || !result.filePath) return { canceled: true };
      await diagnostics.exportTo(result.filePath, diagnosticsRoots);
      return { path: result.filePath };
    } catch {
      throw Object.assign(new Error(nativeText("diagnostics.saveFailed")), {
        code: "DIAGNOSTICS_EXPORT_FAILED",
      });
    }
  }
  const requestStopAndQuit = () => requestQuit("stop");
  const stopAndQuitFromMenu = () => {
    void requestStopAndQuit().catch((error) => {
      backend?.reportLifecycleError(error);
      revealWindow();
    });
  };
  const menuBar = new MenuBar(() => {
    if (startupPresentation === "presented") revealWindow();
  }, stopAndQuitFromMenu);
  app.on("will-quit", () => menuBar?.close());
  /** @type {(import("@areal/workbench/desktop-contract").NotificationTarget & {id:number})|null} */
  let notificationTarget = null;
  let notificationSequence = 0;
  /** @param {unknown} target */
  function openNotificationTarget(target) {
    if (!modelRecord(target) || typeof target.projectId !== "string") return;
    if (typeof target.taskId === "string") {
      if (
        (target.runId !== undefined && typeof target.runId !== "string") ||
        (target.questionId !== undefined && typeof target.questionId !== "string")
      )
        return;
      notificationTarget = {
        projectId: target.projectId,
        taskId: target.taskId,
        runId: target.runId,
        questionId: target.questionId,
        id: ++notificationSequence,
      };
    } else {
      if (typeof target.threadId !== "string") return;
      notificationTarget = {
        projectId: target.projectId,
        threadId: target.threadId,
        id: ++notificationSequence,
      };
    }
    if (!window || window.isDestroyed()) return;
    if (startupPresentation === "presented") revealWindow();
    sendDesktopEvent(window.webContents, "areal-core:notification-open");
  }
  /** @type {(NonNullable<ReturnType<typeof parseDeepLink>>&{id:number})|null} */
  let mcpAppDeepLink = null;
  let mcpAppDeepLinkSequence = 0;
  /** @param {string} raw */
  function receiveMcpAppDeepLink(raw) {
    try {
      mcpAppDeepLink = { ...parseDeepLink(raw), id: ++mcpAppDeepLinkSequence };
    } catch {
      return false;
    }
    if (window && !window.isDestroyed())
      sendDesktopEvent(window.webContents, "areal-core:mcp-app-deep-link");
    return true;
  }
  app.on("open-url", (event, url) => {
    if (receiveMcpAppDeepLink(url)) event.preventDefault();
  });
  app.on("second-instance", (_event, argv) => {
    for (const arg of argv)
      if (/^(areal|codex):\/\/plugins\//.test(arg)) receiveMcpAppDeepLink(arg);
  });
  for (const arg of process.argv)
    if (/^(areal|codex):\/\/plugins\//.test(arg)) receiveMcpAppDeepLink(arg);
  const themes = loadThemes();
  app.on("second-instance", revealWindow);

  function theme() {
    const id =
      themeId === "system"
        ? nativeTheme.shouldUseDarkColors
          ? "data-dense"
          : "soft-glass"
        : themeId;
    const selected = themes.find((item) => item.id === id) ?? themes[0];
    return {
      platform: process.platform,
      id: themeId,
      dark: selected.dark,
      css: engineCss(selected) + panelCss(selected),
      options: themes.map((item) => ({
        id: item.id,
        name: item.name,
        author: item.author,
        swatch: [item.colors.bg, item.colors.bgRaised, item.colors.accent],
      })),
    };
  }
  let publishPending = false;
  function publish() {
    preview?.releaseInvalidOwners();
    mcpApps?.revokeInvalid();
    if (publishPending) return;
    publishPending = true;
    setImmediate(() => {
      publishPending = false;
      if (!window || window.isDestroyed()) return;
      const owner = window.webContents,
        projection = projections.get(owner);
      if (projection?.frame === owner.mainFrame)
        sendDesktopEvent(owner, "areal-core:projection", {
          frame: projection.encoder.encode(desktopSnapshot()),
        });
    });
  }
  function desktopSnapshot() {
    if (!backend) throw new Error(nativeText("lifecycle.preparing"));
    const state = backend.snapshot();
    // Wait for the authoritative saved Library before applying the default.
    // A temporary disconnect must not reset the native preference.
    if (state.connection?.state === "ready" && state.library && !quitting)
      menuBar?.sync(state.library.settings?.showInMenuBar !== false);
    const enabled = state.library?.settings?.computerControlEnabled === true;
    const wasEnabled = computerWasEnabled;
    computerWasEnabled = enabled;
    if (wasEnabled && !enabled) void stopComputer("disabled").catch(() => {});
    return { ...state, menuBar: menuBar?.snapshot() ?? null, computerControl: computerActivity };
  }
  /** @param {Electron.IpcMainEvent|Electron.IpcMainInvokeEvent} event */
  function trustedSender(event) {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !event.senderFrame.url.startsWith("areal-ui://app/")
    )
      throw new Error(nativeText("boundary.untrustedSender"));
    return window;
  }
  /** @param {Electron.IpcMainEvent|Electron.IpcMainInvokeEvent} event */
  function trusted(event) {
    if (quitting) throw new Error(nativeText("boundary.quitting"));
    return trustedSender(event);
  }
  onDesktopIpc("areal-core:interface-locale", (event, locale) => {
    try {
      trustedSender(event);
    } catch {
      return;
    }
    setNativeLocale(locale);
  });
  onDesktopIpc("areal-core:quit-decision", (event, decision) => {
    const attempt = quitAttempt;
    if (
      !attempt?.decide ||
      !modelRecord(decision) ||
      decision.id !== attempt.id ||
      typeof decision.allowed !== "boolean" ||
      event.sender !== attempt.owner ||
      event.senderFrame !== attempt.frame ||
      event.senderFrame !== event.sender.mainFrame ||
      !event.senderFrame.url.startsWith("areal-ui://app/")
    )
      return;
    attempt.decide(decision.allowed);
  });

  /** @param {InstanceType<typeof SharedCoreBackend>} backend */
  async function createWindow(backend) {
    const trace = startupTrace("gui.window");
    trace.advance("create");
    const showTrace = (startupShowTrace = startupTrace("gui.first_show"));
    startupShowTrace.advance("show");
    const paintTrace = (startupPaintTrace = startupTrace("gui.ready_to_show"));
    startupPaintTrace.advance("ready_to_show");
    startupPresentTrace = startupTrace("gui.present_ready");
    startupPresentTrace.advance("present_ready");
    try {
      browserWindowClosed = false;
      const createdWindow = (window = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 980,
        minHeight: 620,
        show: false,
        title: "AReaL Harness",
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 14, y: 15 },
        backgroundColor: "#1b1b1c",
        webPreferences: {
          preload: join(__dirname, "preload.cjs"),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      }));
      {
        // Native recovery dialogs may reveal their parent before the normal gate.
        createdWindow.once("show", () => {
          startupPresentation = "presented";
          showTrace.finish("ok");
        });
        createdWindow.once("ready-to-show", () => {
          startupPainted = true;
          paintTrace.finish("ok");
          presentStartup();
        });
      }
      preview = new CorePreview(
        createdWindow,
        WebContentsView,
        (projectId, threadId) => backend.ownsThread(projectId, threadId),
        () => backend.snapshot().library?.settings ?? {},
        (projectId, threadId) =>
          backend.snapshot().projects.find((project) => project.id === projectId)?.state?.threads?.[
            threadId
          ]?.executionCore?.instanceId ??
          backend.status.browserCore?.[projectId] ??
          null,
        () =>
          [backend.metadata?.endpoint, ...(backend.status.browserControlEndpoints ?? [])].filter(
            (value) => typeof value === "string",
          ),
        async ({ origin, page, fence, kind }) => {
          const current = () =>
            !quitting &&
            !!backend.metadata?.endpoint &&
            createdWindow &&
            !createdWindow.isDestroyed() &&
            createdWindow.isVisible() &&
            !createdWindow.isMinimized() &&
            createdWindow.isFocused() &&
            preview?.currentDevelopmentPrompt(page, fence) === true;
          if (!current()) return false;
          const { response } = await dialog.showMessageBox(createdWindow, {
            type: "question",
            title:
              kind === "frame"
                ? nativeText("browser.frameTitle")
                : nativeText("browser.developmentTitle"),
            message:
              kind === "frame"
                ? nativeText("browser.frameQuestion", { origin })
                : nativeText("browser.developmentQuestion", { origin }),
            detail:
              kind === "frame"
                ? nativeText("browser.frameDetail")
                : nativeText("browser.developmentDetail"),
            buttons: [
              nativeText("common.cancel"),
              kind === "frame"
                ? nativeText("browser.allowFrame")
                : nativeText("browser.allowWorkspace"),
            ],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          return response === 1 && current();
        },
        (projectId, threadId) => backend.retainsThreadResources(projectId, threadId),
      );
      preview.onRevoke = (identity) => {
        void backend.browserRevoke(identity).catch(() => {});
      };
      createdWindow.on("unresponsive", () => {
        computerUiAvailable = false;
        void stopComputer("ui_unresponsive").catch(() => {});
        diagnostics.record({ type: "renderer-unresponsive" });
      });
      createdWindow.on("responsive", () => {
        computerUiAvailable = createdWindow.webContents.mainFrame.url.startsWith("areal-ui://app/");
        diagnostics.record({ type: "renderer-responsive" });
      });
      const owner = createdWindow.webContents;
      owner.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) {
          computerUiAvailable = false;
          void stopComputer("ui_navigation").catch(() => {});
          projections.delete(owner);
          mcpApps?.dispose();
        }
      });
      owner.on("did-finish-load", () => {
        computerUiAvailable = owner.mainFrame.url.startsWith("areal-ui://app/");
      });
      owner.on("destroyed", () => {
        computerUiAvailable = false;
        void stopComputer("ui_destroyed").catch(() => {});
        projections.delete(owner);
      });
      owner.on("render-process-gone", () => {
        computerUiAvailable = false;
        void stopComputer("ui_crashed").catch(() => {});
        projections.delete(owner);
        mcpApps?.dispose();
      });
      createdWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      createdWindow.webContents.on("will-navigate", (event) => event.preventDefault());
      createdWindow.webContents.on("will-frame-navigate", (event) => {
        const from = event.initiator?.url ?? event.frame?.url ?? "";
        if (from.startsWith("areal-mcp:") && !event.url.startsWith("areal-mcp:"))
          event.preventDefault();
      });
      createdWindow.webContents.on("will-prevent-unload", (event) => {
        if (
          exitReady &&
          quitAttempt?.approved &&
          quitAttempt.owner === createdWindow.webContents &&
          quitAttempt.frame === createdWindow.webContents.mainFrame
        )
          event.preventDefault();
      });
      createdWindow.on("show", () => {
        browserWindowClosed = false;
        if (backend) backend.guiWindowClosed = false;
      });
      createdWindow.on("close", (event) => {
        if (exitReady) return;
        event.preventDefault();
        if (quitting || windowClosePromise) return;
        // A close-to-background still ends this createdWindow's Browser ownership. Fence
        // native callbacks before hiding; reopening creates fresh Pages on demand.
        browserWindowClosed = true;
        if (startupPresentation !== "presented") {
          startupPresentation = "suppressed";
          focusRequested = false;
        }
        const owner = createdWindow;
        void stopComputer("window_closed").catch(() => {});
        windowClosePromise = backend
          .closeWindowSideChats()
          .then(async () => {
            await preview?.dispose();
            mcpApps?.dispose();
            if (!owner.isDestroyed()) owner.hide();
          })
          .catch((error) => {
            browserWindowClosed = false;
            if (backend) backend.guiWindowClosed = false;
            backend.reportLifecycleError(error);
          })
          .finally(() => {
            windowClosePromise = null;
          });
      });
      trace.advance("load");
      await createdWindow.loadURL("areal-ui://app/");
      trace.finish("ok");
      return createdWindow;
    } catch (error) {
      trace.finish("error", error);
      throw error;
    }
  }

  app
    .whenReady()
    .then(async () => {
      if (startupSettingsError) throw startupSettingsError;
      await Promise.all(
        [session.defaultSession, session.fromPartition("persist:areal-embedded-browser")].map(
          (target) => applyDesktopSessionNetworkPolicy(target, startupSettings),
        ),
      );
      startupTraceMain.finish("ok");
      if (process.platform === "darwin")
        app.dock?.setIcon(join(__dirname, "../../assets/icon-1024.png"));
      protocol.handle("areal-ui", async (request) => {
        const url = new URL(request.url);
        if (url.host !== "app") return new Response("Not found", { status: 404 });
        const path = resolve(
          guiRoot,
          "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname),
        );
        if (!path.startsWith(guiRoot + sep)) return new Response("Not found", { status: 404 });
        try {
          return new Response(await readFile(path), {
            headers: {
              "Content-Type": mime[extname(path)] ?? "application/octet-stream",
              "Content-Security-Policy":
                "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-src areal-mcp:",
            },
          });
        } catch {
          return new Response(nativeText("gui.notBuilt"), { status: 404 });
        }
      });
      const serviceBackend = new SharedCoreBackend({
        app,
        ...serviceOptions(app),
        applicationOwner,
        onChange: publish,
        onNotification: (notice) =>
          showCoreNotification(Notification, window ?? null, notice, openNotificationTarget),
        onNotificationOpen: openNotificationTarget,
        onRecoveryAttention: (attention) => {
          if (!Array.isArray(attention) || !attention.every((item) => typeof item === "string"))
            throw new Error("Invalid recovery attention");
          return showMessageBox({
            type: "warning",
            message: nativeText("recovery.attention"),
            detail: attention.join("\n\n") + nativeText("recovery.attentionDetail"),
            buttons: [nativeText("recovery.review")],
            defaultId: 0,
            cancelId: 0,
          });
        },
      });
      backend = serviceBackend;
      const computerHost = (computer = new ComputerControl({
        helperPath: app.isPackaged
          ? join(process.resourcesPath, "computer-helper/AReaL Computer Helper.app")
          : join(__dirname, "../../../native/computer-helper/build/AReaL Computer Helper.app"),
        getEnabled: () =>
          computerAvailable() &&
          computerSelection().enabled &&
          computerSelection().provider === "native",
        onActivity: (status) => {
          if (computerSelection().provider === "native") {
            computerActivity = status;
            publish();
          }
        },
      }));
      const externalCuaHost = (externalCua = new ExternalCua({
        getSelection: computerSelection,
        getAvailable: computerAvailable,
        onActivity: (status) => {
          if (computerSelection().provider === "lcu") {
            computerActivity = status;
            publish();
          }
        },
        onElicitation: async (params, { signal, owner }) => {
          const { nativeAppApprovalOptions, nativeAppApprovalResponse } = await cuaUpstream();
          const { declineAgentHostApp, detectHostApps, appBundleOf, plistBundleId } =
            await import("../vendor/lcu/host-guard.mjs");
          const bundle = appBundleOf(process.execPath),
            bundleId = bundle && plistBundleId(bundle);
          const refusal = declineAgentHostApp(params, {
            env: {},
            report() {},
            hosts: [...detectHostApps(), ...(bundleId ? [{ bundleId, name: app.getName() }] : [])],
          });
          const { ElicitResultSchema } = await import("@modelcontextprotocol/sdk/types.js");
          if (refusal) return ElicitResultSchema.parse(refusal);
          const approval = nativeAppApprovalOptions(params);
          if (
            !approval ||
            signal.aborted ||
            !computerAvailable() ||
            !window ||
            window.isDestroyed()
          )
            return { action: "cancel" };
          const choices = [...approval.choices, { value: "cancel", label: "Cancel" }];
          const result = await showMessageBox({
            type: "question",
            title: "External computer control",
            message: approval.message,
            detail: [
              approval.resource,
              typeof params._meta?.warning === "string" ? params._meta.warning : "",
              `Chat ${owner.threadId}`,
            ]
              .filter(Boolean)
              .join("\n\n"),
            buttons: choices.map((choice) => choice.label),
            defaultId: choices.length - 1,
            cancelId: choices.length - 1,
            noLink: true,
            signal,
          });
          return signal.aborted
            ? { action: "cancel" }
            : ElicitResultSchema.parse(
                nativeAppApprovalResponse(params, choices[result.response]?.value),
              );
        },
      }));
      serviceBackend.onBrowserDisconnected = () => {
        preview?.revokeAll();
        for (const controller of computerRequests.values()) controller.abort();
        void stopComputer("desktop_disconnected").catch(() => {});
      };
      serviceBackend.onBrowserCancel = (request) => {
        if (!modelRecord(request) || typeof request.requestId !== "number") return;
        if (request.tool === "computer_v1" || request.tool === "external_cua")
          computerRequests.get(request.requestId)?.abort();
        else if (
          typeof request.projectId === "string" &&
          typeof request.threadId === "string" &&
          typeof request.hostGeneration === "number"
        )
          preview?.cancelRead({
            projectId: request.projectId,
            threadId: request.threadId,
            requestId: request.requestId,
            hostGeneration: request.hostGeneration,
          });
      };
      serviceBackend.onBrowserRequest = async (request) => {
        if (request.tool === "external_cua") {
          const controller = new AbortController();
          computerRequests.set(request.requestId, controller);
          try {
            const input = { ...request, tool: request.cuaTool, signal: controller.signal };
            if (request.phase === "catalog")
              return await externalCuaHost.catalog({ ...input, threadId: "__catalog__" });
            if (request.phase === "call") return await externalCuaHost.call(input);
            if (request.phase === "endTurn") return await externalCuaHost.endTurn(input);
            if (request.phase === "revokeProject") {
              await externalCuaHost.revokeProject(input);
              return {};
            }
            throw new Error("Unsupported external CUA request");
          } catch (error) {
            if (request.phase === "catalog") return { error: desktopError(error).message };
            throw error;
          } finally {
            computerRequests.delete(request.requestId);
          }
        }
        if (request.tool === "computer_v1") {
          if (quitting || !window || window.isDestroyed() || browserWindowClosed)
            throw new Error("Computer host unavailable");
          const controller = new AbortController();
          computerRequests.set(request.requestId, controller);
          try {
            const input = { ...request, signal: controller.signal };
            return await (request.phase === "prepare"
              ? request.discardPreparedPlan === true
                ? computerHost.discard(input)
                : computerHost.prepare(input)
              : computerHost.execute(input));
          } catch (error) {
            const fields = modelRecord(error) ? error : {};
            const details = desktopError(error);
            if (request.phase === "prepare")
              return {
                ...(modelRecord(fields.structuredContent) ? fields.structuredContent : {}),
                code: details.code ?? "computer_unavailable",
                message: details.message,
                error: details.code ?? "computer_unavailable",
                dispatch: "not_sent",
                dispatch_status: "not_sent",
                action_sent: false,
              };
            const dispatch = fields.dispatch_status ?? fields.dispatchStatus;
            if (
              dispatch === "not_sent" &&
              fields.actionSent !== true &&
              fields.action_sent !== true
            )
              return {
                isError: true,
                content: [{ type: "text", text: details.message }],
                structuredContent: {
                  code: details.code ?? "computer_unavailable",
                  dispatch_status: "not_sent",
                  action_sent: false,
                },
              };
            throw error;
          } finally {
            if (computerRequests.get(request.requestId) === controller)
              computerRequests.delete(request.requestId);
          }
        }
        if (quitting || !preview || !window || window.isDestroyed())
          throw new Error("Browser host unavailable");
        const browserRequest = readBrowserHostRequest(request);
        try {
          if (browserRequest.operation === "describe") {
            if (browserRequest.phase === "prepare") return preview.prepareDiscovery(browserRequest);
            if (browserRequest.browserApproval?.plan) preview.consumeDiscovery(browserRequest);
            const identity = await preview.ensureAgentPage(
              browserRequest.projectId,
              browserRequest.threadId,
            );
            try {
              if (
                !(
                  modelRecord(browserRequest.browserApproval?.plan) &&
                  browserRequest.browserApproval.plan.alreadyControlled
                )
              )
                await serviceBackend.browserClaim({
                  ...identity,
                  bootstrapRequestId: browserRequest.requestId,
                });
              const page = preview.page(
                browserRequest.projectId,
                browserRequest.threadId,
                identity.pageId,
              );
              if (
                !page ||
                !preview.pageStillOwned(page) ||
                page.control !== "agent" ||
                preview.page(browserRequest.projectId, browserRequest.threadId, undefined) !==
                  page ||
                page.controlEpoch !== identity.controlEpoch ||
                page.pageGeneration !== identity.pageGeneration
              )
                throw new Error("Browser entry was revoked");
            } catch (error) {
              const page = preview.page(
                browserRequest.projectId,
                browserRequest.threadId,
                identity.pageId,
              );
              if (page?.controlEpoch === identity.controlEpoch && page.control === "agent")
                preview.takeover(
                  browserRequest.projectId,
                  browserRequest.threadId,
                  identity.pageId,
                );
              throw error;
            }
            if (!window.isDestroyed())
              sendDesktopEvent(window.webContents, "areal-core:preview-event", {
                kind: "reveal",
                projectId: browserRequest.projectId,
                threadId: browserRequest.threadId,
                pageId: identity.pageId,
              });
            return {
              ...identity,
              coreGeneration: browserRequest.coreGeneration,
              turnId: browserRequest.turnId,
              callId: browserRequest.callId,
              claimed: true,
              controlPermit: preview.controlPermit(
                browserRequest.projectId,
                browserRequest.threadId,
                identity.pageId,
              ),
            };
          }
          const result = await (browserRequest.phase === "prepare"
            ? preview.prepare(browserRequest)
            : preview.execute(browserRequest));
          if (!modelRecord(result)) throw new Error("Invalid browser host result");
          if (browserRequest.phase !== "prepare" && !result.error) {
            result.controlPermit = preview.controlPermit(
              browserRequest.projectId,
              browserRequest.threadId,
              browserRequest.pageId,
            );
            if (modelRecord(result.createdPage) && typeof result.createdPage.pageId === "string")
              result.controlPermits = [
                result.controlPermit,
                preview.controlPermit(
                  browserRequest.projectId,
                  browserRequest.threadId,
                  result.createdPage.pageId,
                ),
              ];
          }
          return result;
        } catch (error) {
          return browserHostFailure(request, error);
        }
      };
      app.on("will-quit", () => {
        mcpApps?.dispose();
        void closeComputer().catch(() => {});
      });
      const mcpHost = (mcpApps = new McpAppsHost({
        backend: serviceBackend,
        ownerId: () =>
          window && !window.isDestroyed() && !window.webContents.isDestroyed()
            ? window.webContents.id
            : undefined,
        notify: (value) => {
          if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
            sendDesktopEvent(window.webContents, "areal-core:mcp-app-event", value);
        },
        openFile: (request, current) =>
          fileOpen(
            {
              backend: serviceBackend,
              shell,
              home: app.getPath("home"),
              authorize: current,
              chooseSave: (options) => showSaveDialog(options),
            },
            request,
          ),
      }));
      serviceBackend.onMcpAppNotification = (event) => mcpHost.notification(event);
      serviceBackend.onMcpPageToolNotice = (event) => {
        void mcpHost.pageToolNotice(event).catch(() => {});
      };
      serviceBackend.onMcpPageToolsDisconnected = (event) => mcpHost.pageToolsDisconnected(event);
      protocol.handle("areal-mcp", (request) => mcpHost.resource(request));
      handleDesktopIpc("areal-core:mcp-app-deep-link-target", (event) => {
        trusted(event);
        return mcpAppDeepLink;
      });
      handleDesktopIpc("areal-core:mcp-app-deep-link-consumed", (event, id) => {
        trusted(event);
        if (mcpAppDeepLink?.id === id) mcpAppDeepLink = null;
      });
      const mcpMetadataImages = new McpMetadataImages(serviceBackend);
      const mcpFormResources = new McpFormResources({
        backend: serviceBackend,
        choose: (options) => showOpenDialog(options),
        confirm: (options) => showMessageBox(options),
      });
      app.on("will-quit", () => mcpFormResources.dispose());
      handleDesktopIpc("areal-core:mcp-form-resource", async (event, operation, request) => {
        trusted(event);
        const ownerWindow = trusted(event);
        const current = () => {
          trusted(event);
          if (window !== ownerWindow || ownerWindow.isDestroyed())
            throw new Error("Form window expired");
        };
        if (operation === "pick") return mcpFormResources.pick(request, current);
        if (operation === "release") return mcpFormResources.release(request, current);
        throw new Error("Invalid form resource operation");
      });
      handleDesktopIpc("areal-core:mcp-app", async (event, request) => {
        trusted(event);
        if (!modelRecord(request)) throw new Error("Invalid app request");
        if (request.operation === "metadataImage")
          return mcpMetadataImages.load(request.source).catch(() => {
            throw new Error("Metadata image unavailable");
          });
        if (request.operation === "openGenUi") return mcpHost.openGenUi(request, event.sender.id);
        if (request.operation === "genUiVisibility")
          return mcpHost.genUiVisibility(request, event.sender.id);
        if (request.operation === "openFromResult")
          return mcpHost.openFromResult(request, event.sender.id);
        if (request.operation === "open")
          return mcpHost.open(request, event.sender.id).catch(() => {
            throw new Error("MCP App could not be opened");
          });
        if (request.operation === "close" && request.token === undefined) return {};
        if (
          ["request", "pageToolsReady", "pageToolsUnmount", "pageToolResult", "close"].includes(
            String(request.operation),
          ) &&
          typeof request.token !== "string"
        )
          throw new Error("Invalid MCP App token");
        if (request.operation === "request" && typeof request.token === "string")
          return mcpHost.request(request.token, request.request, event.sender.id).catch(() => {
            throw new Error("MCP App request rejected or incomplete");
          });
        if (
          request.operation === "pageToolsReady" &&
          typeof request.token === "string" &&
          typeof request.mountId === "string"
        )
          return mcpHost.pageToolsReady(
            request.token,
            request.mountId,
            request.declaration,
            event.sender.id,
          );
        if (
          request.operation === "pageToolsUnmount" &&
          typeof request.token === "string" &&
          typeof request.mountId === "string"
        )
          return mcpHost.pageToolsUnmount(request.token, request.mountId, event.sender.id);
        if (
          request.operation === "pageToolResult" &&
          typeof request.token === "string" &&
          typeof request.mountId === "string" &&
          typeof request.callId === "string"
        )
          return mcpHost.pageToolResult(
            request.token,
            request.mountId,
            request.callId,
            request.reply,
            event.sender.id,
          );
        if (request.operation === "close" && typeof request.token === "string")
          return mcpHost.close(request.token, event.sender.id);
        throw new Error("Unsupported app operation");
      });
      handleDesktopIpc("areal-core:preview", async (event, request) => {
        const ownerWindow = trustedSender(event);
        validatePreview(request);
        if (quitting) {
          if (preview?.suppressedPresentation && request.operation === "show") return null;
          throw new Error(nativeText("boundary.quitting"));
        }
        if (!preview) throw new Error(nativeText("browser.previewUnavailable"));
        const activePreview = preview;
        if (request?.operation === "subscribe") {
          if (!serviceBackend.ownsThread(request.projectId, request.threadId))
            throw new Error(nativeText("browser.selectTask"));
          const key = JSON.stringify([request.projectId, request.threadId]);
          previewSubscriptions.get(key)?.();
          const subscription = activePreview.subscribe(
            request.projectId,
            request.threadId,
            (update) => {
              if (!ownerWindow.isDestroyed())
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
          browserWindowClosed &&
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
          const value = activePreview.takeover(request.projectId, request.threadId, request.pageId);
          void serviceBackend
            .browserRevoke({
              projectId: request.projectId,
              threadId: request.threadId,
              pageId: request.pageId,
            })
            .catch(() => {});
          return value;
        }
        return activePreview.command(request);
      });
      handleDesktopIpc("areal-core:notification-target", (event) => {
        trusted(event);
        return notificationTarget;
      });
      handleDesktopIpc("areal-core:notification-consumed", (event, id) => {
        trusted(event);
        if (notificationTarget?.id === id) notificationTarget = null;
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
        const { requestCommandLineToolsInstallation } = require("./host-prerequisites.cjs");
        const result = await requestCommandLineToolsInstallation();
        trusted(event);
        return result;
      });
      onDesktopIpc("areal-core:projection-request", (event, requestId) => {
        try {
          trusted(event);
        } catch {
          return;
        }
        if (
          typeof requestId !== "number" ||
          !Number.isSafeInteger(requestId) ||
          requestId <= 0 ||
          !event.senderFrame
        )
          return;
        let projection = projections.get(event.sender);
        if (!projection || projection.frame !== event.senderFrame) {
          projection = { frame: event.senderFrame, encoder: new ProjectionEncoder(randomUUID()) };
          projections.set(event.sender, projection);
        }
        sendDesktopEvent(event.sender, "areal-core:projection", {
          requestId,
          frame: projection.encoder.encode(desktopSnapshot(), true),
        });
      });
      handleDesktopIpc("areal-core:present-ready", (event) => {
        trusted(event);
        startupReady = true;
        startupPresentTrace?.finish("ok");
        presentStartup();
      });
      handleDesktopIpc("areal-core:theme", (event, id) => {
        trusted(event);
        if (id !== undefined) {
          if (typeof id !== "string" || (id !== "system" && !themes.some((item) => item.id === id)))
            throw new Error(nativeText("gui.unknownTheme"));
          themeId = id;
        }
        return theme();
      });
      nativeTheme.on("updated", () => {
        if (window) sendDesktopEvent(window.webContents, "areal-core:theme-changed", theme());
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
        if (!(await stat(cwd)).isDirectory())
          throw new Error(nativeText("picker.existingDirectory"));
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
      handleDesktopIpc("areal-core:file-open", async (event, request) => {
        trusted(event);
        return fileOpen(
          {
            backend: serviceBackend,
            shell,
            home: app.getPath("home"),
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
        try {
          if (typeof rawName !== "string") throw new Error("Invalid command name");
          const { name, request: params } = readCommandInvocation(rawName, rawParams, {
            serviceOnly: false,
          });
          if (name === "browserData") {
            if (!preview) throw new Error(nativeText("browser.previewUnavailable"));
            const value = await preview.browserData(params.operation, {
              importChrome: (options) =>
                require("@areal/browser-data").importChromeBrowserData({
                  ...options,
                  logger: console,
                }),
            });
            trusted(event);
            return { ok: true, value };
          }
          if (name === "computerControl") {
            let value;
            if (computerSelection().provider === "lcu") {
              if (params.operation === "status") value = externalCuaHost.status();
              else if (params.operation === "restart") value = await externalCuaHost.check();
              else if (params.operation === "stop") {
                await externalCuaHost.stop("user_stop");
                value = externalCuaHost.status();
              } else
                throw new Error(
                  "LCU installation and OS permissions are managed outside AReaL Harness",
                );
            } else if (params.operation === "status") value = await computerHost.status();
            else if (params.operation === "stop") {
              await computerHost.stop("user_stop");
              value = await computerHost.status();
            } else if (params.operation === "restart") {
              await computerHost.restart();
              value = await computerHost.status();
            } else {
              if (process.platform !== "darwin")
                throw new Error("Computer control is unavailable on this platform");
              if (params.operation === "requestAccess")
                value = await computerHost.requestAccess(params.capability);
              else {
                if (params.operation !== "openSettings")
                  throw new Error("Invalid computer operation");
                const panes = {
                  accessibility: "Privacy_Accessibility",
                  screenRecording: "Privacy_ScreenCapture",
                  inputMonitoring: "Privacy_ListenEvent",
                };
                await shell.openExternal(
                  `x-apple.systempreferences:com.apple.preference.security?${panes[params.capability]}`,
                );
                value = await computerHost.status();
              }
            }
            trusted(event);
            if (serviceBackend.computerHostOwned !== true)
              value = {
                ...value,
                ready: false,
                code: "host_busy",
                reason:
                  "Computer control belongs to another GUI window. Reconnect after that host closes.",
              };
            return { ok: true, value };
          }
          if (
            name === "library" &&
            params.operation === "settings" &&
            ["computerControlEnabled", "computerControlProvider", "computerControlExecutable"].some(
              (key) => key === params.key,
            )
          ) {
            computerAdmissionSuspended = true;
            try {
              await stopComputer("configuration_changed");
              return { ok: true, value: await serviceBackend.command(name, params) };
            } finally {
              computerAdmissionSuspended = false;
            }
          }
          if (name === "exportDiagnostics") return { ok: true, value: await exportDiagnostics() };
          if (
            name === "manage" &&
            ["pluginArchivePick", "pluginArchiveImport"].includes(params.operation)
          )
            return { ok: true, value: await pluginArchives.command(params, () => trusted(event)) };
          if (name === "remoteControl")
            return { ok: true, value: await serviceBackend.remoteControl(params) };
          if (name === "serviceLifecycle") {
            if (params.operation === "quitInterface")
              return { ok: true, value: await requestQuit() };
            if (params.operation === "stopAndQuit")
              return { ok: true, value: await requestStopAndQuit() };
            const value =
              params.operation === "update"
                ? await serviceBackend.applyUpdate({
                    notify: (options) => showMessageBox(options),
                  })
                : params.operation === "stop"
                  ? await requestStopService()
                  : params.operation === "recover"
                    ? await serviceBackend.recoverBackend({
                        notify: (options) => showMessageBox(options),
                      })
                    : await serviceBackend.checkLifecycle();
            return { ok: true, value };
          }
          if (name === "serviceStatus")
            return { ok: true, value: await serviceBackend.serviceStatus() };
          if (name === "stopService") return { ok: true, value: await requestStopService() };
          if (name === "recoverResources")
            return {
              ok: true,
              value: await serviceBackend.recoverBackend({
                notify: (options) => showMessageBox(options),
              }),
            };
          if (name === "connectService") {
            await serviceBackend.init();
            return { ok: true, value: null };
          }
          if (name === "manage" && params.operation === "archive") {
            const answer = await showMessageBox({
              type: "question",
              message: nativeText("archive.question"),
              detail: nativeText("archive.detail"),
              buttons: [nativeText("common.cancel"), nativeText("archive.confirm")],
              defaultId: 0,
              cancelId: 0,
            });
            if (answer.response !== 1) return { ok: true, value: { canceled: true } };
          }
          if (name === "export") {
            await serviceBackend.command("open", params);
            const project = serviceBackend
              .snapshot()
              .projects.find((item) => item.id === params.projectId);
            const thread = project?.state?.threads[params.threadId];
            if (!thread) throw new Error(nativeText("export.selectConversation"));
            const result = await showSaveDialog({
              title: nativeText("export.title"),
              defaultPath: `areal-${thread.id}.json`,
              filters: [{ name: "JSON", extensions: ["json"] }],
            });
            if (result.canceled || !result.filePath) return { ok: true, value: { canceled: true } };
            await writeFile(
              result.filePath,
              JSON.stringify(
                {
                  format: "areal-harness-thread-v1",
                  exportedAt: new Date().toISOString(),
                  project: { id: project.id, root: project.root },
                  thread,
                  queue: project.state?.queues?.[thread.id],
                },
                null,
                2,
              ),
              { mode: 0o600 },
            );
            return { ok: true, value: { path: result.filePath } };
          }
          trusted(event);
          const value = await serviceBackend.command(name, params);
          // Renderer records the selected conversation before requesting its
          // authoritative snapshot. Checkpoint that existing DOMStorage after the
          // open succeeds so a forced GUI exit can retain the accepted navigation.
          if (
            name === "open" &&
            window &&
            !window.isDestroyed() &&
            event.sender === window.webContents
          )
            event.sender.session.flushStorageData();
          if (name === "manage") mcpMetadataImages.remember(params, value);
          if (
            name === "manage" &&
            params.operation === "pluginAuth" &&
            params.authOperation === "start" &&
            modelRecord(value) &&
            value.status === "pending"
          ) {
            if (typeof value.authorizationUrl !== "string")
              throw new Error(nativeText("auth.unsupportedUrl"));
            const authUrl = new URL(value.authorizationUrl);
            if (
              authUrl.protocol !== "https:" &&
              !(
                authUrl.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(authUrl.hostname)
              )
            )
              throw new Error(nativeText("auth.unsupportedUrl"));
            try {
              await shell.openExternal(authUrl.href);
            } catch {
              throw new Error(nativeText("auth.openFailed"));
            }
          }
          if (name === "chatgpt" && params.operation === "login") {
            try {
              if (!modelRecord(value) || typeof value.authUrl !== "string")
                throw new Error("Invalid authentication URL");
              await shell.openExternal(value.authUrl);
            } catch {
              await serviceBackend.command("chatgpt", {
                operation: "cancel",
                provider: params.provider,
              });
              throw new Error(nativeText("auth.chatgptOpenFailed"));
            }
          }
          return { ok: true, value };
        } catch (error) {
          return { ok: false, error: desktopError(error) };
        }
      });
      let recoveryPending = 0;
      const hasUpdateWork = async () => {
        const lifecycle = serviceBackend.snapshot().lifecycle;
        const unsettled =
          (lifecycle && "phase" in lifecycle && lifecycle.phase === "admissionUnconfirmed") ||
          lifecycle?.operations?.some(
            (operation) => !["completed", "blocked"].includes(operation.phase),
          );
        return (
          recoveryPending > 0 ||
          unsettled ||
          (!serviceBackend.serviceExited && !(await serviceBackend.observeLifecycle()).ifIdle)
        );
      };
      const recoverInstall = async () => {
        recoveryPending++;
        try {
          await recoverConnectedService({
            backend: serviceBackend,
            notify: (options) => showMessageBox(options),
            purpose: "update",
            forUpdate: true,
          });
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
          if (window && !window.isDestroyed())
            sendDesktopEvent(window.webContents, "areal-core:update-changed", state);
        },
        prepareInstall: async () => {
          if (quitting || (await hasUpdateWork()))
            throw Object.assign(new Error(nativeText("lifecycle.activeWork")), {
              code: "LIFECYCLE_BLOCKED",
            });
          const result = await requestQuit("install");
          if (!("stopped" in result) || result.stopped !== true)
            throw Object.assign(new Error(nativeText("lifecycle.installCanceled")), {
              code: "LIFECYCLE_BLOCKED",
            });
        },
      }));
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
      const requestStopService = () =>
        recoverConnectedService({
          backend: serviceBackend,
          notify: (options) => showMessageBox(options),
          purpose: "stop",
        });

      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "AReaL Harness",
            submenu: [
              { role: "about" },
              {
                label: "检查更新…",
                click: () => {
                  void updater.check(true);
                },
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
                label: "停止后台 Core 服务…",
                click: async () => {
                  try {
                    await requestStopService();
                  } catch (error) {
                    serviceBackend.reportLifecycleError(error);
                  }
                },
              },
              { type: "separator" },
              { label: "退出 AReaL Harness", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
            ],
          },
          { role: "editMenu" },
          { role: "viewMenu" },
          { role: "windowMenu" },
        ]),
      );
      // 后台连接与隐藏首屏并行；状态由快照展示，启动不触发维护弹窗。
      const windowLoaded = createWindow(serviceBackend);
      const serviceStarted = (async () => {
        const trace = startupTrace("gui.backend_init");
        trace.advance("initialize");
        try {
          await serviceBackend.init({ automatic: true });
          trace.advance("initial_project");
          if (serviceBackend.status.connected && process.env.AREAL_CORE_WORKSPACE)
            await serviceBackend.addProject(process.env.AREAL_CORE_WORKSPACE);
          trace.finish(serviceBackend.status.connected ? "ok" : "skipped");
        } catch (error) {
          trace.finish("error", error);
        } /* 错误由后台连接快照展示，用户显式重试。 */
        publish();
      })();
      await windowLoaded;
      const activityPauses = new Set();
      const sampleActivity = () =>
        serviceBackend.analytics.sample({
          focused:
            !!window &&
            !window.isDestroyed() &&
            window.isFocused() &&
            window.isVisible() &&
            !window.isMinimized(),
          idleSeconds: powerMonitor.getSystemIdleTime(),
          suspended: activityPauses.size > 0,
        });
      const activityTimer = setInterval(sampleActivity, 5000);
      const saveTimer = setInterval(() => {
        void serviceBackend.analytics.flush();
      }, 30000);
      window
        ?.on("focus", sampleActivity)
        .on("blur", sampleActivity)
        .on("hide", sampleActivity)
        .on("minimize", sampleActivity)
        .on("restore", sampleActivity);
      /** @param {"suspend"|"lock-screen"} event */
      const pauseActivity = (event) => {
        computerSystemPaused = true;
        void stopComputer(event).catch(() => {});
        sampleActivity();
        activityPauses.add(event);
        sampleActivity();
        void serviceBackend.analytics.flush();
      };
      powerMonitor
        .on("suspend", () => pauseActivity("suspend"))
        .on("lock-screen", () => pauseActivity("lock-screen"));
      /** @param {"suspend"|"lock-screen"} pause */
      const resumeActivity = (pause) => {
        activityPauses.delete(pause);
        computerSystemPaused = activityPauses.size > 0;
        sampleActivity();
      };
      powerMonitor
        .on("resume", () => resumeActivity("suspend"))
        .on("unlock-screen", () => resumeActivity("lock-screen"));
      app.on("before-quit", () => {
        sampleActivity();
        void serviceBackend.analytics.flush();
      });
      app.on("will-quit", () => {
        clearInterval(activityTimer);
        clearInterval(saveTimer);
      });
      sampleActivity();
      await serviceStarted;
      sampleActivity();
    })
    .catch((error) => {
      startupTraceMain.finish("error", error);
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

  app.on("activate", revealWindow);
  app.on("window-all-closed", () => {});
  app.on("before-quit", (event) => {
    if (exitReady) return;
    event.preventDefault();
    if (quitting) return;
    void requestQuit().catch((error) => {
      backend?.reportLifecycleError(error);
      revealWindow();
    });
  });
}
