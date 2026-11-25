import type {
  BrowserWindow,
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
  WebFrameMain,
} from "electron";
import { join } from "node:path";

const { startupTrace } =
  require("@areal/workbench/node/startup-timing") as typeof import("@areal/workbench/node/startup-timing");
const { nativeText } =
  require("@areal/workbench/node/native-i18n") as typeof import("@areal/workbench/node/native-i18n");
const { WindowCloseGate } =
  require("../../ipc/generated/window-close.cjs") as typeof import("../ipc/window-close.js");

export interface WindowControllerOptions {
  BrowserWindow: typeof import("electron").BrowserWindow;
  diagnostics: typeof import("@areal/workbench/node/diagnostics");
  sendDesktopEvent: typeof import("./desktop-ipc.cjs").sendDesktopEvent;
  preloadPath?: string;
  isQuitting: () => boolean;
  isExitReady: () => boolean;
  hasActiveQuitPhase: () => boolean;
  shouldPreventUnload: (contents: WebContents) => boolean;
  onBeforeReveal?: () => boolean;
  onDidFailLoad?: () => boolean;
  onWindowBlur?: () => void;
  onRendererReset?: () => void;
  onDisposePreview?: () => Promise<void>;
  onReportLifecycleError?: (error: unknown) => void;
}

/**
 * 独占主窗口生命周期、首屏展示门控、渲染器加载状态与 IPC 来源校验。
 * 快照请求与首屏展示各自独立，不把“拉过快照”误判成“已挂载退出确认监听”。
 */
export function createWindowController(options: WindowControllerOptions) {
  const preloadPath = options.preloadPath ?? join(__dirname, "..", "preload.cjs");
  let window: BrowserWindow | undefined;
  let browserWindowClosed = false;
  let windowClosePromise: Promise<void> | null = null;
  let startupPresentation: "requested" | "presented" | "suppressed" = "requested";
  let startupPainted = false;
  let startupReady = false;
  let loadedFrame: WebFrameMain | null = null;
  let preloadFailedFrame: WebFrameMain | null = null;
  let preloadActiveFrame: WebFrameMain | null = null;
  let rendererResponsive = true;
  let focusRequested = false;
  let startupShowTrace: ReturnType<typeof startupTrace> | undefined;
  let startupPaintTrace: ReturnType<typeof startupTrace> | undefined;
  let startupPresentTrace: ReturnType<typeof startupTrace> | undefined;
  const nativeStateOwners = new WeakMap<WebContents, { frame: WebFrameMain; last?: string }>();

  const windowCloseGate = new WindowCloseGate((owner, id) =>
    options.sendDesktopEvent(owner, "areal-core:window-closing", id),
  );

  function getWindow() {
    return window;
  }

  function isBrowserWindowClosed() {
    return browserWindowClosed;
  }

  function isStartupPresented() {
    return startupPresentation === "presented";
  }

  /** 按当前已提交的主 frame 判断渲染页是否存活，避免被中止的临时导航误伤草稿页。 */
  function isRendererAlive() {
    if (!window || window.isDestroyed()) return false;
    const owner = window.webContents;
    if (owner.isDestroyed()) return false;
    const frame = owner.mainFrame;
    return (
      loadedFrame !== null &&
      frame === loadedFrame &&
      Boolean(frame?.url && frame.url.startsWith("areal-ui://app/"))
    );
  }

  function isRendererResponsive() {
    return rendererResponsive;
  }

  function hasPreloadFailed() {
    if (!window || window.isDestroyed()) return false;
    const owner = window.webContents;
    if (owner.isDestroyed()) return false;
    return preloadFailedFrame !== null && preloadFailedFrame === owner.mainFrame;
  }

  function isPreloadActive() {
    if (!window || window.isDestroyed()) return false;
    const owner = window.webContents;
    if (owner.isDestroyed()) return false;
    return preloadActiveFrame !== null && preloadActiveFrame === owner.mainFrame;
  }

  function markPresentReady() {
    startupReady = true;
    startupPresentTrace?.finish("ok");
    presentStartup();
  }

  function resetRendererState(owner?: WebContents) {
    loadedFrame = null;
    preloadFailedFrame = null;
    preloadActiveFrame = null;
    if (owner) nativeStateOwners.delete(owner);
    options.onRendererReset?.();
  }

  function announceWindowOpened() {
    if (window && !window.isDestroyed())
      options.sendDesktopEvent(window.webContents, "areal-core:window-opened");
  }

  async function settleWindow(owner: BrowserWindow) {
    // 普通关窗必须保留 window-closing 结算（确认 Host side.closeOwned），
    // 只有没有已提交存活主 frame 时才能跳过。
    if (!isRendererAlive()) return;
    if (!(await windowCloseGate.request(owner.webContents)))
      throw new Error("窗口资源尚未确认清理，请保留窗口并核对原操作");
  }

  function presentStartup() {
    if (
      startupPresentation !== "requested" ||
      options.isQuitting() ||
      windowClosePromise ||
      !window ||
      window.isDestroyed() ||
      !startupPainted ||
      !startupReady
    )
      return;
    startupPresentation = "presented";
    browserWindowClosed = false;
    window.show();
    if (focusRequested) {
      focusRequested = false;
      window.focus();
    }
  }

  function revealWindow(revealOptions?: { checkBundle?: boolean }) {
    if (options.isQuitting() || options.isExitReady()) return;
    if (revealOptions?.checkBundle !== false && options.onBeforeReveal?.()) return;
    if (windowClosePromise) {
      const owner = window;
      void windowClosePromise.then(() => {
        if (window === owner && owner && !owner.isDestroyed()) revealWindow(revealOptions);
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
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  function trustedSender(event: IpcMainEvent | IpcMainInvokeEvent) {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !event.senderFrame.url.startsWith("areal-ui://app/")
    )
      throw new Error(nativeText("boundary.untrustedSender"));
    preloadActiveFrame = event.senderFrame;
    return window;
  }

  function trusted(event: IpcMainEvent | IpcMainInvokeEvent) {
    if (options.isQuitting()) throw new Error(nativeText("boundary.quitting"));
    return trustedSender(event);
  }

  /** 先鉴权再执行 readNativeState，避免未授权请求触发 desktopSnapshot 副作用。 */
  function subscribeNativeState<T>(event: IpcMainInvokeEvent, readNativeState: () => T): T {
    const frame = trusted(event).webContents.mainFrame;
    const snapshot = readNativeState();
    const owner = { frame, last: JSON.stringify(snapshot) };
    nativeStateOwners.set(event.sender, owner);
    return snapshot;
  }

  function publishNativeState(readNativeState: () => unknown) {
    if (!window || window.isDestroyed()) return;
    const owner = window.webContents;
    const subscription = nativeStateOwners.get(owner);
    if (subscription?.frame !== owner.mainFrame) return;
    const snapshot = readNativeState();
    const fingerprint = JSON.stringify(snapshot);
    if (subscription.last === fingerprint) return;
    subscription.last = fingerprint;
    options.sendDesktopEvent(owner, "areal-core:native-state-changed", snapshot);
  }

  function decideWindowClose(event: IpcMainEvent, decision: unknown) {
    windowCloseGate.decide(event, decision);
  }

  async function createWindow(
    onCreated?: (createdWindow: BrowserWindow) => void,
  ): Promise<BrowserWindow> {
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
      loadedFrame = null;
      preloadFailedFrame = null;
      preloadActiveFrame = null;
      rendererResponsive = true;
      const createdWindow = (window = new options.BrowserWindow({
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
          preload: preloadPath,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      }));
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
      onCreated?.(createdWindow);
      createdWindow.on("unresponsive", () => {
        rendererResponsive = false;
        options.diagnostics.record({ type: "renderer-unresponsive" });
      });
      createdWindow.on("responsive", () => {
        rendererResponsive = true;
        options.diagnostics.record({ type: "renderer-responsive" });
      });
      createdWindow.on("blur", () => options.onWindowBlur?.());
      const owner = createdWindow.webContents;
      // 只有新文档真正提交（did-navigate）时才清除旧主 frame 状态；
      // 临时导航被 beforeunload 阻止或中止不会销毁既有草稿页。
      owner.on("did-navigate", () => {
        resetRendererState(owner);
      });
      owner.on("did-finish-load", () => {
        const frame = owner.mainFrame;
        loadedFrame = frame?.url?.startsWith("areal-ui://app/") ? frame : null;
        options.diagnostics.record({
          type: "window-ready",
          windows: options.BrowserWindow.getAllWindows().length,
        });
      });
      owner.on(
        "did-fail-load",
        (_event, _errorCode, _errorDescription, _validatedURL, isMainFrame) => {
          if (!isMainFrame) return;
          const currentFrame = owner.mainFrame;
          const committedFrameAlive =
            loadedFrame !== null &&
            currentFrame === loadedFrame &&
            Boolean(currentFrame?.url && currentFrame.url.startsWith("areal-ui://app/"));
          if (!committedFrameAlive) {
            resetRendererState(owner);
          }
          options.onDidFailLoad?.();
        },
      );
      owner.on("preload-error", (_event, _failedPreloadPath, error) => {
        preloadFailedFrame = owner.mainFrame;
        console.error("Desktop preload failed to load", error);
      });
      owner.on("console-message", (_event, _level, message) => {
        if (typeof message === "string" && message.startsWith("[startup-renderer] "))
          process.stderr.write(`${message}\n`);
      });
      owner.on("destroyed", () => resetRendererState(owner));
      owner.on("render-process-gone", () => resetRendererState(owner));
      owner.setWindowOpenHandler(() => ({ action: "deny" }));
      owner.on("will-navigate", (event) => event.preventDefault());
      owner.on("will-prevent-unload", (event) => {
        if (options.shouldPreventUnload(owner)) event.preventDefault();
      });
      createdWindow.on("show", () => {
        browserWindowClosed = false;
        announceWindowOpened();
      });
      createdWindow.on("close", (event) => {
        if (options.isExitReady()) return;
        event.preventDefault();
        if (options.isQuitting() || options.hasActiveQuitPhase() || windowClosePromise) return;
        // A close-to-background still ends this createdWindow's Browser ownership. Fence
        // native callbacks before hiding; reopening creates fresh Pages on demand.
        browserWindowClosed = true;
        if (startupPresentation !== "presented") {
          startupPresentation = "suppressed";
          focusRequested = false;
        }
        const closingOwner = createdWindow;
        windowClosePromise = settleWindow(closingOwner)
          .then(async () => {
            await options.onDisposePreview?.();
            if (!closingOwner.isDestroyed()) closingOwner.hide();
          })
          .catch((error) => {
            browserWindowClosed = false;
            announceWindowOpened();
            options.onReportLifecycleError?.(error);
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

  return {
    getWindow,
    isBrowserWindowClosed,
    isStartupPresented,
    isRendererAlive,
    isRendererResponsive,
    hasPreloadFailed,
    isPreloadActive,
    markPresentReady,
    resetRendererState,
    presentStartup,
    revealWindow,
    announceWindowOpened,
    settleWindow,
    decideWindowClose,
    trustedSender,
    trusted,
    subscribeNativeState,
    publishNativeState,
    createWindow,
  };
}
