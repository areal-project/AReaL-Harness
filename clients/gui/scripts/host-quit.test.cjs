"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  confirmHostQuit,
  confirmHostStop,
  hostActivityLabel,
} = require("../app/src/core/host-quit.cjs");
const { setNativeLocale } = require("@areal/workbench/node/native-i18n");
const { validateCommandResponse } = require("../packages/workbench/client/desktop-contract.cjs");

const operation = { requestId: "stop-request", kind: "stopHost", phase: "completed", targets: [] };

function fixture(activity, choices = []) {
  const dialogs = [];
  const stops = [];
  return {
    dialogs,
    stops,
    backend: {
      readHostActivity: async () => {
        if (activity instanceof Error) throw activity;
        return activity;
      },
      requestHostStop: async (request) => {
        stops.push(request);
        return { stopped: true, operation, receipt: { private: true } };
      },
    },
    notify: async (options) => {
      dialogs.push(options);
      assert.ok(choices.length, "no unexpected native confirmation");
      return { response: choices.shift() };
    },
  };
}
const idle = {
  complete: true,
  projects: [{ projectId: "cli-only", state: "observed", activeTurns: 0, idleAllowed: true }],
  totalActiveTasks: 0,
};
const active = {
  complete: true,
  projects: [{ projectId: "cli-only", state: "observed", activeTurns: 1, idleAllowed: false }],
  totalActiveTasks: 0,
};

function quitFixture(overrides = {}) {
  const { EventEmitter } = require("node:events");
  const { createQuitCoordinator } = require("../app/src/core/generated/quit-coordinator.cjs");
  const events = [];
  const suppressed = [];
  const relaunched = [];
  const exited = [];
  const dialogs = [];
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  const frame = { url: "areal-ui://app/" };
  const owner = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    mainFrame: frame,
  });
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: owner,
  });
  let alive = overrides.alive ?? true;
  let responsive = overrides.responsive ?? true;
  let preloadFailed = overrides.preloadFailed ?? false;
  let preloadActive = overrides.preloadActive ?? true;
  let quitCalls = 0;
  let shutdownCalls = 0;
  let prepareQuitCalls = 0;
  let completeQuitCalls = [];
  let settleWindowCalls = 0;
  let customSettleWindow = async () => {
    settleWindowCalls++;
  };
  const dialogResponses = Array.isArray(overrides.dialogResponses)
    ? [...overrides.dialogResponses]
    : null;
  const coordinator = createQuitCoordinator({
    app: {
      isPackaged: false,
      getPath: () => "/tmp/areal-quit-test",
      quit: () => {
        quitCalls++;
      },
      relaunch: (opts) => {
        relaunched.push(opts);
      },
      exit: (code) => {
        exited.push(code);
      },
    },
    dialog: {
      showMessageBox: async (opts) => {
        dialogs.push(opts);
        if (dialogResponses?.length) return { response: dialogResponses.shift() };
        if (overrides.assertIdleBeforeDialog !== false) {
          assert.equal(
            events.at(-1)?.value?.state,
            "idle",
            "native confirmation replaces progress",
          );
        }
        return { response: overrides.dialogResponse ?? 2 };
      },
    },
    showMessageBox: async (opts) => {
      dialogs.push(opts);
      if (dialogResponses?.length) return { response: dialogResponses.shift() };
      if (overrides.assertIdleBeforeDialog !== false) {
        assert.equal(events.at(-1)?.value?.state, "idle", "native confirmation replaces progress");
      }
      return { response: overrides.dialogResponse ?? 2 };
    },
    diagnostics: { record: () => {} },
    confirmHostQuit: overrides.confirmHostQuit ?? confirmHostQuit,
    confirmHostStop: overrides.confirmHostStop ?? confirmHostStop,
    sendDesktopEvent: (target, channel, value) => {
      events.push({ channel, value });
      if (channel === "areal-core:quit-request") {
        if (overrides.rendererReply) {
          queueMicrotask(() => {
            coordinator.handleQuitDecision(
              { sender: target, senderFrame: frame },
              { id: value, ...overrides.rendererReply },
            );
          });
        } else if (overrides.autoAllowRenderer !== false) {
          queueMicrotask(() => {
            coordinator.handleQuitDecision(
              { sender: target, senderFrame: frame },
              { id: value, allowed: true },
            );
          });
        }
      }
    },
    getWindow: () => (overrides.noWindow ? undefined : win),
    isRendererAlive: () => alive,
    isRendererResponsive: () => responsive,
    hasPreloadFailed: () => preloadFailed,
    isPreloadActive: () => preloadActive,
    preloadReplyTimeoutMs: overrides.preloadReplyTimeoutMs,
    revealWindow: (opts) => {
      overrides.onReveal?.(opts);
    },
    announceWindowOpened: () => events.push({ channel: "opened" }),
    settleWindow: async (ownerWin) => customSettleWindow(ownerWin),
    getBackend: () =>
      overrides.noBackend
        ? undefined
        : {
            waitForApplicationReady: () => (overrides.immediateReady ? Promise.resolve() : ready),
            readHostActivity: async () => overrides.activity ?? active,
            prepareQuit: async () => {
              prepareQuitCalls++;
              if (overrides.prepareQuitError) throw overrides.prepareQuitError;
            },
            completeApplicationQuit: async (opts) => {
              completeQuitCalls.push(opts);
            },
            shutdown: async () => {
              shutdownCalls++;
            },
            reportLifecycleError: () => {},
          },
    getPreview: () => ({
      setPresentationSuppressed: (value) => suppressed.push(value),
      dispose: async () => {},
    }),
  });
  return {
    coordinator,
    context: {
      requestQuit: (intent, execPath) => coordinator.requestQuit(intent, execPath),
      get settleWindow() {
        return customSettleWindow;
      },
      set settleWindow(fn) {
        customSettleWindow = fn;
      },
      get quitting() {
        return coordinator.isQuitting();
      },
      get quitAttempt() {
        return coordinator.getQuitAttempt();
      },
      get exitReady() {
        return coordinator.isExitReady();
      },
    },
    owner,
    win,
    frame,
    events,
    dialogs,
    release,
    suppressed,
    relaunched,
    exited,
    setAlive: (v) => {
      alive = v;
    },
    setResponsive: (v) => {
      responsive = v;
    },
    counts: () => ({
      quitCalls,
      shutdownCalls,
      prepareQuitCalls,
      completeQuitCalls,
      settleWindowCalls,
    }),
  };
}

test("quit reports checking before backend readiness and cancels back to idle", async () => {
  const f = quitFixture();
  const pending = f.context.requestQuit();
  await new Promise(setImmediate);
  assert.ok(
    f.events.some((event) => event.value?.phase === "checking"),
    "a pending backend must not leave quit without feedback",
  );
  assert.equal(f.context.requestQuit(), pending, "repeated quit joins the same attempt");
  f.release();
  assert.equal((await pending).canceled, true);
  assert.equal(f.events.at(-1).value.state, "idle");
  assert.equal(f.context.quitting, false);
  assert.equal(f.context.quitAttempt, null);
  assert.deepEqual(f.suppressed, [true, false]);
});

test("quit shows feedback before window cleanup and restores presentation on failure", async () => {
  const f = quitFixture();
  let fail;
  f.context.settleWindow = () =>
    new Promise((_resolve, reject) => {
      fail = reject;
    });
  const pending = f.context.requestQuit();
  await new Promise(setImmediate);
  assert.equal(f.events.at(-1).value.phase, "checking");
  assert.equal(f.context.quitting, false, "window cleanup retains IPC access");
  fail(new Error("window cleanup failed"));
  await assert.rejects(pending, /window cleanup failed/);
  assert.equal(f.events.at(-1).value.state, "idle");
  assert.equal(f.context.quitAttempt, null);
  assert.deepEqual(f.suppressed, [true, false]);
});

test("idle quit detaches without a dialog or stop", async () => {
  const f = fixture(idle);
  assert.deepEqual(await confirmHostQuit(f.backend, f.notify), { keepBackground: true });
  assert.deepEqual(f.dialogs, []);
  assert.deepEqual(f.stops, []);
});
test("CLI-only active Turn defaults to keeping background and Escape cancels", async () => {
  const keep = fixture(active, [0]);
  assert.deepEqual(await confirmHostQuit(keep.backend, keep.notify), { keepBackground: true });
  assert.equal(keep.dialogs[0].defaultId, 0);
  assert.equal(keep.dialogs[0].cancelId, 2);
  assert.deepEqual(keep.stops, []);
  const cancel = fixture(active, [2]);
  assert.deepEqual(await confirmHostQuit(cancel.backend, cancel.notify), { canceled: true });
  assert.deepEqual(cancel.stops, []);
});
test("unknown activity remains explicit and never implies idle", async () => {
  for (const activity of [
    new Error("Host unavailable"),
    { complete: false, projects: [], totalActiveTasks: 0 },
  ]) {
    const f = fixture(activity, [0]);
    assert.deepEqual(await confirmHostQuit(f.backend, f.notify), { keepBackground: true });
    assert.equal(f.dialogs.length, 1);
    assert.match(f.dialogs[0].detail, /无法核查/);
    assert.deepEqual(f.stops, []);
  }
});
test("stop and quit requires a second confirmation before one durable stop", async () => {
  const decline = fixture(active, [1, 0]);
  assert.deepEqual(await confirmHostQuit(decline.backend, decline.notify), { canceled: true });
  assert.deepEqual(decline.stops, []);
  const accept = fixture(active, [1, 1]);
  let stopping = 0;
  const result = await confirmHostQuit(accept.backend, accept.notify, () => stopping++);
  assert.deepEqual(result, { stopped: true, operation });
  validateCommandResponse("serviceLifecycle", { operation: "stopAndQuit" }, result);
  assert.equal(stopping, 1);
  assert.equal(accept.dialogs[1].defaultId, 0);
  assert.deepEqual(accept.stops, [{ strategy: "cancel" }]);
});
test("confirmed menu stop returns a validated public operation", async () => {
  const f = fixture(active, [1]);
  const result = await confirmHostStop(f.backend, f.notify);
  assert.deepEqual(result, { stopped: true, operation });
  validateCommandResponse("stopService", {}, result);
});
test("menu stop uses the same confirmed operation and incomplete cleanup stays visible", async () => {
  const f = fixture(active, [1]);
  f.backend.requestHostStop = async (request) => {
    f.stops.push(request);
    return { stopped: false, operation: { phase: "settlementIncomplete" } };
  };
  await assert.rejects(confirmHostStop(f.backend, f.notify), { code: "LIFECYCLE_INCOMPLETE" });
  assert.equal(f.dialogs.length, 1);
  assert.equal(f.stops.length, 1);
});
test("menu counts tasks and Turns separately and labels partial observations", () => {
  setNativeLocale("en");
  try {
    assert.equal(hostActivityLabel(active), "Background running, 1 conversation turn");
    assert.equal(
      hostActivityLabel({ ...active, totalActiveTasks: 2 }),
      "Background running, 2 tasks",
    );
    assert.equal(
      hostActivityLabel({ ...active, complete: false, totalActiveTasks: 2 }),
      "At least 2 background tasks, some status unknown",
    );
    assert.equal(hostActivityLabel(idle), "Background idle");
  } finally {
    setNativeLocale("zh-CN");
  }
});

test("quit succeeds when preload reports noSubscriber before React mounts quit guard", async () => {
  const f = quitFixture({
    alive: true,
    rendererReply: { allowed: false, reason: "noSubscriber" },
    immediateReady: true,
    activity: idle,
  });
  const result = await f.context.requestQuit("application");
  assert.deepEqual(result, { stopped: false, quitting: true });
  assert.equal(f.context.exitReady, true);
  assert.equal(f.counts().settleWindowCalls, 0, "noSubscriber skips renderer window-close gate");
  assert.equal(f.counts().prepareQuitCalls, 1);
  assert.equal(f.counts().shutdownCalls, 1);
  assert.deepEqual(f.counts().completeQuitCalls, [{ keepBackground: true }]);
});

test("quit asks native Wait vs Discard on unresponsive renderer instead of silently discarding drafts", async () => {
  const f = quitFixture({
    alive: true,
    autoAllowRenderer: false,
    immediateReady: true,
    activity: idle,
    assertIdleBeforeDialog: false,
    dialogResponses: [0, 1],
  });
  const pending = f.context.requestQuit("application");
  await new Promise(setImmediate);
  // 第一次选“继续等待”，不能绕过草稿确认强退。
  f.win.emit("unresponsive");
  await new Promise(setImmediate);
  assert.equal(f.context.exitReady, false);
  assert.equal(f.coordinator.shouldPreventUnload(f.owner), false);
  // 第二次显式选“放弃未保存修改并退出”，才允许覆盖 unload 阻止并退出。
  f.win.emit("unresponsive");
  const result = await pending;
  assert.deepEqual(result, { stopped: false, quitting: true });
  assert.equal(f.context.exitReady, true);
  assert.equal(f.coordinator.shouldPreventUnload(f.owner), true);
});

test("relaunch preserves unsaved draft cancellation and never exits on cleanup failure", async () => {
  const canceled = quitFixture({
    alive: true,
    rendererReply: { allowed: false },
    immediateReady: true,
    activity: idle,
  });
  assert.deepEqual(
    await canceled.context.requestQuit(
      "relaunch",
      "/Applications/AReaL Harness GUI.app/Contents/MacOS/AReaL Harness GUI",
    ),
    { canceled: true },
  );
  assert.deepEqual(canceled.relaunched, []);
  assert.deepEqual(canceled.exited, []);
  assert.equal(canceled.context.exitReady, false);

  const failed = quitFixture({
    alive: false,
    immediateReady: true,
    activity: idle,
    prepareQuitError: new Error("GUI terminal cleanup unconfirmed"),
  });
  await assert.rejects(
    failed.context.requestQuit(
      "relaunch",
      "/Applications/AReaL Harness GUI.app/Contents/MacOS/AReaL Harness GUI",
    ),
    /GUI terminal cleanup unconfirmed/,
  );
  assert.deepEqual(failed.relaunched, []);
  assert.deepEqual(failed.exited, []);
  assert.equal(failed.context.exitReady, false);

  const succeeded = quitFixture({
    alive: false,
    immediateReady: true,
    activity: idle,
  });
  const ok = await succeeded.context.requestQuit(
    "relaunch",
    "/Applications/AReaL Harness GUI.app/Contents/MacOS/AReaL Harness GUI",
  );
  assert.deepEqual(ok, { stopped: false, quitting: true });
  assert.deepEqual(succeeded.relaunched, [
    { execPath: "/Applications/AReaL Harness GUI.app/Contents/MacOS/AReaL Harness GUI" },
  ]);
  assert.deepEqual(succeeded.exited, [0]);
});

test("quit exits cleanly even before backend initialization finishes", async () => {
  const f = quitFixture({ noBackend: true, alive: false });
  const result = await f.context.requestQuit("application");
  assert.deepEqual(result, { stopped: false, quitting: true });
  assert.equal(f.context.exitReady, true);
});

test("bundle guard ignores transient missing files and relaunches only when new bundle is complete", async () => {
  const { createBundleGuard } = require("../app/src/core/generated/bundle-guard.cjs");
  let diskText = JSON.stringify({ version: 1, identity: "a".repeat(64) });
  let binExists = true;
  const requestedExecPaths = [];
  const guard = createBundleGuard({
    isPackaged: true,
    resourcesPath: "/Applications/AReaL Harness GUI.app/Contents/Resources",
    execPath: "/opt/backup.app/Contents/MacOS/AReaL Harness GUI",
    platform: "darwin",
    readText: () => {
      if (diskText === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return diskText;
    },
    pathExists: (target) =>
      binExists &&
      target === "/Applications/AReaL Harness GUI.app/Contents/MacOS/AReaL Harness GUI",
  });
  assert.equal(guard.checkReplaced().replaced, false);
  // 覆盖安装短暂缺文件视为可重试态，不提前退出。
  diskText = null;
  assert.deepEqual(guard.checkReplaced(), {
    replaced: false,
    transient: true,
    reason: "desktop-build.json temporarily missing or unreadable",
  });
  // 新指纹已出现但可执行文件尚未到位，也不提前退出。
  diskText = JSON.stringify({ version: 1, identity: "b".repeat(64) });
  binExists = false;
  assert.equal(guard.checkReplaced().replaced, false);
  assert.equal(guard.checkReplaced().transient, true);
  // 新指纹与可执行文件都就绪后，幂等进入重拉；若用户取消，后续允许重试。
  binExists = true;
  assert.equal(guard.checkReplaced().replaced, true);
  let resolveFirst;
  const hooks = {
    isBusy: () => false,
    requestRelaunchQuit: (execPath) => {
      requestedExecPaths.push(execPath);
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    },
  };
  assert.equal(guard.triggerRelaunchIfReplaced(hooks), true);
  assert.equal(guard.triggerRelaunchIfReplaced(hooks), true);
  assert.equal(requestedExecPaths.length, 1);
  assert.equal(
    requestedExecPaths[0],
    "/Applications/AReaL Harness GUI.app/Contents/MacOS/AReaL Harness GUI",
  );
  resolveFirst({ canceled: true });
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(guard.triggerRelaunchIfReplaced(hooks), true);
  assert.equal(requestedExecPaths.length, 2);
});

test("committed main frame survives aborted navigation did-fail-load and keeps draft quit guard", async () => {
  const { EventEmitter } = require("node:events");
  const { createWindowController } = require("../app/src/core/generated/window-controller.cjs");
  const { createQuitCoordinator } = require("../app/src/core/generated/quit-coordinator.cjs");
  const mainFrame = { url: "areal-ui://app/" };
  const sent = [];
  const exited = [];
  let fakeWin;
  class FakeBrowserWindow extends EventEmitter {
    static getAllWindows() {
      return fakeWin ? [fakeWin] : [];
    }
    constructor() {
      super();
      fakeWin = this;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame,
        isDestroyed: () => false,
        setWindowOpenHandler: () => {},
      });
    }
    isDestroyed() {
      return false;
    }
    isMinimized() {
      return false;
    }
    show() {}
    focus() {}
    hide() {}
    restore() {}
    async loadURL() {
      this.webContents.emit("did-finish-load");
    }
  }
  let quitCoordinator;
  const controller = createWindowController({
    BrowserWindow: FakeBrowserWindow,
    diagnostics: { record: () => {} },
    sendDesktopEvent: (_owner, channel, value) => sent.push({ channel, value }),
    isQuitting: () => quitCoordinator.isQuitting(),
    isExitReady: () => quitCoordinator.isExitReady(),
    hasActiveQuitPhase: () => quitCoordinator.hasActiveQuitPhase(),
    shouldPreventUnload: (contents) => quitCoordinator.shouldPreventUnload(contents),
    onDidFailLoad: () => {
      void quitCoordinator.requestRelaunchQuit(
        "/Applications/AReaL Harness GUI.app/Contents/MacOS/AReaL Harness GUI",
      );
      return true;
    },
  });
  quitCoordinator = createQuitCoordinator({
    app: {
      isPackaged: true,
      getPath: () => "/tmp/areal-test",
      quit: () => {},
      relaunch: () => {},
      exit: (code) => exited.push(code),
    },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    diagnostics: { record: () => {} },
    showMessageBox: async () => ({ response: 0 }),
    confirmHostQuit,
    confirmHostStop,
    sendDesktopEvent: (_owner, channel, value) => sent.push({ channel, value }),
    getWindow: () => controller.getWindow(),
    isRendererAlive: () => controller.isRendererAlive(),
    isRendererResponsive: () => controller.isRendererResponsive(),
    hasPreloadFailed: () => controller.hasPreloadFailed(),
    isPreloadActive: () => controller.isPreloadActive(),
    revealWindow: (opts) => controller.revealWindow(opts),
    announceWindowOpened: () => controller.announceWindowOpened(),
    settleWindow: (owner) => controller.settleWindow(owner),
    getBackend: () => ({
      waitForApplicationReady: async () => {},
      readHostActivity: async () => idle,
      prepareQuit: async () => {},
      completeApplicationQuit: async () => {},
      shutdown: async () => {},
      reportLifecycleError: () => {},
    }),
    getPreview: () => ({ setPresentationSuppressed: () => {}, dispose: async () => {} }),
  });

  await controller.createWindow();
  assert.equal(controller.isRendererAlive(), true);
  // 模拟已有草稿页通过 beforeunload 拒绝临时导航：did-fail-load 触发但原主 frame 仍在。
  fakeWin.webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "areal-ui://app/other", true);
  await new Promise(setImmediate);
  assert.equal(controller.isRendererAlive(), true);
  assert.equal(
    sent.filter((item) => item.channel === "areal-core:quit-request").length,
    1,
    "alive committed frame must still receive quit-request before relaunch",
  );
  assert.deepEqual(exited, [], "must not exit without renderer draft confirmation");
  // 用户取消草稿退出后，保持旧进程不退出。
  const reqId = sent.find((item) => item.channel === "areal-core:quit-request").value;
  quitCoordinator.handleQuitDecision(
    { sender: fakeWin.webContents, senderFrame: mainFrame },
    { id: reqId, allowed: false },
  );
  await new Promise(setImmediate);
  assert.deepEqual(exited, []);
});

test("startup load failure awaits in-flight relaunch and handles transient bundle replacement", async () => {
  const { createBundleGuard } = require("../app/src/core/generated/bundle-guard.cjs");
  let diskText = JSON.stringify({ version: 1, identity: "a".repeat(64) });
  const guard = createBundleGuard({
    isPackaged: true,
    resourcesPath: "/Applications/AReaL Harness GUI.app/Contents/Resources",
    execPath: "/opt/backup.app/Contents/MacOS/AReaL Harness GUI",
    platform: "darwin",
    readText: () => {
      if (diskText === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return diskText;
    },
    pathExists: () => true,
  });

  // 场景 1：did-fail-load 已发起异步重拉，recoverStartupLoadFailure 必须等待其清理完成并返回 handled。
  diskText = JSON.stringify({ version: 1, identity: "b".repeat(64) });
  let finishRelaunch;
  let exitReady = false;
  let relaunchCalls = 0;
  const hooks = {
    isBusy: () => !exitReady && relaunchCalls > 0,
    isExitReady: () => exitReady,
    getPendingQuit: () => null,
    requestRelaunchQuit: () => {
      relaunchCalls++;
      return new Promise((resolve) => {
        finishRelaunch = () => {
          exitReady = true;
          resolve({ stopped: false, quitting: true });
        };
      });
    },
  };
  assert.equal(guard.triggerRelaunchIfReplaced(hooks), true);
  const recoveryPromise = guard.recoverStartupLoadFailure(hooks, {
    maxAttempts: 2,
    retryDelayMs: 5,
  });
  await new Promise(setImmediate);
  finishRelaunch();
  assert.equal(await recoveryPromise, "handled");
  assert.equal(relaunchCalls, 1);

  // 场景 2：启动瞬间处于 transient 缺文件，随后新包落盘完成，应触发重拉并等待完成。
  let transientReads = 0;
  let exitReady2 = false;
  const guard2 = createBundleGuard({
    isPackaged: true,
    resourcesPath: "/Applications/AReaL Harness GUI.app/Contents/Resources",
    execPath: "/Applications/AReaL Harness GUI.app/Contents/MacOS/AReaL Harness GUI",
    platform: "darwin",
    readText: () => {
      transientReads++;
      if (transientReads === 1) return JSON.stringify({ version: 1, identity: "c".repeat(64) });
      if (transientReads === 2) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return JSON.stringify({ version: 1, identity: "d".repeat(64) });
    },
    pathExists: () => true,
  });
  const outcome2 = await guard2.recoverStartupLoadFailure(
    {
      isBusy: () => false,
      isExitReady: () => exitReady2,
      getPendingQuit: () => null,
      requestRelaunchQuit: async () => {
        exitReady2 = true;
        return { stopped: false, quitting: true };
      },
    },
    { maxAttempts: 4, retryDelayMs: 5 },
  );
  assert.equal(outcome2, "handled");
});

test("repeated quit reprompts sustained unresponsive window and handles preload failure without losing drafts", async () => {
  // 1) 持续无响应：选“继续等待”后再次按 ⌘Q（无第二次 unresponsive 事件），应重新弹窗并复用同一 attempt。
  const hung = quitFixture({
    alive: true,
    responsive: false,
    autoAllowRenderer: false,
    immediateReady: true,
    activity: idle,
    assertIdleBeforeDialog: false,
    dialogResponses: [0, 1],
  });
  const firstPromise = hung.context.requestQuit("application");
  await new Promise(setImmediate);
  assert.equal(hung.dialogs.length, 1);
  assert.equal(hung.context.exitReady, false);
  // 再次按 ⌘Q，不依赖 Electron 再次发 unresponsive 事件。
  const secondPromise = hung.context.requestQuit("application");
  assert.equal(secondPromise, firstPromise);
  const result = await firstPromise;
  assert.equal(hung.dialogs.length, 2);
  assert.deepEqual(result, { stopped: false, quitting: true });
  assert.equal(hung.context.exitReady, true);
  assert.equal(hung.coordinator.shouldPreventUnload(hung.owner), true);

  // 2) preload 加载失败但页面仍 responsive：首次 ⌘Q 即提供原生等待/放弃选择，不锁死也不静默丢草稿。
  const brokenPreload = quitFixture({
    alive: true,
    responsive: true,
    preloadFailed: true,
    preloadActive: false,
    autoAllowRenderer: false,
    immediateReady: true,
    activity: idle,
    assertIdleBeforeDialog: false,
    dialogResponses: [0, 1],
  });
  const preloadQuit = brokenPreload.context.requestQuit("application");
  await new Promise(setImmediate);
  assert.equal(brokenPreload.dialogs.length, 1);
  assert.equal(brokenPreload.context.exitReady, false);
  assert.equal(brokenPreload.context.requestQuit("application"), preloadQuit);
  assert.deepEqual(await preloadQuit, { stopped: false, quitting: true });
  assert.equal(brokenPreload.dialogs.length, 2);
  assert.equal(brokenPreload.context.exitReady, true);
});

test("normal window close still requests window-closing settlement when mounted renderer is unresponsive", async () => {
  const { EventEmitter } = require("node:events");
  const { createWindowController } = require("../app/src/core/generated/window-controller.cjs");
  const mainFrame = { url: "areal-ui://app/" };
  const sent = [];
  let hidden = 0;
  let previewDisposed = 0;
  let fakeWin;
  class FakeBrowserWindow extends EventEmitter {
    static getAllWindows() {
      return fakeWin ? [fakeWin] : [];
    }
    constructor() {
      super();
      fakeWin = this;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame,
        isDestroyed: () => false,
        setWindowOpenHandler: () => {},
      });
    }
    isDestroyed() {
      return false;
    }
    show() {}
    focus() {}
    hide() {
      hidden++;
    }
    async loadURL() {
      this.webContents.emit("did-finish-load");
    }
  }
  const controller = createWindowController({
    BrowserWindow: FakeBrowserWindow,
    diagnostics: { record: () => {} },
    sendDesktopEvent: (_owner, channel, value) => sent.push({ channel, value }),
    isQuitting: () => false,
    isExitReady: () => false,
    hasActiveQuitPhase: () => false,
    shouldPreventUnload: () => false,
    onDisposePreview: async () => {
      previewDisposed++;
    },
  });
  await controller.createWindow();
  fakeWin.emit("unresponsive");
  assert.equal(controller.isRendererResponsive(), false);
  let prevented = false;
  fakeWin.emit("close", { preventDefault: () => (prevented = true) });
  await new Promise(setImmediate);
  assert.equal(prevented, true);
  assert.equal(
    sent.filter((item) => item.channel === "areal-core:window-closing").length,
    1,
    "normal close must still ask renderer to settle Host resources",
  );
  assert.equal(hidden, 0, "window must stay open until window-closing is acknowledged");
  assert.equal(previewDisposed, 0, "preview must not be disposed before settlement");
  // 清理待决的 windowCloseGate 定时，避免阻塞测试进程退出。
  const closeReqId = sent.find((item) => item.channel === "areal-core:window-closing").value;
  controller.decideWindowClose(
    { sender: fakeWin.webContents, senderFrame: mainFrame },
    { id: closeReqId, allowed: false },
  );
  await new Promise(setImmediate);
  assert.equal(hidden, 0);
});

test("late preview subscribe from old frame cannot revoke new frame subscription", async () => {
  const {
    registerDesktopIpcHandlers,
  } = require("../app/src/core/generated/desktop-ipc-handlers.cjs");
  const { createWindowController } = require("../app/src/core/generated/window-controller.cjs");
  const { EventEmitter } = require("node:events");
  const oldFrame = { url: "areal-ui://app/" };
  const newFrame = { url: "areal-ui://app/" };
  const handlers = new Map();
  const sent = [];
  let fakeWin;
  class FakeBrowserWindow extends EventEmitter {
    static getAllWindows() {
      return fakeWin ? [fakeWin] : [];
    }
    constructor() {
      super();
      fakeWin = this;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: oldFrame,
        isDestroyed: () => false,
        setWindowOpenHandler: () => {},
      });
    }
    isDestroyed() {
      return false;
    }
    async loadURL() {
      this.webContents.emit("did-finish-load");
    }
  }
  const windowController = createWindowController({
    BrowserWindow: FakeBrowserWindow,
    diagnostics: { record: () => {} },
    sendDesktopEvent: (_owner, channel, value) => sent.push({ channel, value }),
    isQuitting: () => false,
    isExitReady: () => false,
    hasActiveQuitPhase: () => false,
    shouldPreventUnload: () => false,
  });
  await windowController.createWindow();

  let resolveOldEnsure;
  let ensureCount = 0;
  const activeListeners = new Set();
  const preview = {
    suppressedPresentation: false,
    subscribe: (_projectId, _threadId, listener) => {
      activeListeners.add(listener);
      return {
        snapshot: { pages: [] },
        unsubscribe: () => {
          activeListeners.delete(listener);
        },
      };
    },
  };
  registerDesktopIpcHandlers({
    app: { getPath: () => "/tmp" },
    shell: {},
    nativeTheme: new EventEmitter(),
    cfg: {},
    diagnostics: { record: () => {} },
    handleDesktopIpc: (channel, fn) => handlers.set(channel, fn),
    onDesktopIpc: () => {},
    sendDesktopEvent: (_owner, channel, value) => sent.push({ channel, value }),
    windowController,
    quitCoordinator: { isQuitting: () => false },
    serviceBackend: {
      ensureBrowserThread: () => {
        ensureCount++;
        if (ensureCount === 1) {
          return new Promise((resolve) => {
            resolveOldEnsure = resolve;
          });
        }
        return Promise.resolve();
      },
    },
    getPreview: () => preview,
    openHtml: async () => {},
    bugReports: {},
    exportDiagnostics: async () => {},
    showMessageBox: async () => ({ response: 0 }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }),
    desktopSnapshot: () => ({}),
    nativeState: () => ({}),
    getNotificationTarget: () => null,
    consumeNotificationTarget: () => {},
    themes: [],
    getTheme: () => ({}),
    setThemeId: () => {},
    requestStopService: async () => {},
    updater: { state: () => ({}), download: async () => {} },
    recoverInstall: async () => {},
  });

  const previewHandler = handlers.get("areal-core:preview");
  const req = { operation: "subscribe", projectId: "p1", threadId: "t1" };
  // 旧 frame 先发起 subscribe 并在 ensureBrowserThread 挂起。
  const oldSubscribe = previewHandler({ sender: fakeWin.webContents, senderFrame: oldFrame }, req);
  // 导航切换到新 frame，新 frame 先完成 subscribe。
  fakeWin.webContents.mainFrame = newFrame;
  await previewHandler({ sender: fakeWin.webContents, senderFrame: newFrame }, req);
  assert.equal(activeListeners.size, 1);
  // 旧 frame 的 ensureBrowserThread 迟到返回：必须报错拒绝，且不能撤销新 frame 的订阅。
  resolveOldEnsure();
  await assert.rejects(oldSubscribe);
  assert.equal(activeListeners.size, 1, "new frame subscription must remain active");
  for (const listener of activeListeners) listener({ kind: "page-updated" });
  assert.equal(
    sent.filter((item) => item.channel === "areal-core:preview-event").length,
    1,
    "new frame must still receive preview updates after late old-frame rejection",
  );
});
