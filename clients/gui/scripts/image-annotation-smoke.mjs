import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applicationFixture } from "./application-fixture.mjs";
import {
  assertApplicationStopped,
  closeSmokeApplication,
  readFixtureHost,
  settleFixtureHostAfterQuit,
} from "./application-cleanup.mjs";
import { readCoreThread, withCore } from "./support/core-observation.mjs";
import { openProjectInDesktop } from "./support/journey-fixture.mjs";
import { respondToSessionName } from "./model-fixture.mjs";
import {
  captureSmokeFailure,
  createProjectConversation,
  selectConversation,
  selectCreatedConversation,
} from "./smoke-navigation.mjs";
import { withSmokeDeadline } from "./smoke-deadline.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const binary = process.env.AREAL_CORE_BIN || join(root, "target/debug/areal");
assert.equal(
  process.env.AREAL_GUI_EXECUTABLE,
  undefined,
  "This runner validates source Electron with an explicitly selected Core",
);
const scratch = await makeTempDir("areal-image-annotations-");
const evidence = join(root, ".scratch/image-annotations", `run-${Date.now()}`);
const workspace = join(scratch, "demo");
await mkdir(evidence, { recursive: true });
await mkdir(workspace);
await mkdir(join(scratch, "user/.areal"), { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  HOME: join(scratch, "user"),
  AREAL_HARNESS_HOME: join(scratch, "registry"),
  AREAL_CORE_BIN: binary,
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: join(scratch, "user"),
  AREAL_CORE_CONFIG: join(scratch, "config.toml"),
  AREAL_CORE_DESKTOP_CONFIG: join(scratch, "desktop.json"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
});
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
const json = (name, value) => writeFile(join(evidence, name), JSON.stringify(value, null, 2));
const requests = [],
  errors = [],
  checks = [],
  frames = [],
  actions = [];
const facts = { cleanup: { serviceExited: false } };
const fixtures = [join(scratch, "first/sample.png"), join(scratch, "second/sample.png")];
const coreHash = sha(await readFile(binary));
const scenarioMarkers = [
  "IMAGE_OTHER_THREAD",
  "IMAGE_ORIGINAL_DRAFT",
  "IMAGE_QUEUE_HOLD",
  "IMAGE_QUEUE_MESSAGE",
  "IMAGE_QUEUE_EDITED",
  "IMAGE_PROJECTLESS_DRAFT",
];
function inputText(content) {
  if (typeof content === "string") return content;
  assert.ok(
    Array.isArray(content),
    "Message content must be a string or an array of protocol parts",
  );
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
function scenarioUser(body, marker) {
  const markers = marker ? [marker] : scenarioMarkers;
  return body.messages.findLast(
    (message) =>
      message.role === "user" &&
      markers.some((value) => inputText(message.content).includes(value)),
  );
}
const live = new Set();
const event = (content, finish = false) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finish ? "stop" : null }] })}\n\n${finish ? "data: [DONE]\n\n" : ""}`;
const model = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    if (respondToSessionName(body, response)) return;
    requests.push(body);
    await json("model-requests.json", requests);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const businessMessage = scenarioUser(body);
    assert.ok(
      businessMessage,
      "The fixture must identify the current scenario's human message independently of runtime guidance",
    );
    if (inputText(businessMessage.content).startsWith("IMAGE_QUEUE_HOLD")) {
      response.write(event("IMAGE_QUEUE_WAITING"));
      live.add(response);
      response.on("close", () => live.delete(response));
    } else response.end(event("IMAGE_ANNOTATIONS_OK") + event("", true));
  } catch (error) {
    errors.push(error.stack);
    response.destroy();
  }
});
await new Promise((done) => model.listen(0, "127.0.0.1", done));
await writeFile(
  env.AREAL_CORE_CONFIG,
  `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nname="Fixture"\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\nmodels=[{id="fixture",enabled=true}]\n`,
);
await writeFile(
  env.AREAL_CORE_DESKTOP_CONFIG,
  JSON.stringify({
    profiles: [
      {
        id: "fixture",
        revision: "v1",
        displayName: "Fixture",
        instructions: "Read the image and its feedback.",
      },
    ],
  }),
);
let app,
  page,
  application,
  passed = false;
const button = (name) => page.getByRole("button", { name, exact: true });
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const coreObservation = { binary, env, gui, workspace };
const thread = (threadId) => readCoreThread({ ...coreObservation, threadId });
const upload = { armed: false, attempts: 0 };
let originalHost;
function routeUploadFault(socket) {
  const remote = socket.connectToServer();
  socket.onMessage((message) => {
    const frame = JSON.parse(message.toString());
    if (upload.armed && frame.method === "attachment.upload") {
      upload.attempts++;
      if (!upload.requestId) {
        assert.ok(frame.id !== undefined, "only the original upload receives the rejection");
        upload.requestId = frame.id;
        upload.reject = () => {
          socket.send(
            JSON.stringify({
              version: 1,
              id: frame.id,
              error: { code: "COMMAND_FAILED", message: "IMAGE_UPLOAD_REJECTED" },
            }),
          );
          upload.reject = undefined;
        };
        return;
      }
    }
    remote.send(message);
  });
}
async function threadIdentities() {
  const root = env.AREAL_CORE_HOME;
  const projects = (await readdir(root, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  const inventory = await Promise.all(
    projects.map(async ({ name }) => {
      const files = await readdir(join(root, name, "state")).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      return files
        .filter((file) => /^[a-f0-9-]{36}\.json$/i.test(file))
        .map((file) => `${name}:${file}`);
    }),
  );
  return inventory.flat().sort();
}
const currentId = () => page.getByTestId("areal-workbench").getAttribute("data-thread-id");
const region = () => page.getByRole("region", { name: "图片标注", exact: true });
const editor = () => region().getByRole("dialog", { name: "编辑当前标注", exact: true });
const input = () => page.getByTestId("chat-input");
const act = (label) => actions.push({ at: new Date().toISOString(), label });
async function until(read, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 100));
  } while (Date.now() < deadline);
  throw new Error(`Timeout: ${label}`);
}
async function capture(name) {
  act(name);
  await page.screenshot({
    path: join(evidence, `${name}.png`),
    animations: "disabled",
    scale: "css",
  });
  await writeFile(join(evidence, `${name}.aria.txt`), await page.locator("body").ariaSnapshot());
  frames.push(`${name}.png`);
}
async function openImage(index = 0) {
  const scope = page.getByTestId("composer-attachment");
  await scope.getByRole("button", { name: "预览图片 sample.png", exact: true }).nth(index).click();
  const preview = page.getByRole("dialog", { name: "sample.png", exact: true });
  await preview.waitFor();
  await preview.getByRole("button", { name: "标注", exact: true }).click();
  await region().waitFor();
}
async function sentImage(index, points) {
  await page
    .getByTestId("user-attachments")
    .getByRole("button", { name: "预览图片 sample.png", exact: true })
    .nth(index)
    .click();
  const preview = page.getByRole("dialog", { name: "sample.png", exact: true });
  await preview.waitFor();
  assert.equal(
    await preview.getByRole("textbox").count(),
    0,
    "Sent annotations never expose an editable note",
  );
  assert.equal(
    await preview.getByRole("button", { name: "标注", exact: true }).count(),
    0,
    "Sent image preview is read-only",
  );
  assert.equal(await preview.locator('[aria-label^="已确认标注 "]').count(), points.length);
  const positions = await preview
    .locator('[aria-label^="已确认标注 "]')
    .evaluateAll((markers) =>
      markers.map((marker) => ({ left: marker.style.left, top: marker.style.top })),
    );
  assert.deepEqual(
    positions,
    points.map(({ xPercent, yPercent }) => ({ left: `${xPercent}%`, top: `${yPercent}%` })),
    "Read-only markers render the independently expected original-image coordinates",
  );
  for (const { comment } of points) await preview.getByText(comment, { exact: false }).waitFor();
  return preview;
}
function envelopes(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("图片标注 v1："))
    .map((line) => JSON.parse(line.slice("图片标注 v1：".length)));
}
function assertEnvelopes(text, attachments, expected) {
  const notes = envelopes(text);
  assert.equal(
    notes.length,
    expected.length,
    "One persisted coordinate envelope per annotated attachment",
  );
  assert.equal(
    new Set(notes.map((note) => note.id)).size,
    notes.length,
    "Identical bytes keep independent annotation identities",
  );
  assert.deepEqual(
    notes.map((note) => ({
      version: note.version,
      attachmentIndex: note.attachmentIndex,
      name: note.name,
      width: note.width,
      height: note.height,
      points: note.points.map(({ xPercent, yPercent, comment }) => ({
        xPercent,
        yPercent,
        comment,
      })),
    })),
    expected.map((entry) => ({
      version: 1,
      name: "sample.png",
      width: 800,
      height: 400,
      ...entry,
    })),
  );
  for (const note of notes)
    assert.equal(
      note.imageUri,
      attachments[note.attachmentIndex].url ?? attachments[note.attachmentIndex].uri,
      "Envelope binds both the media occurrence and its actual Core URI",
    );
  return notes;
}
async function point(x, y) {
  const image = region().getByRole("img", { name: "标注图片 sample.png", exact: true });
  await image.evaluate((element) => element.decode());
  const box = await image.boundingBox();
  assert.ok(box?.width && box.height, "Image content must have a measured rectangle");
  assert.ok(
    Math.abs(box.width / box.height - 2) < 0.01,
    "800×400 original content keeps its aspect ratio",
  );
  const requestedPointer = { x: box.x + (box.width * x) / 100, y: box.y + (box.height * y) / 100 };
  await image.evaluate((element) => {
    globalThis.__imageAnnotationPointer = null;
    element.addEventListener(
      "click",
      (event) => {
        const rect = element.getBoundingClientRect();
        globalThis.__imageAnnotationPointer = {
          clientX: event.clientX,
          clientY: event.clientY,
          imageRectangle: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      },
      { capture: true, once: true },
    );
  });
  await page.mouse.click(requestedPointer.x, requestedPointer.y);
  await editor().waitFor();
  const observedPointer = await page.evaluate(() => globalThis.__imageAnnotationPointer);
  assert.ok(observedPointer, "The expected coordinates must come from the real image click event");
  assert.ok(
    Math.abs(observedPointer.clientX - requestedPointer.x) < 1 &&
      Math.abs(observedPointer.clientY - requestedPointer.y) < 1,
    "Chromium dispatches the requested image pointer within one CSS pixel",
  );
  const expectedPercent = {
    xPercent:
      Math.round(
        ((observedPointer.clientX - observedPointer.imageRectangle.x) /
          observedPointer.imageRectangle.width) *
          1000,
      ) / 10,
    yPercent:
      Math.round(
        ((observedPointer.clientY - observedPointer.imageRectangle.y) /
          observedPointer.imageRectangle.height) *
          1000,
      ) / 10,
  };
  facts.clicks ??= [];
  facts.clicks.push({
    requestedPercent: { x, y },
    requestedPointer,
    measuredImageRectangle: box,
    observedPointer,
    expectedPercent,
  });
  return expectedPercent;
}
async function confirm(text) {
  await editor().getByRole("textbox", { name: "标注意见", exact: true }).fill(text);
  await editor().getByRole("button", { name: "加入聊天草稿", exact: true }).click();
  await editor().waitFor({ state: "detached" });
}
async function finish() {
  await region().getByRole("button", { name: "完成标注", exact: true }).click();
  await region().waitFor({ state: "detached" });
}
async function launch() {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [application.path],
    env,
    timeout: 120000,
  });
  app
    .process()
    .stderr.on("data", (part) =>
      writeFile(join(evidence, "electron.stderr.log"), part, { flag: "a" }).catch(() => {}),
    );
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.stack));
  const ready = page.locator('[data-testid="areal-workbench"][data-startup-ready="true"]');
  await ready.waitFor({ timeout: 120000 });
  originalHost = await until(() => readFixtureHost(env), "original isolated Host");
  await page.routeWebSocket(/\/host\/socket$/, routeUploadFault);
  await page.evaluate(() => {
    const key = "areal-gui:application-preferences";
    const preferences = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(key, JSON.stringify({ ...preferences, nextPromptSuggestions: false }));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await ready.waitFor();
  await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1440, 1000);
    window.show();
    app.focus({ steal: true });
    window.focus();
  });
  const identity = await app.evaluate(({ app, BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      pid: process.pid,
      userData: app.getPath("userData"),
      sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
      electron: process.versions.electron,
    };
  });
  assert.equal(identity.userData, env.AREAL_GUI_USER_DATA);
  assert.deepEqual(
    {
      sandbox: identity.sandbox,
      contextIsolation: identity.contextIsolation,
      nodeIntegration: identity.nodeIntegration,
    },
    { sandbox: true, contextIsolation: true, nodeIntegration: false },
  );
  facts.launches ??= [];
  facts.launches.push(identity);
  await json("doctor.json", { ...identity, binary, coreHash });
}
async function close() {
  if (!app) return;
  const child = app.process();
  const host = originalHost ?? (await readFixtureHost(env));
  upload.reject?.();
  for (const response of live)
    if (!response.writableEnded && !response.destroyed) response.end(event("", true));
  await app.evaluate(({ dialog }, failed) => {
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      return { response: failed && ["question", "warning"].includes(options.type) ? 1 : 0 };
    };
  }, errors.length > 0);
  await closeSmokeApplication(app, 60_000);
  app = undefined;
  originalHost = undefined;
  const directory = join(evidence, `quit-${child.pid}`);
  await mkdir(directory);
  const receipt = await settleFixtureHostAfterQuit(binary, env, directory, {
    host,
    pid: child.pid,
  });
  facts.shutdowns ??= [];
  facts.shutdowns.push({
    mainPid: child.pid,
    hostPid: host?.pid,
    stopRequestId: receipt?.requestId,
    guiExited: true,
    serviceExited: true,
  });
}
console.log("Evidence:", evidence);
try {
  application = await applicationFixture(gui, join(scratch, "application"));
  await json("run.json", {
    scratch,
    evidence,
    env: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("AREAL_"))),
  });
  await launch();
  await page.evaluate(() => window.arealDesktop.theme("soft-glass"));
  await app.evaluate(({ nativeTheme }) => nativeTheme.emit("updated"));
  await until(
    () => page.evaluate(() => !document.documentElement.classList.contains("dark")),
    "light theme applied",
  );
  await openProjectInDesktop(app, page, workspace);
  await input().waitFor({ timeout: 60_000 });
  const projectId = await page.getByTestId("areal-workbench").getAttribute("data-project-id");
  assert.ok(projectId);
  await page.getByTestId("composer-model-trigger").click();
  await page.getByRole("radio", { name: "fixture", exact: true }).click();
  await input().fill("IMAGE_OTHER_THREAD");
  await button("发送").click();
  const otherId = await until(async () => {
    const id = await currentId();
    return id && (await thread(id)).turns.at(-1)?.status === "completed" && id;
  }, "other conversation completed");
  await createProjectConversation(page, "demo");
  await input().fill("IMAGE_ORIGINAL_DRAFT");
  const imageBytes = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 800;
      canvas.height = 400;
      const context = canvas.getContext("2d");
      context.fillStyle = "#dcecff";
      context.fillRect(0, 0, 800, 400);
      context.fillStyle = "#4085fa";
      context.fillRect(0, 0, 400, 200);
      context.fillStyle = "#c66a25";
      context.fillRect(400, 200, 400, 200);
      return canvas.toDataURL("image/png").split(",")[1];
    }),
    "base64",
  );
  for (const path of fixtures) {
    await mkdir(dirname(path));
    await writeFile(path, imageBytes);
  }
  facts.originalImage = {
    width: 800,
    height: 400,
    bytes: imageBytes.length,
    sha256: sha(imageBytes),
  };
  await page.locator("input[type=file]").setInputFiles(fixtures);
  assert.equal(await page.getByTestId("composer-attachment").count(), 2);
  const baseline = requests.length;
  await openImage();
  act("New draft image preview opens annotation pane");
  const firstPosition = await point(25, 50);
  await editor().getByRole("textbox", { name: "标注意见", exact: true }).fill("IMAGE_NOTE_FIRST");
  await editor()
    .getByRole("textbox", { name: "标注意见", exact: true })
    .evaluate((element) =>
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 229,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  assert.equal(
    await editor().isVisible(),
    true,
    "IME candidate Enter leaves the point unconfirmed",
  );
  assert.equal(
    await page.getByTestId("chat-send-button").isDisabled(),
    true,
    "Pending note blocks Composer send",
  );
  assert.equal(
    await region().getByRole("button", { name: "完成标注", exact: true }).isDisabled(),
    true,
    "Done cannot discard or implicitly confirm a pending note",
  );
  await capture("01-compact-editor-light");
  await confirm("IMAGE_NOTE_FIRST");
  await point(75, 25);
  await editor()
    .getByRole("textbox", { name: "标注意见", exact: true })
    .fill("IMAGE_PENDING_NAVIGATION");
  await selectConversation(page, otherId);
  await button("新会话").click();
  assert.equal(await input().textContent(), "IMAGE_ORIGINAL_DRAFT");
  if (!(await region().isVisible())) await openImage();
  assert.equal(
    await editor().getByRole("textbox", { name: "标注意见", exact: true }).inputValue(),
    "IMAGE_PENDING_NAVIGATION",
    "Unconfirmed note stays with the same attachment after navigation",
  );
  await editor().getByRole("button", { name: "展开批注编辑", exact: true }).click();
  assert.equal(
    await editor()
      .getByRole("button", { name: "展开批注编辑", exact: true })
      .getAttribute("aria-expanded"),
    "true",
  );
  await editor()
    .getByRole("textbox", { name: "标注意见", exact: true })
    .fill("IMAGE_NOTE_SECOND\nDETAIL");
  await editor().getByRole("textbox", { name: "标注意见", exact: true }).press("Enter");
  assert.equal(
    await editor().isVisible(),
    true,
    "Expanded Enter inserts a newline instead of confirming",
  );
  assert.equal(
    await editor().getByRole("textbox", { name: "标注意见", exact: true }).inputValue(),
    "IMAGE_NOTE_SECOND\nDETAIL\n",
  );
  await page.evaluate(() => window.arealDesktop.theme("data-dense"));
  await app.evaluate(({ nativeTheme }) => nativeTheme.emit("updated"));
  await until(
    () => page.evaluate(() => document.documentElement.classList.contains("dark")),
    "dark theme applied",
  );
  await capture("02-expanded-editor-dark");
  await confirm("IMAGE_NOTE_SECOND\nDETAIL");
  await region().getByRole("button", { name: "已确认标注 1", exact: true }).click();
  await confirm("IMAGE_NOTE_FIRST_EDITED");
  await region().getByRole("button", { name: "删除标注 2", exact: true }).click();
  assert.equal(
    await region().getByRole("button", { name: "已确认标注 2", exact: true }).count(),
    0,
    "Deleted point leaves no marker",
  );
  const secondPosition = await point(75, 25);
  await confirm("IMAGE_NOTE_SECOND_FINAL");
  const imageBeforeZoom = await region()
    .getByRole("img", { name: "标注图片 sample.png", exact: true })
    .boundingBox();
  await region().getByRole("button", { name: "放大图片", exact: true }).click();
  const imageAfterZoom = await until(async () => {
    const box = await region()
      .getByRole("img", { name: "标注图片 sample.png", exact: true })
      .boundingBox();
    return box.width > imageBeforeZoom.width && box;
  }, "image zoom is visibly applied");
  const firstMarker = await region()
    .getByRole("button", { name: "已确认标注 1", exact: true })
    .boundingBox();
  assert.ok(
    Math.abs(
      (firstMarker.x + firstMarker.width / 2 - imageAfterZoom.x) / imageAfterZoom.width -
        firstPosition.xPercent / 100,
    ) < 0.005,
    "Zoom keeps the first point at the observed original-image x coordinate",
  );
  assert.ok(
    Math.abs(
      (firstMarker.y + firstMarker.height / 2 - imageAfterZoom.y) / imageAfterZoom.height -
        firstPosition.yPercent / 100,
    ) < 0.005,
    "Zoom keeps the first point at the observed original-image y coordinate",
  );
  await region().getByRole("button", { name: "适应图片", exact: true }).click();
  await finish();
  assert.equal(requests.length, baseline, "Done never sends a message");
  assert.equal(await input().textContent(), "IMAGE_ORIGINAL_DRAFT");
  assert.equal(await page.getByTestId("composer-attachment").count(), 2);
  checks.push(
    "New draft image preview, independent 25%/50% and 75%/25% clicks, compact/expanded editor, composing Enter, pending navigation, edit/delete and Done without send",
  );
  await openImage(1);
  assert.equal(
    await region().getByRole("button", { name: "已确认标注 1", exact: true }).count(),
    0,
    "Same filename and identical bytes cannot share another attachment's notes",
  );
  const duplicatePosition = await point(50, 75);
  await confirm("IMAGE_NOTE_DUPLICATE");
  await finish();
  await capture("03-composer-confirmed");
  upload.armed = true;
  await page.getByTestId("chat-send-button").click();
  await until(() => upload.reject, "original native upload caught before dispatch");
  upload.reject();
  await page.getByRole("alert").filter({ hasText: "操作没有完成" }).waitFor();
  facts.rejectedUploadId = upload.requestId;
  const threadId = await currentId();
  assert.ok(threadId, "First-send failure keeps the accepted new conversation");
  assert.equal(requests.length, baseline, "Rejected media upload never enters the model");
  assert.equal(await input().textContent(), "IMAGE_ORIGINAL_DRAFT");
  assert.equal(await page.getByTestId("composer-attachment").count(), 2);
  await selectConversation(page, otherId);
  await selectCreatedConversation(page, projectId, threadId);
  await openImage();
  assert.equal(
    await region()
      .getByRole("button", { name: /^已确认标注 / })
      .count(),
    2,
  );
  await finish();
  assert.equal(
    upload.attempts,
    1,
    "Navigation and reopening never retry a rejected upload automatically",
  );
  assert.equal(requests.length, baseline);
  checks.push(
    "New-draft handoff and upload refusal retain the exact body, attachments and annotation identities for explicit retry",
  );
  await page.getByTestId("chat-send-button").click();
  upload.armed = false;
  const history = await until(async () => {
    const value = await thread(threadId);
    return (
      requests.length === baseline + 1 && value?.turns?.at(-1)?.status === "completed" && value
    );
  }, "annotated send completed");
  await json("history-before.json", history);
  const user = history.turns.at(-1).items.find((item) => item.type === "userMessage");
  const text = inputText(user.content);
  assert.ok(
    text.startsWith("IMAGE_ORIGINAL_DRAFT"),
    "Core history retains the original Composer body",
  );
  for (const note of ["IMAGE_NOTE_FIRST_EDITED", "IMAGE_NOTE_SECOND_FINAL", "IMAGE_NOTE_DUPLICATE"])
    assert.ok(text.includes(note), `Core history retains ${note}`);
  assert.equal(text.includes("IMAGE_PENDING_NAVIGATION"), false);
  assert.equal(text.includes("IMAGE_NOTE_SECOND\nDETAIL"), false);
  const expected = [
    {
      attachmentIndex: 0,
      points: [
        { ...firstPosition, comment: "IMAGE_NOTE_FIRST_EDITED" },
        { ...secondPosition, comment: "IMAGE_NOTE_SECOND_FINAL" },
      ],
    },
    { attachmentIndex: 1, points: [{ ...duplicatePosition, comment: "IMAGE_NOTE_DUPLICATE" }] },
  ];
  facts.coordinateEnvelopes = assertEnvelopes(
    text,
    user.content.filter((part) => part.type !== "text"),
    expected,
  );
  const lastUser = scenarioUser(requests.at(-1), "IMAGE_ORIGINAL_DRAFT");
  assert.ok(lastUser, "The model request contains the original annotated human message");
  assert.ok(
    Array.isArray(lastUser.content),
    "Annotated model message must carry structured text and original image parts",
  );
  const modelText = inputText(lastUser.content);
  assert.deepEqual(
    envelopes(modelText),
    facts.coordinateEnvelopes,
    "Model receives the same independently checked percentage coordinates as Core history",
  );
  const images = lastUser.content.filter((part) => part.type === "image_url");
  assert.equal(images.length, 2, "Each attached original is sent once without annotation crops");
  assert.deepEqual(
    images.map((part) => sha(Buffer.from(part.image_url.url.split(",")[1], "base64"))),
    [sha(imageBytes), sha(imageBytes)],
    "Model receives the exact original PNG bytes for both attachment slots",
  );
  facts.sentText = text;
  facts.sentImages = images.map((part) => ({
    sha256: sha(Buffer.from(part.image_url.url.split(",")[1], "base64")),
  }));
  assert.equal(await page.getByTestId("composer-attachment").count(), 0);
  await sentImage(0, expected[0].points);
  await capture("04-sent-readonly");
  await button("关闭图片预览").click();
  checks.push(
    "Explicit send reaches Core history and the model with each original image exactly once and distinct annotation lists for duplicate attachment bytes",
  );
  const requestCount = requests.length;
  await page.reload();
  await page.getByTestId("areal-workbench").waitFor();
  await selectConversation(page, threadId);
  await sentImage(1, expected[1].points);
  await button("关闭图片预览").click();
  await close();
  await launch();
  await createProjectConversation(page, "demo");
  await selectConversation(page, threadId);
  await sentImage(0, expected[0].points);
  await capture("05-reopened-history");
  await button("关闭图片预览").click();
  const reopened = await thread(threadId);
  await json("history-after.json", reopened);
  assert.deepEqual(
    reopened.turns,
    history.turns,
    "Renderer reload and full Electron restart preserve the persisted Core turns",
  );
  assert.equal(
    requests.length,
    requestCount,
    "History reload and restart never generate a new model request",
  );
  checks.push(
    "Renderer reload and full Electron restart restore duplicate-image point counts from Core history without an extra generation",
  );
  await selectConversation(page, otherId);
  await input().fill("IMAGE_QUEUE_HOLD");
  await page.getByTestId("chat-send-button").click();
  await until(() => live.size === 1, "held active turn for queue editing");
  const queue = () =>
    withCore(coreObservation, (client) =>
      client.request("areal/queue/list", { threadId: otherId }),
    );
  const retainedFile = join(scratch, "retained.png");
  await writeFile(retainedFile, imageBytes);
  await input().fill("IMAGE_QUEUE_MESSAGE");
  await page.locator("input[type=file]").setInputFiles([retainedFile, fixtures[0]]);
  await openImage();
  const retainedPosition = await point(20, 20);
  await confirm("IMAGE_QUEUE_RETAINED");
  await finish();
  await page.getByTestId("chat-send-button").click();
  const queued = await until(
    async () =>
      (await queue()).items.find(
        (item) =>
          item.status === "pending" && inputText(item.input).startsWith("IMAGE_QUEUE_MESSAGE"),
      ),
    "annotated message queued through Composer",
  );
  facts.queuedBefore = queued;
  const retainedNotes = assertEnvelopes(
    inputText(queued.input),
    queued.input.filter((part) => part.type !== "text"),
    [{ attachmentIndex: 1, points: [{ ...retainedPosition, comment: "IMAGE_QUEUE_RETAINED" }] }],
  );
  await page
    .locator(".composer-queue-row")
    .filter({ has: page.locator(".composer-queue-copy", { hasText: "IMAGE_QUEUE_MESSAGE" }) })
    .getByRole("button", { name: /更多操作/ })
    .click();
  await page.getByRole("menuitem", { name: "编辑消息", exact: true }).click();
  await button("保存排队消息").waitFor();
  await until(async () => (await queue()).paused, "Core confirms queue pause before editing");
  await page.getByTestId("composer-queued-attachment").nth(1).waitFor();
  assert.equal(await page.getByTestId("composer-queued-attachment").count(), 2);
  await page
    .getByTestId("composer-queued-attachment")
    .nth(0)
    .getByRole("button", { name: /^移除排队附件 / })
    .click();
  assert.equal(
    await button("保存排队消息").isEnabled(),
    true,
    "Removing retained media keeps the queued edit open until explicit Save",
  );
  assert.equal((await queue()).paused, true, "Removing retained media cannot resume the queue");
  assert.deepEqual(
    (await queue()).items.find((item) => item.id === queued.id),
    queued,
    "Removing retained media changes only the local edit, leaving the pending Core item unchanged until Save",
  );
  await page.locator("input[type=file]").setInputFiles(fixtures[1]);
  await openImage();
  const addedPosition = await point(80, 80);
  await confirm("IMAGE_QUEUE_ADDED");
  await finish();
  await input().fill("IMAGE_QUEUE_EDITED");
  await button("保存排队消息").click();
  const edited = await until(async () => {
    const entry = (await queue()).items.find((item) => item.id === queued.id);
    return inputText(entry?.input ?? []).startsWith("IMAGE_QUEUE_EDITED") && entry;
  }, "Core persists queue image metadata edit");
  const editedNotes = assertEnvelopes(
    inputText(edited.input),
    edited.input.filter((part) => part.type !== "text"),
    [
      { attachmentIndex: 0, points: [{ ...retainedPosition, comment: "IMAGE_QUEUE_RETAINED" }] },
      { attachmentIndex: 1, points: [{ ...addedPosition, comment: "IMAGE_QUEUE_ADDED" }] },
    ],
  );
  assert.equal(
    editedNotes[0].id,
    retainedNotes[0].id,
    "Retained image keeps its original annotation identity",
  );
  assert.equal(
    editedNotes[0].imageUri,
    retainedNotes[0].imageUri,
    "Removing earlier retained media changes the occurrence index without reuploading its image",
  );
  facts.queuedAfter = edited;
  await json("queue-before.json", queued);
  await json("queue-after.json", edited);
  await capture("06-queue-edited");
  for (const response of live) response.end(event("", true));
  await until(
    async () =>
      (await thread(otherId)).turns.at(-1)?.status === "completed" &&
      (await queue()).items.every((item) => item.status !== "pending" && item.status !== "running"),
    "edited queued message executes",
  );
  const queuedRequest = requests.findLast((body) =>
    inputText(scenarioUser(body)?.content ?? "").startsWith("IMAGE_QUEUE_EDITED"),
  );
  assert.ok(queuedRequest, "Edited queue metadata reaches an actual model request");
  const queuedModelUser = scenarioUser(queuedRequest, "IMAGE_QUEUE_EDITED");
  assert.ok(
    Array.isArray(queuedModelUser.content),
    "Edited queue model message retains structured image parts",
  );
  assert.deepEqual(envelopes(inputText(queuedModelUser.content)), editedNotes);
  checks.push(
    "Queue editing preserves retained image metadata, reindexes after removal, offsets new annotated media and sends the edited payload through Core",
  );
  await button("新会话").click();
  await button("在 demo 中开始新会话").click();
  await page.getByRole("menuitem", { name: "不在项目中工作", exact: true }).click();
  const beforeProjectless = await threadIdentities();
  const projectlessRequestCount = requests.length;
  await input().fill("IMAGE_PROJECTLESS_DRAFT");
  await page.locator("input[type=file]").setInputFiles(fixtures[0]);
  await openImage();
  const projectlessPosition = await point(25, 75);
  await confirm("IMAGE_PROJECTLESS_NOTE");
  await finish();
  assert.equal(requests.length, projectlessRequestCount, "Projectless Done never sends");
  assert.ok(!(await currentId()), "Projectless annotation remains a draft without a Core thread");
  assert.deepEqual(
    await threadIdentities(),
    beforeProjectless,
    "Projectless annotation does not create a hidden thread before Send",
  );
  assert.equal(await input().textContent(), "IMAGE_PROJECTLESS_DRAFT");
  await page.getByTestId("chat-send-button").click();
  const projectless = await until(async () => {
    const id = await currentId();
    const projectId = await page.getByTestId("areal-workbench").getAttribute("data-project-id");
    if (!id || !projectId || requests.length !== projectlessRequestCount + 1) return null;
    const owner = (await state()).projects.find(
      (entry) => entry.projectless && entry.id === projectId,
    );
    if (!owner) return null;
    const thread = await readCoreThread({
      ...coreObservation,
      workspace: owner.root,
      threadId: id,
    });
    return thread.turns.at(-1)?.status === "completed" && { owner, id, thread };
  }, "projectless first send persists an annotated Core thread");
  const projectlessUser = projectless.thread.turns
    .at(-1)
    .items.find((item) => item.type === "userMessage");
  const projectlessPoints = [{ ...projectlessPosition, comment: "IMAGE_PROJECTLESS_NOTE" }];
  const projectlessNotes = assertEnvelopes(
    inputText(projectlessUser.content),
    projectlessUser.content.filter((part) => part.type !== "text"),
    [{ attachmentIndex: 0, points: projectlessPoints }],
  );
  const projectlessModelUser = scenarioUser(requests.at(-1), "IMAGE_PROJECTLESS_DRAFT");
  assert.ok(
    projectlessModelUser,
    "The model request contains the projectless annotated human message",
  );
  assert.ok(
    Array.isArray(projectlessModelUser.content),
    "Projectless annotated model message retains structured image parts",
  );
  assert.deepEqual(envelopes(inputText(projectlessModelUser.content)), projectlessNotes);
  assert.deepEqual(
    projectlessModelUser.content
      .filter((part) => part.type === "image_url")
      .map((part) => sha(Buffer.from(part.image_url.url.split(",")[1], "base64"))),
    [sha(imageBytes)],
  );
  await json("projectless-history.json", projectless.thread);
  await sentImage(0, projectlessPoints);
  await capture("07-projectless-sent");
  await button("关闭图片预览").click();
  facts.projectless = {
    projectId: projectless.owner.id,
    threadId: projectless.id,
    notes: projectlessNotes,
  };
  checks.push(
    "Projectless annotation creates no thread before Send, then transfers the exact original image and coordinate note to its persisted hidden Core owner",
  );
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  errors.push(error.stack ?? String(error));
  if (page) {
    await captureSmokeFailure(page, evidence, error);
    await writeFile(
      join(evidence, "failure.aria.txt"),
      await page.locator("body").ariaSnapshot(),
    ).catch(() => {});
    await json("failure-snapshot.json", await state().catch(() => null));
  }
  process.exitCode = 1;
} finally {
  for (const response of live)
    if (!response.writableEnded && !response.destroyed) response.end(event("", true));
  await close().catch((error) => {
    errors.push(`Electron cleanup: ${error.message}`);
    passed = false;
  });
  await withSmokeDeadline(
    "owned application fixture lifetime close",
    () => application?.close(),
    10000,
  ).catch((error) => {
    errors.push(`Application cleanup: ${error.message}`);
    passed = false;
  });
  try {
    await assertApplicationStopped(binary, env, { hostPid: originalHost?.pid });
    await until(
      () => (facts.launches ?? []).every((identity) => !alive(identity.pid)),
      "owned GUI Main processes exit",
      15000,
    );
    facts.cleanup.serviceExited = true;
    facts.cleanup.guiExited = true;
  } catch (error) {
    errors.push(`Core cleanup: ${error.message}`);
    passed = false;
  }
  model.closeAllConnections();
  await new Promise((done) => model.close(done));
  if (sha(await readFile(binary)) !== coreHash) {
    errors.push("Core binary changed during the run");
    passed = false;
  }
  if (passed && facts.cleanup.serviceExited) {
    await rm(scratch, { recursive: true });
    facts.cleanup.instanceDataRemoved = true;
  }
  await json("cleanup.json", facts.cleanup);
  await json("actions.json", actions);
  await json("model-requests.json", requests);
  const modified = execFileSync(
    "git",
    ["ls-files", "--modified", "--others", "--exclude-standard", "-z"],
    { cwd: root },
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  const sourceFiles = {};
  for (const path of modified)
    sourceFiles[path] = await readFile(join(root, path))
      .then(sha)
      .catch(() => null);
  await json("manifest.json", {
    passed,
    checks,
    errors,
    facts,
    frames,
    scratch,
    evidence,
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    sourceFiles,
    diffSHA256: sha(
      execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: root, maxBuffer: 32 * 1024 * 1024 }),
    ),
    binary,
    coreSHA256: coreHash,
    runtime: "source Electron/Main + Rust Host + real Core/Runtime + deterministic local model",
    boundaries:
      "Native project picker fixture, actual file input, synthetic composing Enter; no real provider, OS IME candidate UI or packaged acceptance",
  });
  if (!passed) process.exitCode = 1;
  console.log(JSON.stringify({ passed, evidence, checks, errors }));
}
