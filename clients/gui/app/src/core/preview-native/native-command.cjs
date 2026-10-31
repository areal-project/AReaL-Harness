// @ts-check
"use strict";
const { hasNativePage } = require("./workspace.cjs");
const { webUrl } = require("../preview/urls.cjs");
const { sensitiveCaptureScript } = require("../preview/capture-guard.cjs");
const { pageKey } = require("./identity.cjs");
const { randomUUID } = require("node:crypto");
const {
  executeBrowserCommandOnView,
  recordBrowserVideo,
  RecordingScenario,
  waitForDelay,
  waitForCondition,
} = require("@areal/browser-automation");
const {
  createElectronBrowserWebmRecorder,
  acquireBackgroundSurface,
} = require("@areal/browser-automation/electron");
const { invalidateActionObservation } = require("../preview/observation-state.cjs");
const { browserCommandMutates } = require("./command-policy.cjs");
const { loadNavigationDocument } = require("../browser-navigation.cjs");
const DOWNLOAD_INTENT_MS = 30000;

class NativeCommandExecution {
  /**
   * @param {InstanceType<typeof import('./control.cjs').PageControl>} control
   * @param {InstanceType<typeof import('./human-input.cjs').HumanBrowserInput>} human_input
   * @param {InstanceType<typeof import('./presentation.cjs').PreviewPresentation>} presentation
   * @param {InstanceType<typeof import('./workspace.cjs').PreviewWorkspace>} workspace
   * @param {(page:import("./model.js").Page) => string} commandArtifactRoot
   * @param {(entry:import("./model.js").Recording) => import("@areal/browser-automation").BrowserRecordingJob} commandRecordingStatus
   */
  constructor(
    control,
    human_input,
    presentation,
    workspace,
    commandArtifactRoot,
    commandRecordingStatus,
  ) {
    this.control = control;
    this.human_input = human_input;
    this.presentation = presentation;
    this.workspace = workspace;
    this.commandArtifactRoot = commandArtifactRoot;
    this.commandRecordingStatus = commandRecordingStatus;
  }
  /**
   * @param {import('./model.js').CommandRequest} request
   * @param {import('./model.js').Page} page
   * @param {import('./model.js').BrowserCommand} command
   */
  async executeNativeCommand(request, page, command) {
    if (!hasNativePage(page)) throw new Error("plan_stale");
    const started = Date.now(),
      c = page.view.webContents;
    /** @param {Omit<import("@areal/browser-automation").BrowserCommandResult,"elapsedMs">} partial */
    const done = (partial) => ({ commandResult: { elapsedMs: Date.now() - started, ...partial } });
    if (page.activeRead || page.activePrepare || page.activeAction) throw new Error("not_sent");
    const epoch = page.controlEpoch,
      generation = page.pageGeneration;
    const controller = new AbortController();
    /** @type {(reason:Error)=>void} */
    let rejectStop = () => {};
    /** @type {Promise<never>} */
    const stopped = new Promise((_, reject) => {
      rejectStop = reject;
    });
    void stopped.catch(() => {});
    const action = {
      requestId: request.requestId,
      turnId: request.turnId,
      syntheticInput: true,
      command: true,
      dispatched: false,
      cancelled: false,
      controller,
      controlEpoch: epoch,
      cancel: () => {
        action.cancelled = true;
        controller.abort();
        rejectStop(new Error(action.dispatched ? "outcome_unknown" : "not_sent"));
      },
    };
    page.activeAction = action;
    const live = () => {
      if (
        controller.signal.aborted ||
        !this.workspace.pageStillOwned(page) ||
        !page.view ||
        c.isDestroyed() ||
        page.view.webContents !== c ||
        page.pageGeneration !== generation ||
        page.control !== "agent" ||
        page.controlEpoch !== epoch
      )
        throw new Error(action.dispatched ? "outcome_unknown" : "not_sent");
    };
    /** @type {import("./model.js").CdpSend} */
    const send = async (method, params, sessionId) => {
      live();
      if (method.startsWith("Input.") || method === "Page.handleJavaScriptDialog")
        action.dispatched = true;
      const result = await this.control.dispatchInput(page, method, params ?? {}, sessionId);
      live();
      return result;
    };
    /** @type {import("./model.js").PromiseBound} */
    const race = (promise) => Promise.race([promise, stopped]);
    const timeoutMs =
      command.method === "playwright" &&
      (command.action.name === "waitForEvent" || command.action.name === "downloadPath")
        ? Math.min(120000, command.action.timeoutMs ?? 3000) + 2000
        : 32000;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timeout = setTimeout(() => action.cancel(), timeoutMs);
    /** @type {Awaited<ReturnType<typeof acquireBackgroundSurface>>|undefined} */
    let surface;
    const restoreVisible = () =>
      this.workspace.pageStillOwned(page) &&
      page.control === "agent" &&
      page.controlEpoch === epoch &&
      this.presentation.owner ===
        pageKey(page.coreInstanceId, page.projectId, page.threadId, page.id) &&
      page.requestedVisible &&
      !this.presentation.suppressedPresentation;
    const acquireSurface = async () => {
      if (surface) return;
      page.commandSurface = true;
      const bounds =
        (command.method === "recordingStart" ? command.options?.viewport : null) ??
        page.commandViewport ??
        page.view.getBounds();
      surface = await acquireBackgroundSurface({
        owner: this.presentation.window,
        view: page.view,
        viewport: { width: bounds.width || 1280, height: bounds.height || 720 },
        signal: controller.signal,
        restoreVisible,
      });
      if (page.viewportScale !== undefined) {
        c.disableDeviceEmulation();
        page.viewportScale = undefined;
        page.emulationKey = undefined;
      }
    };
    /** @param {string} url */
    const navigate = async (url) => {
      live();
      const targetUrl = url === "about:blank" ? url : webUrl(url);
      if (targetUrl !== "about:blank" && !page.networkPolicy.allowApprovedNavigation(targetUrl))
        throw new Error("not_sent");
      page.document?.revoke();
      page.approvedNavigation = targetUrl;
      action.dispatched = true;
      await loadNavigationDocument(c, targetUrl, stopped);
    };
    /** @type {import("./model.js").ControlledView} */
    const view = {
      webContents: {
        loadURL: navigate,
        getURL: () => {
          live();
          return c.getURL();
        },
        getTitle: () => {
          live();
          return c.getTitle();
        },
        canGoBack: () => c.navigationHistory.canGoBack(),
        canGoForward: () => c.navigationHistory.canGoForward(),
        goBack: () => {
          live();
          page.document?.revoke();
          page.approvedNavigation =
            c.navigationHistory.getAllEntries()[c.navigationHistory.getActiveIndex() - 1]?.url;
          action.dispatched = true;
          c.navigationHistory.goBack();
        },
        goForward: () => {
          live();
          page.document?.revoke();
          page.approvedNavigation =
            c.navigationHistory.getAllEntries()[c.navigationHistory.getActiveIndex() + 1]?.url;
          action.dispatched = true;
          c.navigationHistory.goForward();
        },
        reload: () => {
          live();
          page.approvedNavigation = c.getURL();
          action.dispatched = true;
          c.reload();
        },
        executeJavaScript: (script) => {
          live();
          if (browserCommandMutates(command)) action.dispatched = true;
          return race(c.executeJavaScript(script, true));
        },
      },
      cdp: {
        send: async (method, params, sessionId) => {
          if (params !== undefined && !isCommandParameters(params)) throw new Error("not_sent");
          live();
          if (method.startsWith("Input.") || method === "Page.handleJavaScriptDialog")
            action.dispatched = true;
          const result = await this.control.dispatchInput(page, method, params ?? {}, sessionId);
          live();
          return result;
        },
      },
      normalizeScreenshotToCssPixels: true,
      captureViewportScreenshot: async () => {
        await acquireSurface();
        live();
        return (await race(c.capturePage())).toPNG().toString("base64");
      },
      resizeScreenshotToCssPixels: (base64, size) =>
        require("electron")
          .nativeImage.createFromBuffer(Buffer.from(base64, "base64"))
          .resize({ ...size, quality: "best" })
          .toPNG()
          .toString("base64"),
    };
    const cleanup = async () => {
      clearTimeout(timeout);
      surface?.release();
      page.commandSurface = false;
      if (
        this.workspace.pageStillOwned(page) &&
        page.view?.webContents === c &&
        !c.isDestroyed() &&
        page.presentationBounds
      )
        this.presentation.layout(page, page.presentationBounds);
      if (page.activeAction === action) page.activeAction = null;
      if (
        this.workspace.pageStillOwned(page) &&
        page.control === "agent" &&
        page.controlEpoch === epoch
      ) {
        if (page.inputPending.size || page.heldKeys.size || page.heldButtons.size)
          this.control.revoke(page);
        else page.view?.setVisible(restoreVisible());
      }
    };
    try {
      if (this.presentation.window.isFocused() && c.isFocused()) {
        this.human_input.nativeInputOwner = page.id;
        this.presentation.window.webContents.focus();
      }
      page.view.setVisible(false);
      if (!c.debugger.isAttached()) c.debugger.attach("1.3");
      await race(send("Page.enable"));
      const pageMethod =
        ![
          "browserViewportSet",
          "browserViewportReset",
          "handleDialog",
          "playwrightWaitForTimeout",
        ].includes(command.method) &&
        !(
          command.method === "playwright" &&
          ["downloadPath", "waitForEvent", "fileChooserSetFiles"].includes(command.action.name)
        );
      if (pageMethod) {
        if (command.method !== "navigate") await acquireSurface();
        await race(this.assertCommandPrivacy(page, send));
      }
      if (command.method === "browserViewportSet" || command.method === "browserViewportReset") {
        action.dispatched = true;
        page.commandViewport =
          command.method === "browserViewportSet"
            ? { width: command.width, height: command.height }
            : null;
        this.presentation.layout(page, page.presentationBounds ?? page.view.getBounds());
        page.viewportRevision++;
        invalidateActionObservation(page);
        return done({ ok: true, value: { viewport: page.commandViewport } });
      }
      if (command.method === "playwrightWaitForTimeout") {
        await race(waitForDelay(command.timeoutMs, controller.signal));
        return done({ ok: true });
      }
      if (
        command.method === "playwright" &&
        (command.action.name === "waitForEvent" || command.action.name === "downloadPath") &&
        (command.action.name === "downloadPath" || command.action.event !== "filechooser")
      ) {
        const argument = command.action;
        const found = () =>
          argument.name === "downloadPath"
            ? page.commandDownloads.get(argument.downloadId)
            : [...page.commandDownloads.values()].find((item) => !item.consumed);
        const state = await race(
          waitForCondition(
            () => {
              const item = found();
              return !!item && (argument.name !== "downloadPath" || item.state !== "pending");
            },
            Math.min(120000, argument.timeoutMs ?? 3000),
            controller.signal,
          ),
        );
        if (state !== "matched")
          return done({
            ok: false,
            error: {
              code: state === "cancelled" ? "cancelled" : "timeout",
              message: "Download wait did not complete",
            },
          });
        const item = found();
        if (!item) throw new Error("plan_stale");
        item.consumed = true;
        return argument.name === "waitForEvent"
          ? done({ ok: true, value: { id: item.id } })
          : item.state === "completed"
            ? done({ ok: true, value: item.path })
            : done({
                ok: false,
                error: { code: "execution_error", message: `Download ${item.state}` },
              });
      }
      if (command.method === "recordingStart") {
        clearTimeout(timeout);
        timeout = undefined;
        await acquireSurface();
        const options = command.options ?? {},
          viewport = options.viewport ?? page.commandViewport ?? page.view.getBounds();
        if (options.viewport)
          await send("Emulation.setDeviceMetricsOverride", {
            width: viewport.width,
            height: viewport.height,
            deviceScaleFactor: 1,
            mobile: false,
          });
        /** @type {import("./model.js").Recording} */
        const entry = {
          id: randomUUID(),
          status: "running",
          phase: "preparing",
          startedAt: Date.now(),
          controller,
          action,
          promise: null,
          artifact: null,
          error: null,
        };
        page.commandRecordings ??= new Map();
        page.commandRecordings.set(entry.id, entry);
        page.commandRecording = entry;
        const scenario = new RecordingScenario();
        action.dispatched = true;
        entry.promise = (async () => {
          const duration = setTimeout(
            () => controller.abort(new DOMException("Recording duration exceeded", "TimeoutError")),
            options.maxDurationMs ?? 30000,
          );
          try {
            if (options.showCursor !== false)
              await scenario.installRecordingCursorOverlay(view.webContents);
            entry.artifact = await recordBrowserVideo({
              targetFrame: c.mainFrame,
              tempRoot: this.commandArtifactRoot(page),
              recordingId: entry.id,
              viewport: { width: viewport.width || 1280, height: viewport.height || 720 },
              fps: options.fps ?? 30,
              signal: controller.signal,
              createRecorder: createElectronBrowserWebmRecorder,
              onPhase: (phase) => {
                entry.phase = phase;
              },
              onCaptureComplete: () => clearTimeout(duration),
              executeScenario: async () => {
                if (options.settleMs && !(await waitForDelay(options.settleMs, controller.signal)))
                  throw new Error("cancelled");
                await scenario.executeRecordingActions(
                  view,
                  options.actions ?? [],
                  controller.signal,
                  viewport,
                );
              },
            });
            entry.status = "completed";
            entry.phase = "completed";
          } catch (error) {
            entry.status = controller.signal.aborted ? "cancelled" : "failed";
            entry.phase = entry.status;
            entry.error = error instanceof Error ? error.message : String(error);
          } finally {
            clearTimeout(duration);
            entry.finishedAt = Date.now();
            if (!controller.signal.aborted)
              await scenario.removeRecordingCursorOverlay(view.webContents).catch(() => {});
            if (
              options.viewport &&
              this.workspace.pageStillOwned(page) &&
              page.control === "agent" &&
              page.controlEpoch === epoch &&
              !c.isDestroyed()
            ) {
              const previous = page.commandViewport;
              await this.control
                .dispatchInput(
                  page,
                  previous
                    ? "Emulation.setDeviceMetricsOverride"
                    : "Emulation.clearDeviceMetricsOverride",
                  previous ? { ...previous, deviceScaleFactor: 1, mobile: false } : {},
                )
                .catch(() => this.control.revoke(page));
            }
            if (page.commandRecording === entry) page.commandRecording = null;
            await cleanup();
          }
        })();
        return done({ ok: true, recording: this.commandRecordingStatus(entry) });
      }
      if (
        command.method === "screenshot" ||
        (command.method === "playwright" && command.action.name === "elementScreenshot")
      )
        await acquireSurface();
      if (browserCommandMutates(command)) {
        action.dispatched = true;
        page.commandDownloadIntent = {
          controlEpoch: epoch,
          pageGeneration: generation,
          expiresAt: Date.now() + DOWNLOAD_INTENT_MS,
        };
      }
      const commandResult = await race(
        executeBrowserCommandOnView(view, command, { signal: controller.signal }),
      );
      live();
      if (pageMethod && commandResult.ok && !browserCommandMutates(command))
        await race(this.assertCommandPrivacy(page, send));
      if (action.dispatched && !commandResult.ok && commandResult.error?.sideEffect !== "none")
        throw new Error("outcome_unknown", { cause: new Error(commandResult.error?.message) });
      if (browserCommandMutates(command)) invalidateActionObservation(page);
      return { commandResult };
    } catch (error) {
      if (action.dispatched) throw new Error("outcome_unknown", { cause: error });
      if (controller.signal.aborted) throw new Error("not_sent");
      throw error;
    } finally {
      if (!page.commandRecording || page.commandRecording.action !== action) await cleanup();
    }
  }

  /**
   * @param {import('./model.js').LivePage} page
   * @param {import('./model.js').CdpSend} send
   */
  async assertCommandPrivacy(page, send) {
    const c = page.view.webContents;
    await send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "iframe", exclude: false }, { exclude: true }],
    });
    const frames = new Map();
    /** @param {import("./model.js").CdpFrameTree} node @param {string} [sessionId] */
    const visit = (node, sessionId) => {
      frames.set(node.frame.id, { frame: node.frame, sessionId });
      for (const child of node.childFrames ?? []) visit(child, sessionId);
    };
    visit((await send("Page.getFrameTree")).frameTree);
    for (const sessionId of page.commandFrameSessions.values())
      visit((await send("Page.getFrameTree", {}, sessionId)).frameTree, sessionId);
    if (frames.size > 32 || frames.size !== c.mainFrame.framesInSubtree.length)
      throw new Error("human_takeover_required");
    for (const { frame, sessionId } of frames.values()) {
      const world = await send(
        "Page.createIsolatedWorld",
        { frameId: frame.id, worldName: "areal-command-privacy" },
        sessionId,
      );
      const result = await send(
        "Runtime.evaluate",
        {
          expression: sensitiveCaptureScript(false),
          contextId: world.executionContextId,
          returnByValue: true,
        },
        sessionId,
      );
      if (result.result?.value !== false) throw new Error("human_takeover_required");
    }
  }
}

module.exports = { NativeCommandExecution };

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function isCommandParameters(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
