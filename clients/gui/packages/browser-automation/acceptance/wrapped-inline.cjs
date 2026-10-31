"use strict";
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
if (!process.versions.electron) {
  const { spawn } = require("node:child_process");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [__filename, ...process.argv.slice(2)], {
    env,
    stdio: "inherit",
  });
  child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
  return;
}
const { app, BrowserWindow, WebContentsView } = require("electron");
const { NativePageTargets } = require("../../../app/src/core/preview-native/native-targets.cjs");
const { executeBrowserCommandOnView } = require("../dist/index.cjs");

const scratch = mkdtempSync(join(tmpdir(), "areal-wrapped-inline-"));
app.setPath("userData", join(scratch, "profile"));
let window, view;
const checks = [];

app
  .whenReady()
  .then(async () => {
    window = new BrowserWindow({
      width: 501,
      height: 872,
      useContentSize: true,
      focusable: false,
      show: true,
    });
    view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    window.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 501, height: 872 });
    const contents = view.webContents;
    for (const kind of ["block", "wrapped", "first-covered", "all-covered"]) {
      const wrapped = kind !== "block";
      const html = `<!doctype html><style>
      body { font: 16px monospace; line-height: 20px; }
      #container { width: 200px; }
      #target { ${wrapped ? "" : "display: block; width: 120px; height: 30px;"} }
      </style><div id="container">${wrapped ? "prefix-prefix-" : ""}<a id="target" href="#details">Alpha beta</a></div>
      <script>window.clicks=0;document.querySelector('#target').onclick=event=>{event.preventDefault();window.clicks++};</script>`;
      await contents.loadURL(`data:text/html,${encodeURIComponent(html)}`);
      const geometry = await contents.executeJavaScript(`(() => {
      const element = document.querySelector('#target');
      const box = element.getBoundingClientRect();
      const fragments = Array.from(element.getClientRects(), rect => ({
        left: rect.left, top: rect.top, width: rect.width, height: rect.height
      }));
      return { fragments, centerHitsTarget:
        document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === element };
    })()`);
      assert.equal(geometry.fragments.length, wrapped ? 2 : 1);
      assert.equal(geometry.centerHitsTarget, !wrapped);
      if (kind.endsWith("covered"))
        await contents.executeJavaScript(`(() => {
        const fragments = document.querySelector('#target').getClientRects();
        for (const rect of Array.from(fragments).slice(0, ${kind === "first-covered" ? 1 : 2})) {
          const cover = document.createElement('div');
          Object.assign(cover.style, { position: 'fixed', left: rect.left+'px', top: rect.top+'px',
            width: rect.width+'px', height: rect.height+'px', zIndex: '1000', background: 'gray' });
          document.body.append(cover);
        }
      })()`);
      contents.debugger.attach("1.3");
      await contents.debugger.sendCommand("DOM.enable");
      const dom = await contents.debugger.sendCommand("DOM.getDocument");
      const match = await contents.debugger.sendCommand("DOM.querySelector", {
        nodeId: dom.root.nodeId,
        selector: "#target",
      });
      const description = await contents.debugger.sendCommand("DOM.describeNode", {
        nodeId: match.nodeId,
      });
      const backendNodeId = description.node.backendNodeId;
      const identity = JSON.stringify([1, 1, 1, "main", backendNodeId]);
      const page = {
        pageGeneration: 1,
        documentGeneration: 1,
        controlEpoch: 1,
        refs: new Map([[identity, "target"]]),
      };
      const resolve = () => new NativePageTargets().actionTarget(page, contents, "target");
      if (kind === "all-covered") await assert.rejects(resolve, /target_unavailable/);
      else {
        const point = await resolve();
        assert.equal(
          await contents.executeJavaScript(
            `document.elementFromPoint(${point.x},${point.y})===document.querySelector('#target')`,
          ),
          true,
        );
      }
      const inputs = [];
      const controlled = {
        webContents: contents,
        cdp: {
          send: (method, parameters, sessionId) => {
            if (method.startsWith("Input.")) inputs.push(method);
            return contents.debugger.sendCommand(method, parameters, sessionId);
          },
        },
      };
      const action = { name: "locator", selector: "#target", operation: "click", timeoutMs: 1000 };
      const result = await executeBrowserCommandOnView(controlled, {
        method: "playwright",
        action,
      });
      if (kind === "all-covered") {
        assert.equal(result.ok, false);
        assert.match(result.error.message, /covered/);
        assert.deepEqual(inputs, []);
        assert.equal(await contents.executeJavaScript("window.clicks"), 0);
      } else {
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.ok(inputs.includes("Input.dispatchMouseEvent"));
        assert.equal(await contents.executeJavaScript("window.clicks"), 1);
      }
      if (kind === "block") {
        const before = inputs.length;
        const forced = await executeBrowserCommandOnView(controlled, {
          method: "playwright",
          action: { ...action, force: true },
        });
        assert.equal(forced.ok, true, JSON.stringify(forced));
        assert.ok(inputs.slice(before).includes("Input.dispatchMouseEvent"));
        assert.equal(await contents.executeJavaScript("window.clicks"), 2);
        checks.push("block-force");
      }
      contents.debugger.detach();
      checks.push(kind);
    }
    console.log(JSON.stringify({ passed: true, checks, providerCalls: 0, scratch }));
  })
  .then(() => {
    if (!view.webContents.isDestroyed()) view.webContents.close();
    window.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
    window?.destroy();
    app.exit(1);
  });
