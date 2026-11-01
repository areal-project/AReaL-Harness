import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const gui = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(new URL("../packages/gen-ui/package.json", import.meta.url));
const { build } = require("esbuild");
const contract = require(join(gui, "packages/workbench/client/desktop-contract/snapshots.cjs"));
const output = await build({
  entryPoints: [join(gui, "app/src/core/snapshots/DesktopSnapShots.ts")],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  plugins: [
    {
      name: "native-boundaries",
      setup(build) {
        build.onLoad(
          {
            filter:
              /\/(ActiveWindow|MacSnapShot|MacModifierPairShortcutProcess|SnapShotAccessibilityProcess|SnapShotTransition)\.ts$/,
          },
          (args) => {
            if (args.path.endsWith("/ActiveWindow.ts"))
              return {
                contents: "exports.activeWindow=()=>globalThis.fixture.activeWindow();",
                loader: "js",
              };
            if (args.path.endsWith("/MacSnapShot.ts"))
              return {
                contents:
                  "exports.captureMacWindowSnapshot=(...args)=>globalThis.fixture.capture(...args);",
                loader: "js",
              };
            if (args.path.endsWith("/MacModifierPairShortcutProcess.ts"))
              return {
                contents:
                  "exports.startMacModifierPairShortcutProcess=(...args)=>globalThis.fixture.pair(...args);",
                loader: "js",
              };
            if (args.path.endsWith("/SnapShotAccessibilityProcess.ts"))
              return {
                contents:
                  "exports.makeSnapShotAccessibilityProcessPool=()=>({warm(){},cool(){},close(){},read(){return {result:Promise.resolve(undefined)}}});",
                loader: "js",
              };
            return {
              contents:
                "exports.SnapShotTransition=class {begin(...args){globalThis.fixture.transitions.push(args);return Promise.resolve()} dispose(){} dismiss(id){globalThis.fixture.dismissed.push(id)} animateTo(id,destination){globalThis.fixture.destinations.push({id,destination})} waitForLanding(){return Promise.resolve()} complete(id){globalThis.fixture.dismissed.push(id);return Promise.resolve()}};",
              loader: "js",
            };
          },
        );
      },
    },
  ],
});
const bundle = output.outputFiles[0].text;

async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), "areal-snapshots-native-test-"));
  const registered = new Map(),
    events = [],
    transitions = [],
    destinations = [],
    dismissed = [];
  const source = {
    id: 9,
    platform: "macos",
    title: "Fixture window",
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    owner: { name: "Fixture", processId: 42, path: "", bundleId: "org.areal.fixture" },
  };
  const fixture = {
    transitions,
    destinations,
    dismissed,
    activeWindow: async () => source,
    capture: async () => ({ png: Buffer.from("fixture PNG bytes") }),
    pair: async (_modifier, callback) => {
      registered.set("pair", callback);
      return () => registered.delete("pair");
    },
  };
  const electron = {
    globalShortcut: {
      register: (key, fn) => {
        if (registered.has(key)) return false;
        registered.set(key, fn);
        return true;
      },
      unregister: (key) => registered.delete(key),
    },
    nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 800, height: 600 }) }) },
    systemPreferences: {
      getMediaAccessStatus: () => "granted",
      isTrustedAccessibilityClient: () => false,
      getAnimationSettings: () => ({ prefersReducedMotion: false }),
    },
    app: {
      getFileIcon: async () => {
        throw Error("no icon");
      },
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(
    bundle,
    {
      module,
      exports: module.exports,
      require: (name) => (name === "electron" ? electron : require(name)),
      process: { ...process, platform: "darwin" },
      Buffer,
      console,
      setTimeout,
      clearTimeout,
      fixture,
    },
    { filename: join(gui, "app/src/core/snapshots/build/DesktopSnapShots.cjs") },
  );
  let menuSuppressed = false,
    revealed = 0;
  const window = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 100, y: 200, width: 1000, height: 700 }),
    getContentBounds: () => ({ x: 100, y: 220, width: 1000, height: 680 }),
    webContents: {
      isDestroyed: () => fixture.contentsDestroyed === true,
      getZoomFactor: () => 1.25,
      setIgnoreMenuShortcuts: (value) => {
        if (fixture.contentsDestroyed) throw new TypeError("Object has been destroyed");
        menuSuppressed = value;
      },
    },
  };
  const make = () =>
    new module.exports.DesktopSnapShots({
      directory,
      workerPath: "unused",
      window: () => window,
      revealWindow: () => {
        revealed++;
      },
      emit: (event) => events.push(event),
    });
  const owner = make();
  t.after(async () => {
    owner.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    owner,
    make,
    directory,
    fixture,
    electron,
    registered,
    events,
    get menuSuppressed() {
      return menuSuppressed;
    },
    get revealed() {
      return revealed;
    },
  };
}
const enabled = {
  ...contract.DEFAULT_SNAP_SHOT_SETTINGS,
  snapShotEnabled: true,
  snapShotAnimations: false,
  snapShotFlash: false,
};
const chord = {
  key: "s",
  modKey: true,
  shiftKey: true,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
};

test("pending capture survives owner restart and is removed only after acknowledge", async (t) => {
  const h = await harness(t);
  await h.owner.configure(enabled);
  await h.owner.captureSnapShot();
  const ready = h.events.find((event) => event.type === "ready");
  assert.ok(ready);
  const second = h.make();
  t.after(() => second.close());
  const pending = await second.pending.list();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, ready.id);
  const image = await second.pending.read(ready.id);
  assert.equal(Buffer.from(image.dataUrl.split(",")[1], "base64").toString(), "fixture PNG bytes");
  assert.equal(image.source.appIdentifier, "org.areal.fixture");
  assert.equal(image.source.accessibility, undefined);
  await second.pending.acknowledge(ready.id);
  await second.pending.acknowledge(ready.id);
  assert.equal((await second.pending.list()).length, 0);
});

test("shortcut conflict, recording release, restoration and disabling reflect actual registration", async (t) => {
  const h = await harness(t);
  const settings = { ...enabled, snapShotShortcut: chord };
  h.registered.set("CommandOrControl+Shift+S", () => {});
  await h.owner.configure(settings);
  assert.equal(h.owner.getSnapShotState().shortcutRegistered, false);
  assert.match(h.owner.getSnapShotState().shortcutMessage, /already used/);
  h.registered.clear();
  await h.owner.configure(settings, true);
  assert.equal(h.owner.getSnapShotState().shortcutRegistered, true);
  await h.owner.setSnapShotShortcutSuppressed(true);
  assert.equal(h.menuSuppressed, true);
  assert.equal(h.registered.size, 0);
  assert.equal((await h.owner.checkSnapShotShortcut(chord)).available, true);
  assert.equal(h.registered.size, 0);
  await h.owner.setSnapShotShortcutSuppressed(false);
  assert.equal(h.menuSuppressed, false);
  assert.equal(h.registered.size, 1);
  await h.owner.configure({ ...settings, snapShotEnabled: false });
  assert.equal(h.registered.size, 0);
  await assert.rejects(h.owner.captureSnapShot(), /disabled/);
});

test("overlapping requests share one capture and failed captures never enter the queue", async (t) => {
  const h = await harness(t);
  await h.owner.configure(enabled);
  let release;
  h.fixture.capture = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const first = h.owner.captureSnapShot(),
    second = h.owner.captureSnapShot();
  assert.equal(first, second);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  release({ png: Buffer.from("fixture PNG bytes") });
  await first;
  assert.equal(h.events.filter((event) => event.type === "requested").length, 1);
  assert.equal((await h.owner.pending.list()).length, 1);
  h.fixture.capture = async () => {
    throw Error("fixture capture denied");
  };
  await assert.rejects(h.owner.captureSnapShot(), /fixture capture denied/);
  assert.equal((await h.owner.pending.list()).length, 1);
  assert.equal(h.events.at(-1).type, "failed");
});

test("native fly destination uses zoomed screen coordinates and normalized content anchor", async (t) => {
  const h = await harness(t);
  await h.owner.configure({ ...enabled, snapShotAnimations: true });
  await h.owner.captureSnapShot();
  const id = h.events.find((event) => event.type === "ready").id;
  await h.owner.setSnapShotAnimationDestination({
    id,
    viewportFrame: { x: 20, y: 30, width: 208, height: 112 },
    backgroundColor: "#000",
    borderColor: "#fff",
    borderWidth: 1,
    cornerRadius: 8,
  });
  const destination = h.fixture.destinations[0].destination;
  assert.equal(
    JSON.stringify(destination.frame),
    JSON.stringify({ x: 125, y: 257.5, width: 260, height: 140 }),
  );
  assert.equal(destination.relativeFrame.x, 25 / 1000);
  assert.equal(destination.relativeFrame.y, 37.5 / 680);
  assert.equal(destination.borderWidth, 1.25);
});

test("reduced motion and animation off retain flash without starting a fly transition", async (t) => {
  const h = await harness(t);
  h.electron.systemPreferences.getAnimationSettings = () => ({ prefersReducedMotion: true });
  await h.owner.configure({ ...enabled, snapShotAnimations: true, snapShotFlash: true });
  await h.owner.captureSnapShot();
  assert.equal(h.fixture.transitions.length, 1);
  assert.equal(h.fixture.transitions[0][3], true);
  await h.owner.setSnapShotAnimationDestination({
    id: h.events.find((event) => event.type === "ready").id,
    viewportFrame: { x: 0, y: 0, width: 208, height: 112 },
    backgroundColor: "#000",
    borderColor: "#fff",
    borderWidth: 1,
    cornerRadius: 8,
  });
  assert.equal(h.fixture.destinations.length, 0);
});

test("IPC fields reject arbitrary file paths, malformed sources and incomplete preferences", () => {
  assert.throws(() => contract.readSnapShotId("../../secret"));
  assert.throws(() => contract.readSnapShotSettings({ snapShotEnabled: true }));
  assert.throws(() =>
    contract.readSnapShotAnimationDestination({
      id: "abc",
      viewportFrame: { x: 0, y: 0, width: -1, height: 100 },
    }),
  );
  assert.equal(
    contract.isSnapShotSource({
      kind: "snap-shot",
      capturedAt: new Date().toISOString(),
      appName: "fixture",
      windowTitle: "fixture",
      accessibleText: "x".repeat(32001),
    }),
    false,
  );
  const library = require(
    join(gui, "packages/workbench/client/desktop-contract/library-media.cjs"),
  );
  assert.equal(
    library.isLibraryRequest({ operation: "settings", key: "snapShot", value: enabled }),
    true,
  );
});

test("destroyed WebContents releases shortcut recording and permits application shutdown", async (t) => {
  const fixture = await harness(t);
  await fixture.owner.configure({ ...enabled, snapShotShortcut: chord });
  await fixture.owner.setSnapShotShortcutSuppressed(true);
  fixture.fixture.contentsDestroyed = true;
  await fixture.owner.setSnapShotShortcutSuppressed(false);
  assert.equal(fixture.registered.size, 1);
  assert.doesNotThrow(() => fixture.owner.close());
  assert.equal(fixture.registered.size, 0);
});

test("SnapShot IPC rejects an expired owner before dispatch and after an asynchronous capture", async () => {
  const handlers = new Map();
  const source = await readFile(join(gui, "app/src/core/snapshots/host.cjs"), "utf8");
  let allowed = true,
    captures = 0,
    finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const instance = {
    captureSnapShot: () => {
      captures++;
      return gate;
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    __dirname: join(gui, "app/src/core/snapshots"),
    process,
    require: (id) => {
      if (id === "electron") return { app: { getPath: () => tmpdir(), on() {} } };
      if (id === "../desktop-ipc.cjs")
        return { handleDesktopIpc: (name, handler) => handlers.set(name, handler) };
      if (id === "./build/DesktopSnapShots.cjs")
        return {
          DesktopSnapShots: class {
            constructor() {
              return instance;
            }
          },
        };
      if (id === "@areal/workbench/desktop-contract/snapshots") return contract;
      return require(id);
    },
  });
  module.exports.startSnapShots({
    window: () => null,
    revealWindow() {},
    trusted() {
      if (!allowed) throw new Error("expired owner");
    },
  });
  const capture = handlers.get("areal-core:snap-shot-capture");
  allowed = false;
  await assert.rejects(capture({}), /expired owner/);
  assert.equal(captures, 0);
  allowed = true;
  const result = capture({});
  assert.equal(captures, 1);
  allowed = false;
  finish({ id: "capture" });
  await assert.rejects(result, /expired owner/);
});
