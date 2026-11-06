"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createUpdater } = require("../app/src/update/controller.cjs");
const { prepareNativeInstall } = require("../app/src/update/native-ready.cjs");
const {
  githubFeedUrl,
  githubBetaFeedUrl,
  newer,
  validateUpdate,
} = require("../app/src/update/config.cjs");

const offer = (version) => ({
  version,
  files: [
    {
      url: `https://github.com/areal-project/AReaL-Harness/releases/download/gui-v${version}/AReaLHarness-${version}-macos-arm64.zip`,
      sha512: Buffer.alloc(64).toString("base64"),
      size: 123,
    },
  ],
});
function fixture(options = {}) {
  const calls = [],
    states = [];
  const updater = new EventEmitter();
  updater.setFeedURL = (config) => calls.push(["feed", config]);
  updater.checkForUpdates = async () => ({ updateInfo: offer("0.1.12") });
  updater.downloadUpdate = async () => {
    calls.push("download");
    updater.emit("download-progress", { percent: 42 });
  };
  updater.quitAndInstall = () => calls.push("install");
  const controller = createUpdater({
    updater,
    config: { feedUrl: githubFeedUrl },
    version: "0.1.11",
    platform: "darwin",
    arch: "arm64",
    onState: (state) => states.push(state),
    hasWork: async () => false,
    prepareNativeInstall: async () => calls.push("native-ready"),
    prepareInstall: async () => calls.push("stop-core"),
    log: { warn() {} },
    ...options,
  });
  return { updater, controller, calls, states };
}

test("adjacent formal version passes safety checks before native staging and handoff", async () => {
  const { controller, calls, states } = fixture();
  assert.equal((await controller.check()).status, "available");
  assert.equal((await controller.download()).status, "installing");
  assert.deepEqual(calls.slice(1), ["download", "stop-core", "native-ready", "install"]);
  assert.equal(states.find((state) => state.percent === 42).status, "downloading");
  await controller.install();
  await controller.download();
  assert.deepEqual(calls.slice(1), ["download", "stop-core", "native-ready", "install"]);
});

for (const failed of [false, true])
  test(`disabling beta discards the pending check (${failed ? "failed" : "offer"})`, async () => {
    const { updater, controller, calls } = fixture();
    let finish;
    let checks = 0;
    updater.checkForUpdates = () => {
      checks++;
      return checks === 1
        ? new Promise((resolve, reject) => {
            finish = () =>
              failed
                ? reject(new Error("Old beta feed unavailable"))
                : resolve({ updateInfo: offer("0.2.0-beta.1") });
          })
        : Promise.resolve({ updateInfo: offer("0.1.12") });
    };
    const pending = controller.setChannel(true);
    await controller.setChannel(false);
    finish();
    await pending;
    assert.equal(controller.state().channel, "stable");
    assert.equal(controller.state().version, "0.1.12");
    assert.equal(checks, 2);
    await controller.download();
    assert.equal(controller.state().downloaded, "0.1.12");
    assert.equal(calls.filter((call) => call === "download").length, 1);
  });

test("busy work defers install and idle retry uses the same verified download", async () => {
  let busy = true;
  const { controller, calls } = fixture({ hasWork: async () => busy });
  await controller.check();
  assert.equal((await controller.download()).status, "deferred");
  assert.deepEqual(calls.slice(1), ["download"]);
  busy = false;
  assert.equal((await controller.install()).status, "installing");
  assert.deepEqual(calls.slice(1), ["download", "stop-core", "native-ready", "install"]);
});

test("activity appearing at admission is deferred without native replacement", async () => {
  let busy = true;
  const { controller, calls } = fixture({
    prepareInstall: async () => {
      if (busy) throw Object.assign(new Error("busy at atomic admission"), { code: "CORE_BUSY" });
      calls.push("stop-core");
    },
  });
  await controller.check();
  assert.equal((await controller.download()).status, "deferred");
  assert.deepEqual(calls.slice(1), ["download"]);
  busy = false;
  await controller.install();
  assert.deepEqual(calls.slice(1), ["download", "stop-core", "native-ready", "install"]);
});

test("download interruption or checksum error preserves Core and supports retry", async () => {
  for (const message of ["connection interrupted", "SHA-512 mismatch"]) {
    const { updater, controller, calls } = fixture();
    updater.downloadUpdate = async () => {
      throw new Error(message);
    };
    await controller.check();
    assert.equal((await controller.download()).detail, message);
    assert.deepEqual(calls.slice(1), []);
    updater.downloadUpdate = async () => calls.push("download");
    await controller.download();
    assert.deepEqual(calls.slice(1), ["download", "stop-core", "native-ready", "install"]);
  }
});

test("failed native staging after safe shutdown requires manual reconciliation", async () => {
  const notices = [];
  const { controller, calls } = fixture({
    notify: async (options) => {
      notices.push(options);
      return { response: 0 };
    },
    prepareNativeInstall: async () => {
      throw new Error("native signature rejected");
    },
  });
  await controller.check();
  assert.equal((await controller.download()).status, "error");
  assert.match(controller.state().detail, /后台已安全停止.*native signature rejected/);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].message, "更新安装尚未完成");
  assert.match(notices[0].detail, /后台已安全停止.*退出并重新打开/);
  assert.deepEqual(calls.slice(1), ["download", "stop-core"]);
  await controller.install();
  await controller.download();
  await controller.check(true);
  assert.deepEqual(calls.slice(1), ["download", "stop-core"]);
});

test("a rejected package user check cannot arm native installation on normal exit", async () => {
  let armed = false;
  const { controller, calls } = fixture({
    prepareInstall: async () => {
      throw Object.assign(new Error("another profile is using this package"), {
        code: "LIFECYCLE_BLOCKED",
      });
    },
    prepareNativeInstall: async () => {
      armed = true;
    },
  });
  await controller.check();
  assert.equal((await controller.download()).status, "deferred");
  assert.equal(armed, false);
  assert.deepEqual(calls.slice(1), ["download"]);
});

test("handoff failure after staging cannot be repeated by automatic actions", async () => {
  const { controller, updater, calls } = fixture();
  updater.quitAndInstall = () => {
    calls.push("install");
    throw new Error("handoff failed");
  };
  await controller.check();
  assert.equal((await controller.download()).status, "error");
  await controller.install();
  await controller.download();
  await controller.check(true);
  assert.deepEqual(calls.slice(1), ["download", "stop-core", "native-ready", "install"]);
});

test("unknown stop result cannot be replayed by idle, check, or download actions", async () => {
  let requests = 0;
  const { controller, calls } = fixture({
    prepareInstall: async () => {
      requests++;
      throw Object.assign(new Error("receipt unknown"), { submissionUnknown: true });
    },
  });
  await controller.check();
  assert.equal((await controller.download()).status, "error");
  await controller.install();
  await controller.check(true);
  await controller.download();
  assert.equal(requests, 1);
  assert.equal(controller.state().status, "error");
  assert.deepEqual(calls.slice(1), ["download"]);
});

test("check errors are visible and a successful retry clears them", async () => {
  const { updater, controller } = fixture();
  updater.checkForUpdates = async () => {
    throw new Error("feed unavailable");
  };
  assert.equal((await controller.check()).status, "error");
  assert.equal(controller.state().detail, "feed unavailable");
  updater.checkForUpdates = async () => ({ updateInfo: offer("0.1.12") });
  assert.equal((await controller.check()).status, "available");
  assert.equal(controller.state().detail, "");
});

test("the download action retries a failed check without downloading the newly found offer", async () => {
  const { updater, controller, calls } = fixture();
  updater.checkForUpdates = async () => {
    throw new Error("net::ERR_NETWORK_CHANGED");
  };
  await controller.check();
  let finishCheck;
  updater.checkForUpdates = () =>
    new Promise((resolve) => {
      finishCheck = resolve;
    });
  const retry = controller.download();
  assert.equal(controller.state().checking, true);
  await controller.download();
  assert.deepEqual(calls.slice(1), []);
  finishCheck({ updateInfo: offer("0.1.12") });
  assert.equal((await retry).status, "available");
  assert.equal(controller.state().detail, "");
  assert.deepEqual(calls.slice(1), []);
  await controller.download();
  assert.deepEqual(calls.slice(1), ["download", "stop-core", "native-ready", "install"]);
});

test("retry clears the check error when the feed has no newer version", async () => {
  for (const result of [null, { updateInfo: offer("0.1.11") }]) {
    const { updater, controller, calls } = fixture();
    updater.checkForUpdates = async () => {
      throw new Error("net::ERR_NETWORK_CHANGED");
    };
    await controller.check();
    updater.checkForUpdates = async () => result;
    const state = await controller.download();
    assert.equal(state.status, "idle");
    assert.equal(state.checking, false);
    assert.equal(state.detail, "");
    assert.deepEqual(calls.slice(1), []);
  }
});

test("preview has no automatic channel and invalid offers never become installable", async () => {
  const preview = fixture({ config: null, version: "0.1.12-test.1" });
  assert.equal((await preview.controller.check()).enabled, false);
  assert.deepEqual(preview.calls, []);
  const { updater, controller, calls } = fixture();
  updater.checkForUpdates = async () => ({ updateInfo: { ...offer("0.1.12"), files: [] } });
  assert.equal((await controller.check()).status, "error");
  await controller.download();
  assert.deepEqual(calls.slice(1), []);
  for (const version of ["0.1.10", "0.1.11", "0.1.12-test.1"]) {
    updater.checkForUpdates = async () => ({ updateInfo: offer(version) });
    assert.equal((await controller.check()).downloaded, undefined);
    await controller.download();
    assert.deepEqual(calls.slice(1), []);
  }
  assert.equal(validateUpdate(offer("0.1.12"), githubFeedUrl).version, "0.1.12");
});

test("versions follow semver with only X.Y.Z and X.Y.Z-beta.N accepted", () => {
  const ascending = [
    "0.1.18",
    "0.2.0-beta.1",
    "0.2.0-beta.2",
    "0.2.0-beta.10",
    "0.2.0",
    "0.2.1-beta.1",
  ];
  for (let i = 1; i < ascending.length; i++) {
    assert.equal(newer(ascending[i], ascending[i - 1]), true, ascending[i]);
    assert.equal(newer(ascending[i - 1], ascending[i]), false, ascending[i - 1]);
  }
  for (const version of ["0.2.0-rc.1", "0.2.0-beta.0", "0.2.0-beta", "v0.2.0", "0.2"])
    assert.equal(newer(version, "0.1.0"), false, version);
  assert.throws(() => validateUpdate(offer("0.2.0-beta.1"), githubFeedUrl), /正式更新频道/);
  assert.equal(validateUpdate(offer("0.2.0-beta.1"), githubBetaFeedUrl).version, "0.2.0-beta.1");
});

test("beta switch moves to the beta feed, and turning it off never downgrades", async () => {
  const feeds = { [githubFeedUrl]: "0.2.0", [githubBetaFeedUrl]: "0.2.1-beta.1" };
  const { updater, controller, calls } = fixture({ version: "0.2.0" });
  const feed = () => calls.filter((call) => call[0] === "feed").at(-1)[1].url;
  updater.checkForUpdates = async () => ({ updateInfo: offer(feeds[feed()]) });
  assert.equal(feed(), githubFeedUrl);
  assert.equal((await controller.check()).status, "idle");
  const found = await controller.setChannel(true);
  assert.equal(found.channel, "beta");
  assert.equal(feed(), githubBetaFeedUrl);
  assert.equal(found.status, "available");
  assert.equal(found.version, "0.2.1-beta.1");
  const back = await controller.setChannel(false);
  assert.equal(feed(), githubFeedUrl);
  assert.equal(back.status, "idle");
  assert.equal(back.version, undefined);
  assert.deepEqual(
    calls.filter((call) => call[0] !== "feed"),
    [],
  );
});

test("a beta install on the stable channel waits until stable passes it", async () => {
  const { updater, controller } = fixture({ version: "0.2.1-beta.1" });
  for (const [version, status] of [
    ["0.2.0", "idle"],
    ["0.2.1", "available"],
  ]) {
    updater.checkForUpdates = async () => ({ updateInfo: offer(version) });
    assert.equal((await controller.check()).status, status, version);
  }
});

test("release channels: stable feeds both channels, beta only beta, never downward", async () => {
  const { channelsFor, channelStep } = await import("./release-channels.mjs");
  assert.deepEqual(
    channelsFor("0.2.0").map((channel) => channel.tag),
    ["gui-update-channel", "gui-beta-channel"],
  );
  assert.deepEqual(
    channelsFor("0.2.1-beta.1").map((channel) => channel.tag),
    ["gui-beta-channel"],
  );
  assert.equal(channelStep("0.2.0", undefined), "advance");
  assert.equal(channelStep("0.2.0", "0.2.0-beta.3"), "advance");
  assert.equal(channelStep("0.2.0", "0.2.0"), "unchanged");
  assert.throws(() => channelStep("0.2.0", "0.2.1-beta.1"), /refusing/);
});

test("native staging readiness, rejection, and timeout release every owned listener", async () => {
  for (const event of ["update-downloaded", "update-not-available", "error", "timeout", "throw"]) {
    const native = new EventEmitter();
    native.checkForUpdates = () => {
      if (event === "throw") throw new Error("native throw");
      if (event !== "timeout")
        queueMicrotask(() => native.emit(event, new Error("native rejection")));
    };
    const pending = prepareNativeInstall(native, 10);
    if (event === "update-downloaded") await pending;
    else await assert.rejects(pending, /原生更新|native/);
    assert.deepEqual(native.eventNames(), []);
    native.checkForUpdates = () => queueMicrotask(() => native.emit("update-downloaded"));
    await prepareNativeInstall(native, 1000);
    assert.deepEqual(native.eventNames(), []);
  }
});
