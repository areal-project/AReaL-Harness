"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");
const { webUrl, observationUrl } = require("../app/src/core/preview/urls.cjs");
const {
  bitmapPoint,
  coordinateTarget,
  boundsWithinWindow,
} = require("../app/src/core/preview/geometry.cjs");
const {
  safeText,
  diagnosticText,
  diagnosticUrl,
} = require("../app/src/core/preview/diagnostics.cjs");
const {
  captureGuardStartScript,
  captureGuardStopScript,
  captureGuardChangedScript,
  clearCaptureGuardScript,
  sensitiveCaptureScript,
} = require("../app/src/core/preview/capture-guard.cjs");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("preview URLs preserve navigation intent and redact observed secrets", () => {
  assert.equal(webUrl(" localhost:3000/path "), "http://localhost:3000/path");
  assert.equal(
    webUrl("example.com/search?q=hello#result"),
    "https://example.com/search?q=hello#result",
  );
  for (const value of [
    "javascript:alert(1)",
    "file:///tmp/private",
    "https://user:pass@example.com/",
  ])
    assert.throws(() => webUrl(value));
  assert.equal(
    observationUrl("https://user:pass@example.com/path?q=private#secret"),
    "https://example.com/path",
  );
});

test("bitmap targets use actual capture scale and preserve plan rounding", () => {
  const capture = { width: 801, height: 601, bitmapWidth: 1600, bitmapHeight: 1200 };
  assert.deepEqual(plain(bitmapPoint(capture, 100, 100)), { x: 50.0625, y: 50.078125 });
  assert.deepEqual(
    plain(
      coordinateTarget(capture, { kind: "drag", fromX: 0, fromY: 0, toX: 100, toY: 100, steps: 4 }),
    ),
    { from: { x: 0, y: 0 }, to: { x: 50.0625, y: 50.078125 }, steps: 4 },
  );
  assert.deepEqual(plain(coordinateTarget(capture, { kind: "clickAt", x: 100, y: 100 })), {
    point: { x: 50.0625, y: 50.078125 },
  });
  for (const point of [
    [-1, 0],
    [1600, 0],
    [0, 1200],
  ])
    assert.throws(() => bitmapPoint(capture, ...point), /target_unavailable/);
  for (const width of [0, -1, Infinity, NaN])
    assert.throws(() => bitmapPoint({ ...capture, width }, 1, 1), /target_unavailable/);
});

test("preview rectangles clip to content and reject invalid boundary input", () => {
  assert.deepEqual(
    plain(boundsWithinWindow({ x: -2, y: 50.6, width: 900, height: 900 }, [800, 600])),
    { x: 0, y: 51, width: 800, height: 549 },
  );
  assert.deepEqual(
    plain(boundsWithinWindow({ x: 900, y: 700, width: 100, height: 100 }, [800, 600])),
    { x: 800, y: 600, width: 0, height: 0 },
  );
  for (const value of [null, {}, { x: 0, y: 0, width: NaN, height: 10 }])
    assert.throws(() => boundsWithinWindow(value, [800, 600]));
});

test("preview diagnostics bound text and redact sensitive markers and private URLs", () => {
  assert.equal(safeText("ordinary title", 8), "ordinary");
  assert.equal(safeText("password value"), "[redacted]");
  assert.equal(diagnosticText("session-id=private"), "[redacted]");
  assert.equal(
    diagnosticText("failed https://example.com/path?q=private#fragment"),
    "failed https://example.com/path",
  );
  assert.equal(
    diagnosticUrl("https://example.com/path?q=private#fragment"),
    "https://example.com/path",
  );
  for (const value of ["https://user:pass@example.com/", "file:///tmp/private", "invalid"])
    assert.equal(diagnosticUrl(value), "[redacted URL]");
});

function guardPage() {
  const observers = [];
  const context = {
    document: { querySelectorAll: () => [] },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.records = [];
        observers.push(this);
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
      takeRecords() {
        return this.records.splice(0);
      }
    },
  };
  return { observers, run: (script) => runInNewContext(script, context) };
}

test("capture guard refuses stale starts and token mismatch and notices queued mutations", () => {
  const page = guardPage();
  assert.equal(page.run(captureGuardStartScript("first", 1)), true);
  assert.equal(page.run(captureGuardStartScript("stale", 1)), false);
  assert.equal(page.run(captureGuardChangedScript("wrong")), true);
  assert.equal(page.run(captureGuardChangedScript("first")), false);
  page.observers[0].records.push({});
  assert.equal(page.run(captureGuardChangedScript("first")), true);
  assert.equal(page.run(captureGuardStopScript("wrong", 1)), true);
  assert.equal(page.run(captureGuardStopScript("first", 1)), true);
  assert.equal(page.observers[0].disconnected, true);
  assert.equal(page.run(captureGuardStartScript("next", 2)), true);
  assert.equal(page.run(captureGuardStopScript("next", 2)), false);
  assert.equal(page.run(captureGuardStartScript("late", 1)), false);
});

test("capture guard replacement disconnects prior observers and clear invalidates active guard", () => {
  const page = guardPage();
  assert.equal(page.run(captureGuardStartScript("first", 1, false)), true);
  assert.equal(page.run(captureGuardStartScript("second", 2, false)), true);
  assert.equal(page.observers[0].disconnected, true);
  page.observers[1].callback();
  assert.equal(page.run(captureGuardStopScript("second", 2)), true);
  assert.equal(page.run(captureGuardStartScript("third", 3)), true);
  assert.equal(page.run(clearCaptureGuardScript), true);
  assert.equal(page.observers[2].disconnected, true);
  assert.equal(page.run(captureGuardChangedScript("third")), true);
});

test("sensitive capture script fails closed when a frame cannot be inspected", () => {
  const document = {
    querySelector: () => null,
    querySelectorAll: (selector) =>
      selector === "iframe,frame" ? [{ contentDocument: null }] : [],
  };
  assert.equal(runInNewContext(sensitiveCaptureScript(), { document }), true);
  assert.equal(runInNewContext(sensitiveCaptureScript(false), { document }), false);
});

test("device viewport requests accept exact dimensions and reject ambiguous or unbounded modes", () => {
  const { validatePreview } = require("../packages/workbench/client/desktop-contract.cjs");
  const request = {
    operation: "setViewport",
    projectId: "project",
    threadId: "thread",
    pageId: "page",
  };
  for (const viewport of [
    { mode: "auto" },
    { mode: "device", width: 390, height: 844 },
    { mode: "device", width: 844, height: 390 },
  ])
    assert.doesNotThrow(() => validatePreview({ ...request, viewport }));
  for (const viewport of [
    undefined,
    { mode: "auto", width: 390 },
    { mode: "device", width: 390 },
    { mode: "device", width: 239, height: 844 },
    { mode: "device", width: 2561, height: 844 },
    { mode: "device", width: 390.5, height: 844 },
    { mode: "device", width: 390, height: Infinity },
    { mode: "mobile", width: 390, height: 844 },
  ])
    assert.throws(() => validatePreview({ ...request, viewport }));
  assert.throws(() =>
    validatePreview({ ...request, pageId: undefined, viewport: { mode: "auto" } }),
  );
});

test("native viewport fitting preserves the requested device and invalidates old coordinate plans", () => {
  const { PreviewPresentation } = require("../app/src/core/preview-native/presentation.cjs");
  const { rendererBoundsWithinWindow } = require("../app/src/core/preview-native/read-session.cjs");
  let bounds = { x: 0, y: 0, width: 1, height: 1 },
    emulation,
    disabled = false;
  const changes = [];
  const window = { webContents: { getZoomFactor: () => 1.25 }, getContentSize: () => [1000, 800] };
  const page = {
    commandViewport: { width: 390, height: 844 },
    viewportRevision: 1,
    lastCapture: {},
    plans: new Map([["old", {}]]),
    needsObservation: false,
    view: {
      getBounds: () => bounds,
      setBounds: (value) => {
        bounds = value;
      },
      webContents: {
        setZoomFactor() {},
        enableDeviceEmulation: (value) => {
          emulation = value;
        },
        disableDeviceEmulation: () => {
          disabled = true;
        },
      },
    },
  };
  const presentation = new PreviewPresentation(
    { changed: (_page, event) => changes.push(event) },
    () => {},
    window,
  );
  const available = rendererBoundsWithinWindow({ x: 20, y: 40, width: 260, height: 400 }, window);
  assert.deepEqual(available, { x: 25, y: 50, width: 325, height: 500 });
  presentation.layout(page, available);
  assert.deepEqual(emulation.viewSize, { width: 390, height: 844 });
  assert.ok(bounds.width <= 325 && bounds.height <= 500);
  assert.equal(page.plans.size, 0);
  assert.equal(page.lastCapture, null);
  assert.equal(page.needsObservation, true);
  assert.deepEqual(changes, ["viewportChanged"]);
  presentation.layout(page, available);
  assert.equal(changes.length, 1);
  page.commandViewport = { width: 844, height: 390 };
  presentation.layout(page, available);
  assert.deepEqual(emulation.viewSize, { width: 844, height: 390 });
  page.commandViewport = null;
  presentation.layout(page, available);
  assert.equal(disabled, true);
  assert.deepEqual(bounds, available);
  assert.equal(page.viewportScale, undefined);
});

test("scaled CDP input keeps logical held positions and scales release exactly once", async () => {
  const { PageControl } = require("../app/src/core/preview-native/control.cjs");
  const sent = [];
  const page = {
    viewportScale: 0.5,
    heldButtons: new Map(),
    heldKeys: new Map(),
    inputPending: new Set(),
    view: {
      webContents: {
        debugger: {
          sendCommand: async (method, params) => {
            sent.push({ method, params });
          },
        },
      },
    },
  };
  const control = new PageControl({}, () => {});
  await control.dispatchInput(page, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    x: 100,
    y: 200,
  });
  assert.deepEqual(page.heldButtons.get("left"), { x: 100, y: 200 });
  await control.dispatchInput(page, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    ...page.heldButtons.get("left"),
  });
  assert.equal(page.heldButtons.size, 0);
  assert.deepEqual(
    sent.map(({ params }) => [params.x, params.y]),
    [
      [50, 100],
      [50, 100],
    ],
  );
});

test("trusted navigation policy rejection survives the desktop error boundary", async () => {
  const { HumanBrowserCommands } = require("../app/src/core/preview-native/ui-commands.cjs");
  const { desktopError } = require("../packages/workbench/client/desktop-contract.cjs");
  const workspace = {
    profile: { assertAvailable() {} },
    coreIdentity: () => "core",
    owns: () => true,
    page: () => ({
      id: "page",
      coreInstanceId: "core",
      networkPolicy: { canAuthorize: () => false },
    }),
  };
  const commands = new HumanBrowserCommands(
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    workspace,
    () => ({}),
    () => [],
  );
  await assert.rejects(
    commands.command({
      operation: "openLink",
      projectId: "project",
      threadId: "thread",
      url: "https://example.com",
    }),
    (error) => {
      assert.equal(desktopError(error).code, "BROWSER_PERMISSION_DENIED");
      return true;
    },
  );
});

test("device bitmap coordinates follow the measured native scale rather than stretching cropped pixels", () => {
  const { captureBitmapScale } = require("../app/src/core/preview/geometry.cjs");
  const facts = {
    width: 240,
    height: 2560,
    displayScale: 0.15625,
    nativeBounds: { width: 37, height: 400 },
  };
  const bitmapScale = captureBitmapScale(facts, { width: 74, height: 800 });
  assert.deepEqual(bitmapScale, { x: 0.3125, y: 0.3125 });
  const capture = { width: 240, height: 2560, bitmapWidth: 74, bitmapHeight: 800, bitmapScale };
  assert.deepEqual(bitmapPoint(capture, 72, 790), { x: 230.40625, y: 2528 });
  const paddedScale = { x: 37 / 120, y: 37 / 120 };
  assert.throws(
    () => bitmapPoint({ ...capture, bitmapScale: paddedScale }, 36, 799),
    /target_unavailable/,
  );
});
