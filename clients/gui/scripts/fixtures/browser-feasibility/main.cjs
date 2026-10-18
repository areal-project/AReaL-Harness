"use strict";
const { app, BrowserWindow, WebContentsView, ipcMain, screen } = require("electron");
const { join } = require("node:path");
const { writeSync } = require("node:fs");
const { createInterface } = require("node:readline");
const { CorePreview } = require("../../../app/src/core/preview.cjs");

app.setPath("userData", process.env.AREAL_BROWSER_FIXTURE_DATA);
let window,
    preview,
    mask,
    control = "human",
    controlEpoch = 0;
let debugGeneration = 0;
let devtoolsOpening = false;
const debugEvents = [];
const owner = { projectId: "fixture-project", threadId: "fixture-thread" };
const bounds = { x: 24, y: 120, width: 960, height: 600 };
let captureSequence = 0,
    lastCapture,
    frozen = false;
function fail(code) {
    throw Object.assign(new Error(code), { code });
}
const content = () => preview.view.webContents;
const inspect = () =>
    content().executeJavaScript(`({
  sentinel: window.sentinel, draft: document.getElementById('draft').value,
  scrollX, scrollY, clicks: window.clicks, keys: window.keys,
  bridge: typeof window.feasibility, productBridge: typeof window.arealDesktop,
  devicePixelRatio, innerWidth, innerHeight
})`);
function attach() {
    if (devtoolsOpening || content().isDevToolsOpened()) fail("devtools_open");
    if (!content().debugger.isAttached()) {
        content().debugger.attach("1.3");
        debugGeneration++;
        debugEvents.push({ type: "attach", generation: debugGeneration });
    }
}
function pauseForDevtools() {
    devtoolsOpening = true;
    lastCapture = null;
    // 所测 Electron 不会自动 detach，必须在打开前主动撤销测试 Driver。
    if (content().debugger.isAttached()) content().debugger.detach();
}
async function command(operation, parameters) {
    switch (operation) {
        case "preview":
            if (parameters.operation === "devtools") pauseForDevtools();
            return preview.command({ ...parameters, ...owner });
        case "inspect":
            return inspect();
        case "identity":
            return {
                webContentsId: content().id,
                partition: content().getLastWebPreferences().partition,
                bounds: preview.view.getBounds(),
                windowBounds: window.getBounds(),
                displayScale: screen.getDisplayMatching(window.getBounds()).scaleFactor,
                versions: process.versions,
                minimized: window.isMinimized(),
                arguments: process.argv.filter((value) => value.startsWith("--remote-debugging")),
            };
        case "observe": {
            attach();
            const tree = await content().debugger.sendCommand("Accessibility.getFullAXTree");
            return { webContentsId: content().id, debugGeneration, tree };
        }
        case "control": {
            control = "agent";
            controlEpoch++;
            mask.setVisible(true);
            mask.webContents.focus();
            await window.webContents.executeJavaScript(
                `document.getElementById('control').textContent = 'Agent 在控制（实验）'`,
            );
            return { control, controlEpoch };
        }
        case "takeover": {
            controlEpoch++;
            control = "human";
            mask.setVisible(false);
            await window.webContents.executeJavaScript(
                `document.getElementById('control').textContent = '你在控制；Agent 观察已暂停'`,
            );
            return { control, controlEpoch };
        }
        case "controlState":
            return { control, controlEpoch };
        case "maskProbe":
            return mask.webContents.executeJavaScript("window.maskInput");
        case "viewState":
            return { frozen, visible: preview.view.getVisible() };
        case "zoom":
            content().setZoomFactor(parameters.factor);
            lastCapture = null;
            return;
        case "scroll":
            lastCapture = null;
            return content().executeJavaScript(`window.scrollTo(0, ${Number(parameters.y)})`);
        case "capture": {
            if (window.isMinimized() || !window.isVisible() || !preview.view.getVisible())
                fail("page_not_visible");
            attach();
            // zoom 已更新布局不等于合成帧已更新，捕获前等待页面绘制提交。
            await content().executeJavaScript(
                "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
            );
            const metrics = await content().debugger.sendCommand("Page.getLayoutMetrics");
            const state = await inspect();
            const image = await content().capturePage();
            if (image.isEmpty()) fail("capture_unavailable");
            const bitmap = image.getSize();
            const metadata = {
                captureId: ++captureSequence,
                debugGeneration,
                controlEpoch,
                css: { width: state.innerWidth, height: state.innerHeight },
                bitmap,
                zoom: content().getZoomFactor(),
                scroll: { x: state.scrollX, y: state.scrollY },
                devicePixelRatio: state.devicePixelRatio,
                metrics,
            };
            lastCapture = metadata;
            return {
                metadata,
                png: image.toPNG().toString("base64"),
                pixels: image.toBitmap().toString("base64"),
            };
        }
        case "clickBitmap": {
            if (parameters.debugGeneration !== debugGeneration) fail("stale_debug_generation");
            if (!lastCapture || parameters.captureId !== lastCapture.captureId)
                fail("stale_capture");
            const x = (parameters.x * lastCapture.css.width) / lastCapture.bitmap.width;
            const y = (parameters.y * lastCapture.css.height) / lastCapture.bitmap.height;
            for (const type of ["mousePressed", "mouseReleased"])
                await content().debugger.sendCommand("Input.dispatchMouseEvent", {
                    type,
                    x,
                    y,
                    button: "left",
                    clickCount: 1,
                });
            return { x, y };
        }
        case "freeze": {
            const capture = await command("capture", {});
            await window.webContents.executeJavaScript(`
        document.getElementById('frozen').src = ${JSON.stringify("data:image/png;base64," + capture.png)};
        document.getElementById('frozen').hidden = false;
        document.getElementById('unfreeze').hidden = false;`);
            preview.view.setVisible(false);
            frozen = true;
            return capture.metadata;
        }
        case "unfreeze": {
            await window.webContents.executeJavaScript(`
        document.getElementById('frozen').hidden = true;
        document.getElementById('unfreeze').hidden = true;`);
            preview.view.setVisible(true);
            frozen = false;
            return;
        }
        case "debugState":
            return {
                attached: content().debugger.isAttached(),
                debugGeneration,
                debugEvents,
                devtoolsOpen: content().isDevToolsOpened(),
            };
        case "closeDevtools":
            content().closeDevTools();
            return;
        case "reattach":
            attach();
            return { debugGeneration };
        case "minimize":
            window.minimize();
            return;
        case "restore":
            window.restore();
            window.focus();
            return;
        case "checkpoint": {
            await window.webContents.executeJavaScript(
                `document.getElementById('instruction').textContent = ${JSON.stringify(parameters.text)}`,
            );
            window.focus();
            return;
        }
        case "quit":
            app.quit();
            return;
        default:
            fail("unsupported_fixture_operation");
    }
}
ipcMain.handle("browser-feasibility-takeover", async (event) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
        fail("invalid_fixture_sender");
    return command("takeover", {});
});
ipcMain.handle("browser-feasibility-unfreeze", async (event) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
        fail("invalid_fixture_sender");
    return command("unfreeze", {});
});
const reply = (value) => writeSync(3, JSON.stringify(value) + "\n");
// 测试进程持有私有管道；不启用全应用 CDP/Inspector 端口。
createInterface({ input: process.stdin }).on("line", async (line) => {
    const { id, operation, parameters } = JSON.parse(line);
    try {
        reply({ id, ok: true, value: await command(operation, parameters) });
    } catch (error) {
        reply({ id, ok: false, code: error.code ?? error.message });
    }
});
app.whenReady().then(async () => {
    window = new BrowserWindow({
        title: "AReaL Browser R0 Fixture",
        width: 1008,
        height: 760,
        webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            preload: join(__dirname, "preload.cjs"),
        },
    });
    preview = new CorePreview(
        window,
        WebContentsView,
        (projectId, threadId) => projectId === owner.projectId && threadId === owner.threadId,
        () => ({}),
        () => 'fixture-core',
        () => [],
        ({ origin }) => origin === new URL(process.env.AREAL_BROWSER_FIXTURE_URL).origin,
    );
    await window.loadFile(join(__dirname, "shell.html"));
    await preview.command({ operation: "show", ...owner, bounds });
    mask = new WebContentsView({
        webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            partition: `browser-r0-mask-${crypto.randomUUID()}`,
        },
    });
    mask.setBackgroundColor("#00000000");
    mask.setBounds(bounds);
    window.contentView.addChildView(mask);
    await mask.webContents.loadFile(join(__dirname, "mask.html"));
    mask.setVisible(false);
    content().on("before-input-event", (event) => {
        if (control === "agent") event.preventDefault();
    });
    content().debugger.on("detach", (_event, reason) => {
        debugGeneration++;
        lastCapture = null;
        debugEvents.push({ type: "detach", reason, generation: debugGeneration });
    });
    content().on("devtools-opened", pauseForDevtools);
    content().on("devtools-closed", () => {
        devtoolsOpening = false;
    });
    await preview.command({
        operation: "navigate",
        ...owner,
        url: process.env.AREAL_BROWSER_FIXTURE_URL,
    });
    window.on("closed", () => {
        preview.dispose();
        if (!mask.webContents.isDestroyed()) mask.webContents.close();
    });
    reply({ ready: true });
});
app.on("window-all-closed", () => app.quit());
