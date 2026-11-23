import type {
  BrowserWindow,
  Event as ElectronEvent,
  IpcMainEvent,
  MessageBoxOptions,
  MessageBoxReturnValue,
  WebContents,
  WebFrameMain,
} from "electron";

const { nativeText } =
  require("@areal/workbench/node/native-i18n") as typeof import("@areal/workbench/node/native-i18n");
const { modelRecord } =
  require("@areal/workbench/core-model-contract") as typeof import("@areal/workbench/core-model-contract");

export type QuitIntent = "application" | "stop" | "install" | "relaunch";
export type QuitPhase = "checking" | "stopping" | "finishing" | null;
export type QuitResult =
  | import("@areal/workbench/desktop-contract/desktop-control").LifecycleResult
  | { kind?: string; canceled: boolean }
  | { stopped: boolean; quitting: true };

export interface QuitAttempt {
  id: number;
  intent: QuitIntent;
  relaunchExecPath?: string;
  owner: WebContents | null;
  frame: WebFrameMain | null;
  decide:
    | ((decision: { allowed: boolean; forced?: boolean; noSubscriber?: boolean }) => void)
    | null;
  reprompt: (() => void) | null;
  approved: boolean;
  rendererApproved: boolean;
  forceDiscardUnload: boolean;
  skipWindowSettle: boolean;
  phase: QuitPhase;
  startedAt: number;
  promise: Promise<QuitResult>;
}

export interface QuitCoordinatorOptions {
  app: Pick<import("electron").App, "isPackaged" | "getPath" | "quit" | "relaunch" | "exit">;
  dialog: Pick<import("electron").Dialog, "showMessageBox">;
  diagnostics: Pick<typeof import("@areal/workbench/node/diagnostics"), "record">;
  showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
  confirmHostQuit: typeof import("./host-quit.cjs").confirmHostQuit;
  confirmHostStop: typeof import("./host-quit.cjs").confirmHostStop;
  sendDesktopEvent: typeof import("./desktop-ipc.cjs").sendDesktopEvent;
  getWindow: () => BrowserWindow | undefined;
  isRendererAlive: () => boolean;
  isRendererResponsive: () => boolean;
  hasPreloadFailed?: () => boolean;
  isPreloadActive?: () => boolean;
  preloadReplyTimeoutMs?: number;
  revealWindow: (options?: { checkBundle?: boolean }) => void;
  announceWindowOpened: () => void;
  settleWindow: (owner: BrowserWindow) => Promise<void>;
  getBackend: () =>
    | InstanceType<typeof import("./service-client.cjs").SharedCoreBackend>
    | undefined;
  getPreview: () => InstanceType<typeof import("./preview.cjs").CorePreview> | undefined;
  releasePackageForInstall?: (params: {
    backend: unknown;
    packaged: boolean;
    profile: string;
  }) => Promise<void>;
  platform?: string;
}

/**
 * 显式退出与重拉协调器：
 * 1. 先同步登记 quitAttempt 与 promise，再执行任何回调，杜绝普通退出与覆盖重拉并发夺权。
 * 2. preload 显式区分 noSubscriber（未挂载草稿保护）与用户拒绝，黑屏时绝不静默取消 ⌘Q。
 * 3. 已挂载窗口暂时无响应时弹出原生“继续等待 / 放弃未保存修改并退出”，绝不静默丢弃草稿。
 * 4. 覆盖安装重拉由协调器独占最终 relaunch/exit，只有本次重拉清理成功才重启，取消或失败保留旧进程。
 */
export function createQuitCoordinator(options: QuitCoordinatorOptions) {
  const platform = options.platform ?? process.platform;
  let quitting = false;
  let exitReady = false;
  let quitRequestSequence = 0;
  let quitAttempt: QuitAttempt | null = null;

  function isQuitting() {
    return quitting;
  }

  function isExitReady() {
    return exitReady;
  }

  function getQuitAttempt() {
    return quitAttempt;
  }

  function isBusy() {
    return quitting || exitReady || Boolean(quitAttempt);
  }

  function hasActiveQuitPhase() {
    return Boolean(quitAttempt?.phase);
  }

  function shouldPreventUnload(webContents: WebContents) {
    return Boolean(
      exitReady &&
      quitAttempt?.approved &&
      (quitAttempt.rendererApproved || quitAttempt.forceDiscardUnload) &&
      quitAttempt.owner === webContents &&
      quitAttempt.frame === webContents.mainFrame,
    );
  }

  function confirmForceDiscard(
    reason: "unresponsive" | "preloadFailed" | "noResponse",
  ): Promise<boolean> {
    const message = reason === "unresponsive" ? "界面暂时无响应" : "界面未能响应退出确认";
    const detail =
      reason === "unresponsive"
        ? "正在等待界面确认未保存修改。你可以继续等待恢复，或放弃未保存修改并直接退出。"
        : "桌面桥接脚本未返回退出确认，无法自动核对未保存修改。你可以继续等待，或放弃未保存修改并直接退出。";
    return options.dialog
      .showMessageBox({
        type: "warning",
        buttons: ["继续等待", "放弃未保存修改并退出"],
        defaultId: 0,
        cancelId: 0,
        message,
        detail,
      })
      .then((answer) => answer.response === 1)
      .catch(() => false);
  }

  function confirmRendererQuit(attempt: QuitAttempt): Promise<boolean> {
    const window = options.getWindow();
    if (!window || window.isDestroyed()) {
      attempt.skipWindowSettle = true;
      return Promise.resolve(attempt.intent !== "install");
    }
    const owner = window.webContents;
    const frame = owner.mainFrame;
    if (
      owner.isDestroyed() ||
      !frame.url.startsWith("areal-ui://app/") ||
      !options.isRendererAlive()
    ) {
      // 未加载成功/已崩溃窗口不存在未保存表单草稿，允许用户退出或重拉新版。
      attempt.skipWindowSettle = true;
      return Promise.resolve(attempt.intent !== "install");
    }
    attempt.owner = owner;
    attempt.frame = frame;
    return new Promise((resolveDecision) => {
      let promptOpen = false;
      let noPreloadTimer: ReturnType<typeof setTimeout> | null = null;
      const cancel = () => finish({ allowed: false });
      const onGone = () => {
        attempt.skipWindowSettle = true;
        finish({ allowed: attempt.intent !== "install", forced: attempt.intent !== "install" });
      };
      const promptNativeFallback = (reason: "unresponsive" | "preloadFailed" | "noResponse") => {
        if (attempt.intent === "install" || promptOpen || attempt.decide !== finish) return;
        promptOpen = true;
        void confirmForceDiscard(reason).then((discard) => {
          promptOpen = false;
          if (attempt.decide !== finish) return;
          if (discard) {
            attempt.skipWindowSettle = true;
            finish({ allowed: true, forced: true });
          }
        });
      };
      const onUnresponsive = () => promptNativeFallback("unresponsive");
      const onNavigate = () => cancel();
      const finish = (decision: { allowed: boolean; forced?: boolean; noSubscriber?: boolean }) => {
        if (attempt.decide !== finish) return;
        attempt.decide = null;
        attempt.reprompt = null;
        if (noPreloadTimer) {
          clearTimeout(noPreloadTimer);
          noPreloadTimer = null;
        }
        owner.removeListener("destroyed", onGone);
        owner.removeListener("render-process-gone", onGone);
        owner.removeListener("did-navigate", onNavigate);
        window.removeListener("unresponsive", onUnresponsive);
        if (decision.allowed) {
          if (decision.forced) attempt.forceDiscardUnload = true;
          else attempt.rendererApproved = true;
        }
        if (decision.noSubscriber) attempt.skipWindowSettle = true;
        resolveDecision(decision.allowed);
      };
      attempt.decide = finish;
      attempt.reprompt = () => {
        if (attempt.decide !== finish) return;
        if (!options.isRendererResponsive()) {
          promptNativeFallback("unresponsive");
          return;
        }
        if (options.hasPreloadFailed?.()) {
          promptNativeFallback("preloadFailed");
          return;
        }
        options.revealWindow({ checkBundle: false });
        // preload 静默失效时页面仍保持 responsive；用户再次按 ⌘Q 时允许重新选择等待或放弃退出。
        if (options.isPreloadActive && !options.isPreloadActive()) {
          promptNativeFallback("noResponse");
        }
      };
      owner.once("destroyed", onGone);
      owner.once("render-process-gone", onGone);
      owner.on("did-navigate", onNavigate);
      window.on("unresponsive", onUnresponsive);
      // 退出确认期间的 reveal 不能重入触发 bundleGuard 重拉。
      options.revealWindow({ checkBundle: false });
      options.sendDesktopEvent(owner, "areal-core:quit-request", attempt.id);
      if (!options.isRendererResponsive()) {
        promptNativeFallback("unresponsive");
      } else if (options.hasPreloadFailed?.()) {
        promptNativeFallback("preloadFailed");
      } else if (options.isPreloadActive && !options.isPreloadActive()) {
        const timeoutMs = options.preloadReplyTimeoutMs ?? 1500;
        noPreloadTimer = setTimeout(() => {
          noPreloadTimer = null;
          if (attempt.decide === finish && !options.isPreloadActive?.()) {
            promptNativeFallback("noResponse");
          }
        }, timeoutMs);
        noPreloadTimer.unref?.();
      }
    });
  }

  function setQuitProgress(attempt: QuitAttempt, phase: QuitPhase) {
    if (quitAttempt !== attempt || attempt.intent === "install") return;
    attempt.phase = phase;
    if (attempt.owner && !attempt.owner.isDestroyed() && attempt.owner.mainFrame === attempt.frame)
      options.sendDesktopEvent(
        attempt.owner,
        "areal-core:quit-progress",
        phase ? { state: "quitting", phase } : { state: "idle" },
      );
  }

  function recordQuitStage(
    attempt: QuitAttempt,
    stage: Extract<
      import("@areal/workbench/node/diagnostics").Incident,
      { type: "quit-stage" }
    >["stage"],
  ) {
    if (quitAttempt !== attempt) return;
    options.diagnostics.record({
      type: "quit-stage",
      attempt: attempt.id,
      elapsedMs: Math.floor(performance.now() - attempt.startedAt),
      stage,
    });
  }

  function handleQuitDecision(event: IpcMainEvent, decision: unknown) {
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
    const noSubscriber = decision.reason === "noSubscriber";
    if (noSubscriber) {
      attempt.decide({
        allowed: attempt.intent !== "install",
        noSubscriber: true,
      });
      return;
    }
    attempt.decide({ allowed: decision.allowed });
  }

  function requestQuit(
    intent: QuitIntent = "application",
    relaunchExecPath?: string,
  ): Promise<QuitResult> {
    if (quitAttempt) {
      if (intent !== "install") quitAttempt.reprompt?.();
      return quitAttempt.promise;
    }
    if (quitting || exitReady) return Promise.resolve({ canceled: true });
    let resolveAttempt!: (value: QuitResult) => void;
    let rejectAttempt!: (reason?: unknown) => void;
    const promise = new Promise<QuitResult>((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
    const attempt: QuitAttempt = {
      id: ++quitRequestSequence,
      intent,
      relaunchExecPath,
      owner: null,
      frame: null,
      decide: null,
      reprompt: null,
      approved: false,
      rendererApproved: false,
      forceDiscardUnload: false,
      skipWindowSettle: false,
      phase: null,
      startedAt: performance.now(),
      promise,
    };
    // 在任何同步回调前先登记本次 attempt 及其 Promise，防止重入覆盖。
    quitAttempt = attempt;

    const beginQuit = (phase: QuitPhase) => {
      attempt.approved = true;
      quitting = true;
      if (intent !== "install") options.getPreview()?.setPresentationSuppressed(true);
      setQuitProgress(attempt, phase);
    };

    const notify = async (messageOptions: MessageBoxOptions) => {
      recordQuitStage(attempt, "native-confirmation");
      setQuitProgress(attempt, null);
      return platform === "darwin" && intent !== "install"
        ? options.dialog.showMessageBox(messageOptions)
        : options.showMessageBox(messageOptions);
    };

    const runQuit = async (): Promise<QuitResult> => {
      const backend = options.getBackend();
      if (!backend) {
        if (intent === "install") throw new Error(nativeText("lifecycle.preparing"));
        beginQuit("finishing");
        await options.getPreview()?.dispose();
        exitReady = true;
        recordQuitStage(attempt, "exit-ready");
        if (intent === "relaunch") {
          options.app.relaunch(relaunchExecPath ? { execPath: relaunchExecPath } : undefined);
          options.app.exit(0);
        } else {
          setImmediate(() => options.app.quit());
        }
        return { stopped: false, quitting: true };
      }
      if (!(await confirmRendererQuit(attempt))) {
        recordQuitStage(attempt, "canceled");
        return { canceled: true };
      }
      if (quitting) {
        recordQuitStage(attempt, "canceled");
        return { canceled: true };
      }
      const window = options.getWindow();
      if (intent === "install" && (!window || window.isDestroyed())) return { canceled: true };
      // 检查和窗口清理也可能等待；先反馈，但保留清理所需的 IPC 准入。
      if (intent !== "install") {
        options.getPreview()?.setPresentationSuppressed(true);
        setQuitProgress(attempt, "checking");
        recordQuitStage(attempt, "checking");
      }
      if (window && !window.isDestroyed() && !attempt.skipWindowSettle) {
        await options.settleWindow(window);
      }
      if (intent === "install") {
        beginQuit("checking");
        recordQuitStage(attempt, "checking");
      }
      recordQuitStage(attempt, "readiness");
      await backend.waitForApplicationReady();
      let stopped = intent === "install";
      if (intent === "relaunch") {
        beginQuit("finishing");
      } else if (intent !== "install") {
        const confirm = intent === "stop" ? options.confirmHostStop : options.confirmHostQuit;
        const decision = await confirm(backend, notify, () => {
          beginQuit("stopping");
          recordQuitStage(attempt, "stop");
        });
        if ("canceled" in decision) {
          recordQuitStage(attempt, "canceled");
          return { canceled: true };
        }
        stopped = "stopped" in decision && decision.stopped === true;
        beginQuit("finishing");
      } else {
        recordQuitStage(attempt, "reconcile");
        await backend.checkLifecycle();
        if (!backend.serviceExited && backend.status.connected) {
          recordQuitStage(attempt, "stop");
          const result = await options.confirmHostStop(backend, notify, () => {
            beginQuit("stopping");
            recordQuitStage(attempt, "stop");
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
        }
      }
      setQuitProgress(attempt, "finishing");
      recordQuitStage(attempt, "terminal");
      await backend.prepareQuit();
      if (intent === "install") {
        const release =
          options.releasePackageForInstall ??
          (require("../../update/package-users.cjs").releasePackageForInstall as NonNullable<
            QuitCoordinatorOptions["releasePackageForInstall"]
          >);
        await release({
          backend,
          packaged: options.app.isPackaged,
          profile: options.app.getPath("userData"),
        });
      }
      recordQuitStage(attempt, "finalizing");
      // 已确认停止的 Host 不再接受后台保留策略，退出时也不能把它交给后继代际。
      if (intent === "install" || !stopped) {
        await backend.completeApplicationQuit({ keepBackground: intent !== "install" });
      }
      recordQuitStage(attempt, "disconnect");
      await backend.shutdown();
      await options.getPreview()?.dispose();
      exitReady = true;
      recordQuitStage(attempt, "exit-ready");
      if (intent === "relaunch") {
        options.app.relaunch(relaunchExecPath ? { execPath: relaunchExecPath } : undefined);
        options.app.exit(0);
      } else if (intent !== "install") {
        setImmediate(() => options.app.quit());
      }
      return { stopped, quitting: true };
    };

    const cleanup = () => {
      if (!exitReady && quitAttempt === attempt) {
        options.announceWindowOpened();
        if (attempt.approved) quitting = false;
        setQuitProgress(attempt, null);
        if (intent !== "install") options.getPreview()?.setPresentationSuppressed(false);
        quitAttempt = null;
      }
    };

    void runQuit().then(
      (result) => {
        cleanup();
        resolveAttempt(result);
      },
      (error) => {
        recordQuitStage(attempt, "failed");
        cleanup();
        rejectAttempt(error);
      },
    );

    return promise;
  }

  function handleBeforeQuit(event: ElectronEvent) {
    if (exitReady) return;
    event.preventDefault();
    if (quitting) return;
    void requestQuit().catch((error) => {
      options.getBackend()?.reportLifecycleError(error);
      if (options.isRendererAlive() && options.isRendererResponsive()) {
        options.revealWindow({ checkBundle: false });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        void options.dialog.showMessageBox({
          type: "warning",
          message: nativeText("gui.startupFailed"),
          detail: message,
        });
      }
    });
  }

  return {
    isQuitting,
    isExitReady,
    isBusy,
    getQuitAttempt,
    hasActiveQuitPhase,
    shouldPreventUnload,
    handleQuitDecision,
    requestQuit,
    requestStopAndQuit: () => requestQuit("stop"),
    requestRelaunchQuit: (execPath: string) => requestQuit("relaunch", execPath),
    handleBeforeQuit,
  };
}
