"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { loadNavigationDocument } = require("../app/src/core/browser-navigation.cjs");

function fixture() {
  const contents = new EventEmitter();
  let current = "about:blank",
    finish,
    fail,
    cancel;
  let loads = 0;
  contents.loadURL = () => {
    loads++;
    return new Promise((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
  };
  contents.getURL = () => current;
  contents.isDestroyed = () => false;
  const stopped = new Promise((_, reject) => {
    cancel = reject;
  });
  return {
    contents,
    stopped,
    cancel: () => cancel(new Error("outcome_unknown")),
    commit(url) {
      current = url;
      contents.emit("did-navigate", {}, url);
    },
    finish: () => finish(),
    fail: () => fail(new Error("ERR_ABORTED")),
    loads: () => loads,
  };
}

test("a committed interactive login document completes without waiting for slow subresources or replaying navigation", async () => {
  const f = fixture();
  const pending = loadNavigationDocument(f.contents, "https://site.example/", f.stopped);
  f.commit("https://login.example/sign-in");
  f.contents.emit("dom-ready");
  assert.deepEqual(await pending, {
    url: "https://login.example/sign-in",
    readiness: "interactive",
  });
  f.fail(); // 完成后的 loadURL 失败仍被消费，不能形成未处理拒绝或重放。
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.loads(), 1);
  assert.deepEqual(f.contents.eventNames(), []);
});

test("old DOM readiness and a document replaced before readiness cannot settle a new navigation", async () => {
  const f = fixture();
  let settled = false;
  const pending = loadNavigationDocument(f.contents, "https://site.example/", f.stopped);
  void pending.then(
    () => {
      settled = true;
    },
    () => {},
  );
  f.contents.emit("dom-ready");
  f.commit("https://site.example/");
  f.contents.emit("did-start-navigation", {}, "https://site.example/login", false, true);
  f.contents.emit("dom-ready");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  f.cancel();
  await assert.rejects(pending, /outcome_unknown/);
  assert.deepEqual(f.contents.eventNames(), []);
  assert.equal(f.loads(), 1);
});

test("native navigation rejection remains unconfirmed and removes event listeners", async () => {
  const f = fixture();
  const pending = loadNavigationDocument(f.contents, "https://site.example/", f.stopped);
  f.fail();
  await assert.rejects(pending, /ERR_ABORTED/);
  assert.deepEqual(f.contents.eventNames(), []);
  assert.equal(f.loads(), 1);
});

test("complete loading remains a valid receipt and cancellation before commit removes listeners", async () => {
  const loaded = fixture();
  const completed = loadNavigationDocument(
    loaded.contents,
    "https://site.example/",
    loaded.stopped,
  );
  loaded.commit("https://site.example/");
  loaded.finish();
  assert.deepEqual(await completed, { url: "https://site.example/", readiness: "complete" });
  assert.deepEqual(loaded.contents.eventNames(), []);
  const cancelled = fixture();
  const pending = loadNavigationDocument(
    cancelled.contents,
    "https://site.example/",
    cancelled.stopped,
  );
  cancelled.cancel();
  await assert.rejects(pending, /outcome_unknown/);
  cancelled.commit("https://site.example/");
  cancelled.contents.emit("dom-ready");
  assert.equal(cancelled.loads(), 1);
  assert.deepEqual(cancelled.contents.eventNames(), []);
});

test("UNKNOWN browser receipts retain request identity and only disclose bounded reasons", () => {
  const { browserHostFailure } = require("../app/src/core/browser-host-request.cjs");
  const identity = {
    coreInstanceId: "core-1",
    coreGeneration: "generation-1",
    projectId: "project-1",
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    pageId: "page-1",
    browserHostId: "host-1",
    hostGeneration: 3,
    pageGeneration: 4,
    controlEpoch: 5,
  };
  for (const reason of ["navigation_timeout", "navigation_interrupted", "private diagnostic"]) {
    const result = browserHostFailure(
      identity,
      Object.assign(new Error("outcome_unknown"), { reason }),
    );
    assert.deepEqual(result, {
      ...identity,
      dispatch: "unknown",
      error: "outcome_unknown",
      reason: reason === "private diagnostic" ? "action_unconfirmed" : reason,
    });
  }
  for (const code of ["stale_ref", "human_control", "plan_stale", "not_sent"]) {
    const result = browserHostFailure(identity, new Error(code));
    assert.equal(result.error, code);
    assert.equal(result.dispatch, undefined);
    assert.equal(result.reason, undefined);
  }
});
