import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const fixturePng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP438DwHwAGgAJ/EEwb4QAAAABJRU5ErkJggg==";

async function insertDraftFixture(page, draftKey) {
  const id = randomUUID();
  await page.evaluate(
    ({ id, draftKey, png }) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("areal-snapshot-drafts", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("captures", { keyPath: "id" });
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const transaction = db.transaction("captures", "readwrite");
          const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
          transaction.objectStore("captures").put({
            id,
            draftKey,
            state: "attached",
            file: new File([bytes], "SNAPSHOTS_SYNTHETIC_WINDOW.png", { type: "image/png" }),
            source: {
              kind: "snap-shot",
              capturedAt: "2026-01-01T00:00:00.000Z",
              appName: "Snapshot fixture",
              windowTitle: "SNAPSHOTS_SYNTHETIC_WINDOW",
              accessibleText: "SNAPSHOTS_SYNTHETIC_TEXT",
            },
          });
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onerror = transaction.onabort = () => reject(transaction.error);
        };
      }),
    { id, draftKey, png: fixturePng },
  );
}

async function verifyDraftFixture({
  page,
  reopen,
  state,
  project,
  until,
  received,
  checks,
  shot,
  nativeCaptured,
  settingsComplete,
}) {
  const input = () => page.getByTestId("chat-input");
  const projectId = project(await state()).id;
  const threadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  const key = `areal-gui:draft:${projectId}:${threadId || "new"}`;
  await input().fill("SNAPSHOTS_DRAFT_FIXTURE");
  if (!nativeCaptured) await insertDraftFixture(page, key);
  page = await reopen();
  const restored = (await page.evaluate(() => window.arealDesktop.getSnapShotState())).settings;
  assert.equal(restored.snapShotEnabled, settingsComplete, "enabled state persists across restart");
  if (settingsComplete) {
    assert.equal(restored.snapShotSound, "camera-shutter");
    assert.equal(restored.snapShotPlaySound, true);
    assert.equal(restored.snapShotFlash, false);
    assert.equal(restored.snapShotShortcut.key, "9");
    assert.equal(restored.snapShotShortcut.ctrlKey, true);
    assert.equal(restored.snapShotShortcut.altKey, true);
    checks.push("shortcut, sound and flash settings persist across restart");
  } else checks.push("finish later remains disabled across restart");
  await input().waitFor();
  assert.equal(await input().textContent(), "SNAPSHOTS_DRAFT_FIXTURE");
  const draftCard = page.getByTestId("snapshot-attachment");
  await draftCard.waitFor();
  const draftBounds = await draftCard.boundingBox();
  assert.equal(
    draftBounds.width,
    208,
    "snapshot draft card matches T3 width at the fixed test zoom",
  );
  assert.equal(
    draftBounds.height,
    112,
    "snapshot draft card matches T3 height at the fixed test zoom",
  );
  await shot("snapshots-fixture-restored");
  const count = received.length;
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await until(
    (snapshot) =>
      received.length > count &&
      Object.values(project(snapshot).state.threads).some(
        (thread) => thread.turns?.at(-1)?.status === "completed",
      ),
    "snapshot fixture message completed",
  );
  const body = JSON.stringify(received.at(-1));
  assert.match(body, /SNAPSHOTS_DRAFT_FIXTURE/);
  assert.match(body, /SNAPSHOTS_SYNTHETIC_WINDOW/);
  if (!nativeCaptured) assert.match(body, /SNAPSHOTS_SYNTHETIC_TEXT/);
  assert.match(body, /image_url|input_image/);
  const sentCount = received.length;
  page = await reopen();
  const historyCard = page.getByTestId("snapshot-attachment");
  await historyCard.waitFor();
  assert.match(await historyCard.textContent(), /SNAPSHOTS_SYNTHETIC_WINDOW/);
  const historyBounds = await historyCard.boundingBox();
  assert.equal(historyBounds.width, 208, "historical snapshot retains the T3 card width");
  assert.equal(historyBounds.height, 112, "historical snapshot retains the T3 card height");
  assert.equal(received.length, sentCount, "history restore does not send another model request");
  await shot("snapshots-history-restored");
  checks.push(
    "sent snapshot source and image card survive a second cold restart without a model request",
  );
  checks.push(
    nativeCaptured
      ? "native API captured synthetic foreground window; its draft survives restart and reaches the local model as image plus source context; global shortcut not asserted"
      : "synthetic IndexedDB draft fixture survives restart and sends image plus labeled source context to local model; native capture and AX not exercised",
  );
  return page;
}

export async function runSnapShotsAcceptance(options) {
  const { app, checks, shot } = options;
  let { page } = options;
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "SnapShots", exact: true }).click();
  const settings = page.getByTestId("snapshot-settings");
  await settings.waitFor();
  const permission = await page.evaluate(() => window.arealDesktop.getSnapShotState());
  assert.equal(permission.settings.snapShotEnabled, false, "isolated profile starts disabled");
  await page.getByRole("switch", { name: "SnapShots", exact: true }).click();
  const wizard = page.getByTestId("snapshot-setup-dialog");
  await wizard.waitFor();
  const labels = ["SnapShots", "包含应用文本", "捕获快捷键", "捕获声音", "捕获闪光", "捕获动画"];
  for (const label of labels)
    assert((await settings.textContent()).includes(label), `setting row ${label}`);
  await shot("snapshots-settings-access");
  checks.push(
    "six settings rows render in the enabled isolated profile; setup permission dialog is visible",
  );
  let nativeCaptured = false;
  let accessibility = false;
  if (permission.mode === "direct" && permission.macPermissions?.screenRecording) {
    await app.evaluate(async ({ BrowserWindow }) => {
      const target = new BrowserWindow({
        width: 640,
        height: 400,
        show: false,
        title: "SNAPSHOTS_SYNTHETIC_WINDOW",
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      globalThis.snapshotAcceptanceWindow = target;
      await target.loadURL(
        "data:text/html,<title>SNAPSHOTS_SYNTHETIC_WINDOW</title><h1>SNAPSHOTS_SYNTHETIC_TEXT</h1>",
      );
      target.show();
      target.focus();
    });
    try {
      const focused = await app.evaluate(({ BrowserWindow }) => ({
        matches: BrowserWindow.getFocusedWindow() === globalThis.snapshotAcceptanceWindow,
        title: globalThis.snapshotAcceptanceWindow.getTitle(),
      }));
      assert.deepEqual(
        focused,
        { matches: true, title: "SNAPSHOTS_SYNTHETIC_WINDOW" },
        "synthetic test window is foreground before capture",
      );
      await page.evaluate(() => window.arealDesktop.captureSnapShot());
      await options.until(
        async () =>
          page.evaluate(
            () =>
              new Promise((resolve, reject) => {
                const open = indexedDB.open("areal-snapshot-drafts", 1);
                open.onerror = () => reject(open.error);
                open.onsuccess = () => {
                  const db = open.result;
                  const tx = db.transaction("captures", "readonly");
                  const request = tx.objectStore("captures").getAll();
                  request.onsuccess = () =>
                    resolve(
                      request.result.some(
                        (record) =>
                          record.state === "attached" &&
                          record.source?.windowTitle === "SNAPSHOTS_SYNTHETIC_WINDOW",
                      ),
                    );
                  tx.oncomplete = () => db.close();
                  tx.onerror = () => reject(tx.error);
                };
              }),
          ),
        "native synthetic capture attached",
      );
      const source = await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const open = indexedDB.open("areal-snapshot-drafts", 1);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const db = open.result;
              const tx = db.transaction("captures", "readonly");
              const request = tx.objectStore("captures").getAll();
              request.onsuccess = () => {
                const record = request.result.find(
                  (value) =>
                    value.state === "attached" &&
                    value.source?.windowTitle === "SNAPSHOTS_SYNTHETIC_WINDOW",
                );
                const { appIconDataUrl: _icon, ...source } = record.source;
                resolve(source);
              };
              tx.oncomplete = () => db.close();
              tx.onerror = () => reject(tx.error);
            };
          }),
      );
      await writeFile(
        join(options.scratch, "snapshots-synthetic-source.json"),
        JSON.stringify(source, null, 2),
      );
      if (permission.macPermissions.accessibility) {
        assert.match(
          JSON.stringify(source),
          /SNAPSHOTS_SYNTHETIC_TEXT/,
          "native AX context contains synthetic window text",
        );
        accessibility = true;
        checks.push("native AX context contains synthetic window text");
      }
      nativeCaptured = true;
    } finally {
      await app.evaluate(() => {
        globalThis.snapshotAcceptanceWindow?.close();
      });
    }
  } else {
    checks.push(
      `BLOCKED native capture: mode=${permission.mode}, screenRecording=${permission.macPermissions?.screenRecording ?? "unknown"}, accessibility=${permission.macPermissions?.accessibility ?? "unknown"}; no permission request was issued`,
    );
  }
  let settingsComplete = false;
  if (
    permission.mode === "direct" &&
    permission.macPermissions?.screenRecording &&
    permission.macPermissions?.accessibility
  ) {
    await page.bringToFront();
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => {
        const focused = BrowserWindow.getFocusedWindow();
        return !!focused && focused !== globalThis.snapshotAcceptanceWindow;
      }),
      true,
      "isolated settings window is focused for setup test capture",
    );
    await wizard.getByTestId("snapshot-setup-continue").click();
    const recorder = wizard.getByTestId("snapshot-shortcut-recorder");
    await recorder.waitFor();
    await recorder.click();
    await options.until(
      async () => (await recorder.getAttribute("aria-pressed")) === "true",
      "shortcut recording started",
    );
    await page.keyboard.press("Control+Alt+9");
    const finish = wizard.getByTestId("snapshot-setup-finish");
    await options.until(async () => finish.isEnabled(), "independent shortcut available");
    await finish.click();
    await wizard.waitFor({ state: "hidden" });
    const sound = page.getByRole("button", { name: "捕获声音", exact: true });
    await sound.click();
    for (const label of ["Whoosh（默认）", "Click", "关闭"])
      await page.getByRole("menuitemradio", { name: label, exact: true }).waitFor();
    await page.getByRole("menuitemradio", { name: "关闭", exact: true }).click();
    await options.until(
      async () =>
        !(await page.evaluate(() => window.arealDesktop.getSnapShotState())).settings
          .snapShotPlaySound,
      "sound off persisted",
    );
    await sound.click();
    await page.getByRole("menuitemradio", { name: "Click", exact: true }).click();
    await options.until(async () => {
      const current = (await page.evaluate(() => window.arealDesktop.getSnapShotState())).settings;
      return current.snapShotPlaySound && current.snapShotSound === "camera-shutter";
    }, "click sound persisted");
    await page.getByRole("switch", { name: "捕获闪光", exact: true }).click();
    await options.until(
      async () =>
        !(await page.evaluate(() => window.arealDesktop.getSnapShotState())).settings.snapShotFlash,
      "flash disabled",
    );
    settingsComplete = true;
    checks.push(
      "isolated setup capture, shortcut recorder, three sound choices and flash setting exercised through UI",
    );
    await shot("snapshots-settings-configured");
  } else {
    checks.push(
      `INCOMPLETE setup and settings interaction: screenRecording=${permission.macPermissions?.screenRecording ?? "unknown"}, accessibility=${permission.macPermissions?.accessibility ?? "unknown"}; no permission grant attempted`,
    );
    await wizard.getByRole("button", { name: "稍后完成", exact: true }).click();
    await wizard.waitFor({ state: "hidden" });
  }
  await page.getByRole("button", { name: "返回应用", exact: true }).click();
  await verifyDraftFixture({ ...options, page, nativeCaptured, settingsComplete });
  return {
    nativeCapture: nativeCaptured,
    settings: settingsComplete,
    draftRecovery: true,
    modelDelivery: true,
    historyRecovery: true,
    globalShortcut: false,
    accessibility,
    permissions: permission.macPermissions ?? null,
  };
}
