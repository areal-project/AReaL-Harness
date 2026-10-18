import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { platform, arch, release } from "node:os";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const scratch = await mkdtemp("/private/tmp/areal-browser-r0-");
const receipts = [];
const site = createServer(async (request, response) => {
  if (request.url === "/receipt") {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    receipts.push(JSON.parse(raw));
    response.end("OK");
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><title>Native page sentinel</title>
    <style>body{margin:0;font:18px system-ui;background:#fff}label{position:fixed;top:20px;left:30px}input{font:inherit}
    button{width:90px;height:60px;border:0;color:#fff;font:16px system-ui}#center{position:fixed;top:45%;left:45%;background:rgb(19,177,71)}
    #edge{position:fixed;right:12px;bottom:12px;background:rgb(211,31,153)}#scrolled{position:absolute;top:1180px;left:180px;background:rgb(23,97,219)}
    .spacer{height:2000px}</style><label>未提交草稿 <input id="draft" aria-label="未提交草稿"></label>
    <button id="center">CENTER</button><button id="edge">EDGE</button><button id="scrolled">SCROLLED</button><div class="spacer"></div>
    <script>window.sentinel=crypto.randomUUID();window.clicks=[];window.keys=[];
    document.addEventListener('keydown',event=>window.keys.push(event.key));
    for(const id of ['center','edge','scrolled'])document.getElementById(id).onclick=()=>{window.clicks.push(id);fetch('/receipt',{method:'POST',body:JSON.stringify({id,sentinel:window.sentinel})})};</script>`);
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${site.address().port}/`;
const startedAt = new Date().toISOString();
const checks = [],
  captures = [];
let app,
  passed = false,
  error,
  sequence = 0;
const pending = new Map();
async function raw(operation, parameters = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`fixture timeout: ${operation}`));
    }, 20000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (cause) => {
        clearTimeout(timeout);
        reject(cause);
      },
    });
    app.stdin.write(JSON.stringify({ id, operation, parameters }) + "\n");
  });
}
async function call(operation, parameters) {
  const result = await raw(operation, parameters);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
async function until(predicate, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Timeout: ${label}`);
}
async function checkpoint(name, text, predicate) {
  await call("checkpoint", { text });
  await writeFile(join(scratch, "checkpoint.json"), JSON.stringify({ name, text }));
  console.log(JSON.stringify({ checkpoint: name, evidence: scratch, text }));
  await until(predicate, name, 600000);
}
const provenance = {
  gitSHA: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  worktreeStatus: execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }),
  diffSHA256: createHash("sha256")
    .update(execFileSync("git", ["diff", "HEAD"], { cwd: root }))
    .digest("hex"),
  os: platform(),
  arch: arch(),
  release: release(),
  fixtureVersion: 1,
  entry: "pnpm --dir clients/gui run test:browser-feasibility",
  scope:
    "isolated source Electron native fixture using the existing CorePreview; no Core/adapter tool routing",
};
const sourceFiles = [
  "app/src/core/preview.cjs",
  "package.json",
  "pnpm-lock.yaml",
  "scripts/browser-feasibility.mjs",
  ...(await readdir(join(gui, "scripts/fixtures/browser-feasibility"))).map(
    (name) => `scripts/fixtures/browser-feasibility/${name}`,
  ),
];
provenance.sourceSHA256 = Object.fromEntries(
  await Promise.all(
    sourceFiles.map(async (name) => [
      name,
      createHash("sha256")
        .update(await readFile(join(gui, name)))
        .digest("hex"),
    ]),
  ),
);
function colorTarget(capture, id) {
  const pixels = Buffer.from(capture.pixels, "base64");
  const { width, height } = capture.metadata.bitmap;
  assert.equal(pixels.length, width * height * 4, "bitmap dimensions describe the captured pixels");
  let left = width,
    right = -1,
    top = height,
    bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const b = pixels[offset],
        g = pixels[offset + 1],
        r = pixels[offset + 2];
      // 原生截图带显示器 ICC 配置，按独立色类定位，不能假定字节等于 CSS sRGB。
      const match =
        id === "center"
          ? g > 140 && g > r * 1.4 && g > b * 1.4
          : id === "edge"
            ? r > 140 && b > 100 && g < 100
            : b > 150 && g < 140 && r < 100;
      if (match) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  assert.ok(right >= left, `fixture target color is present: ${id}`);
  return { x: (left + right) / 2, y: (top + bottom) / 2, bounds: { left, right, top, bottom } };
}
try {
  const env = {
    ...process.env,
    AREAL_BROWSER_FIXTURE_DATA: join(scratch, "electron"),
    AREAL_BROWSER_FIXTURE_URL: url,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = spawn(
    process.env.AREAL_BROWSER_ELECTRON || require("electron"),
    [join(gui, "scripts/fixtures/browser-feasibility/main.cjs")],
    { env, stdio: ["pipe", "pipe", "pipe", "pipe"] },
  );
  let ready = false,
    exited = false;
  let log = "";
  for (const stream of [app.stdout, app.stderr])
    stream.on("data", (chunk) => {
      log += chunk;
    });
  app.on("exit", (code, signal) => {
    exited = true;
    for (const request of pending.values())
      request.reject(new Error(`fixture exited: ${code}/${signal}`));
    pending.clear();
  });
  app.on("error", (cause) => {
    error = cause.stack;
  });
  createInterface({ input: app.stdio[3] }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.ready) ready = true;
    else {
      pending.get(message.id)?.resolve(message);
      pending.delete(message.id);
    }
  });
  await until(async () => {
    if (exited || error) throw new Error(error || `fixture launch failed: ${log}`);
    return ready;
  }, "native fixture ready");
  await until(async () => (await raw("inspect")).ok, "fixture loaded");
  const identity = await call("identity");
  Object.assign(provenance, {
    identity,
    electronPID: app.pid,
    nativeInput: "external desktop automation or human; never DOM click",
  });
  await checkpoint(
    "human-draft",
    "请在网页输入框输入 HUMAN_DRAFT，点击绿色 CENTER，再把焦点放回输入框。",
    async () => {
      const state = await call("inspect");
      return state.draft === "HUMAN_DRAFT" && state.clicks.includes("center");
    },
  );
  await call("scroll", { y: 720 });
  const before = await call("inspect");
  const observation = await call("observe");
  assert.equal(observation.webContentsId, identity.webContentsId);
  assert.ok(
    observation.tree.nodes.some(
      (node) => node.role?.value === "textbox" && node.name?.value === "未提交草稿",
    ),
  );
  assert.ok(observation.tree.nodes.some((node) => node.value?.value === "HUMAN_DRAFT"));
  await call("preview", { operation: "hide" });
  await call("preview", { operation: "show", bounds: identity.bounds });
  const after = await call("inspect");
  assert.equal((await call("identity")).webContentsId, identity.webContentsId);
  for (const key of ["sentinel", "draft", "scrollX", "scrollY"])
    assert.equal(after[key], before[key]);
  assert.equal(after.bridge, "undefined");
  assert.equal(after.productBridge, "undefined");
  checks.push({
    scenario: "B-01",
    passed: true,
    identity,
    before,
    after,
    semanticTextbox: "HUMAN_DRAFT",
  });
  await writeFile(join(scratch, "B-01.json"), JSON.stringify(checks.at(-1), null, 2));
  if (process.env.AREAL_BROWSER_STOP_AFTER === "B-01") {
    passed = true;
  } else {
    const maskedBefore = await call("inspect");
    const maskedControl = await call("control");
    await checkpoint(
      "masked-input",
      "遮罩验证：点击绿色 CENTER，输入 LEAK_TEST，再点顶栏“接管”。",
      async () => (await call("controlState")).control === "human",
    );
    const maskedAfter = await call("inspect");
    assert.deepEqual(
      maskedAfter.clicks,
      maskedBefore.clicks,
      "native mask blocks webpage mouse input",
    );
    assert.deepEqual(
      maskedAfter.keys,
      maskedBefore.keys,
      "native mask blocks webpage keyboard input",
    );
    assert.equal(maskedAfter.draft, maskedBefore.draft);
    const maskProbe = await call("maskProbe");
    assert.ok(maskProbe.mouse > 0, "desktop pointer reached the native mask");
    assert.ok(maskProbe.keys > 0, "desktop keyboard reached the native mask");
    assert.ok((await call("controlState")).controlEpoch > maskedControl.controlEpoch);
    checks.push({
      scenario: "B-02",
      passed: true,
      before: maskedBefore,
      after: maskedAfter,
      maskProbe,
    });
    await writeFile(join(scratch, "B-02.json"), JSON.stringify(checks.at(-1), null, 2));
    for (const zoom of [1, 1.25]) {
      await call("zoom", { factor: zoom });
      await call("scroll", { y: 840 });
      const capture = await call("capture");
      const file = `page-zoom-${zoom}.png`;
      await writeFile(join(scratch, file), Buffer.from(capture.png, "base64"));
      const png = Buffer.from(capture.png, "base64");
      assert.equal(png.readUInt32BE(16), capture.metadata.bitmap.width);
      assert.equal(png.readUInt32BE(20), capture.metadata.bitmap.height);
      assert.equal(capture.metadata.zoom, zoom);
      assert.equal(capture.metadata.scroll.y, 840);
      const targets = [];
      for (const id of ["center", "edge", "scrolled"]) {
        const target = colorTarget(capture, id),
          receiptCount = receipts.length;
        const cssPoint = await call("clickBitmap", {
          ...target,
          captureId: capture.metadata.captureId,
          debugGeneration: capture.metadata.debugGeneration,
        });
        await until(async () => receipts.length > receiptCount, `bitmap click receipt: ${id}`);
        assert.equal(receipts.length, receiptCount + 1);
        assert.equal(receipts.at(-1).id, id);
        assert.equal(receipts.at(-1).sentinel, before.sentinel);
        targets.push({ id, bitmapPoint: target, cssPoint });
      }
      captures.push({ file, metadata: capture.metadata, targets });
    }
    checks.push({ scenario: "screenshot-transform", passed: true, captures });
    await call("minimize");
    await until(async () => (await call("identity")).minimized, "window minimized");
    assert.deepEqual(await raw("capture"), { id: sequence, ok: false, code: "page_not_visible" });
    await call("restore");
    await until(async () => !(await call("identity")).minimized, "window restored");
    checks.push({ scenario: "minimized-capture", passed: true, code: "page_not_visible" });
    const oldCapture = await call("capture");
    const oldDebug = await call("debugState");
    assert.equal(oldDebug.attached, true);
    await call("preview", { operation: "devtools" });
    await until(async () => (await call("debugState")).devtoolsOpen, "DevTools opened");
    await until(
      async () => !(await call("debugState")).attached,
      "real debugger detach after DevTools",
    );
    assert.equal((await raw("reattach")).code, "devtools_open");
    await call("closeDevtools");
    await until(async () => !(await call("debugState")).devtoolsOpen, "DevTools closed");
    await call("reattach");
    const newDebug = await call("debugState");
    assert.ok(newDebug.debugGeneration > oldDebug.debugGeneration);
    const stale = await raw("clickBitmap", {
      captureId: oldCapture.metadata.captureId,
      debugGeneration: oldCapture.metadata.debugGeneration,
      x: 200,
      y: 200,
    });
    assert.equal(stale.code, "stale_debug_generation");
    assert.deepEqual((await call("identity")).arguments, []);
    assert.equal((await call("inspect")).sentinel, before.sentinel);
    checks.push({ scenario: "B-03", passed: true, oldDebug, newDebug, stale });
    await writeFile(join(scratch, "B-03.json"), JSON.stringify(checks.at(-1), null, 2));
    await call("zoom", { factor: 1 });
    await call("scroll", { y: 720 });
    const freezeBefore = await call("inspect");
    const frozenMetadata = await call("freeze");
    await checkpoint(
      "frozen-review",
      "冻结截图方案：画面保留在同一窗口，页面可能继续变化。截图后点击“返回实时页”。",
      async () => !(await call("viewState")).frozen,
    );
    const freezeAfter = await call("inspect");
    assert.equal((await call("identity")).webContentsId, identity.webContentsId);
    for (const key of ["sentinel", "draft", "scrollX", "scrollY"])
      assert.equal(freezeAfter[key], freezeBefore[key]);
    checks.push({
      scenario: "frozen-screenshot-alternative",
      passed: true,
      frozenMetadata,
      before: freezeBefore,
      after: freezeAfter,
    });
    passed = true;
  }
} catch (caught) {
  error = caught.stack;
  if (app?.exitCode === null && app?.signalCode === null) {
    await writeFile(
      join(scratch, "failure-state.json"),
      JSON.stringify(
        {
          debug: await raw("debugState").catch(() => null),
          page: await raw("inspect").catch(() => null),
        },
        null,
        2,
      ),
    );
  }
  throw caught;
} finally {
  if (app && app.exitCode === null && app.signalCode === null) {
    await raw("quit").catch(() => {});
    await until(
      async () => app.exitCode !== null || app.signalCode !== null,
      "owned Electron exited",
    ).catch(() => app.kill());
  }
  await new Promise((resolve) => site.close(resolve));
  await mkdir(scratch, { recursive: true });
  const desktopFrames = (await readdir(scratch)).filter((name) => /^native-.*\.png$/.test(name));
  await writeFile(
    join(scratch, "run-manifest.json"),
    JSON.stringify(
      {
        ...provenance,
        passed,
        checks,
        captures,
        receipts,
        desktopFrames,
        startedAt,
        finishedAt: new Date().toISOString(),
        error,
        coreCalls: [],
        untested: [
          "Core browser ToolHost/approval/history (ticket 02 onward)",
          "packaged app",
          "other platforms",
          "real accounts",
          "IME and accessibility acceptance",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed,
      evidence: scratch,
      checks: checks.map((check) => check.scenario),
      error,
    }),
  );
}
