import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import {
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { trackedMkdtemp } from "./support/host-cleanup.cjs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applicationFixture } from "./application-fixture.mjs";
import { assertApplicationStopped } from "./application-cleanup.mjs";
import { respondToSessionName } from "./model-fixture.mjs";
import { captureSmokeFailure } from "./smoke-navigation.mjs";
import { withSmokeDeadline } from "./smoke-deadline.mjs";

const script = fileURLToPath(import.meta.url);
const gui = resolve(dirname(script), "..");
const root = resolve(gui, "../..");
const sourceGui = resolve(process.env.AREAL_TURN_NAV_GUI_DIR || gui);
const sourceApp = join(sourceGui, "app");
const sourcePackages = join(sourceGui, "packages");
const sourceRenderer = resolve(
  process.env.AREAL_TURN_NAV_RENDERER_DIR || join(sourceGui, "renderer/dist"),
);
const binary = process.env.AREAL_CORE_BIN;
assert.ok(
  binary && isAbsolute(binary),
  "Set AREAL_CORE_BIN to the absolute fixed Core binary path",
);
assert.equal(
  process.env.AREAL_GUI_EXECUTABLE,
  undefined,
  "This runner accepts the source Electron app only",
);
const require = createRequire(join(sourceApp, "package.json"));
const { _electron: electron } = require("playwright-core");
const { executeCore } = require(join(gui, "scripts/support/core-process-fixture.cjs"));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(join(root, ".scratch/gui-evidence"), { recursive: true });
const scratch = await trackedMkdtemp(join(root, ".scratch/gui-evidence/turn-navigation-"));
const state = await makeTempDir("atn-");
await writeFile(join(state, ".owner"), scratch);
const applicationRoot = join(scratch, "application");
const workspace = join(state, "workspace");
const projectId = sha(workspace).slice(0, 24);
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
}
Object.assign(env, {
  AREAL_GUI: "workbench",
  AREAL_BACKEND: "areal",
  AREAL_CORE_BIN: binary,
  AREAL_CORE_CONFIG: join(state, "config.toml"),
  AREAL_HARNESS_HOME: join(state, "config-home"),
  AREAL_CORE_HOME: join(state, "core"),
  AREAL_CORE_USER_HOME: join(state, "user"),
  AREAL_CORE_WORKSPACE: workspace,
  AREAL_HARNESS_SERVICE_HOME: join(state, "registry"),
  AREAL_GUI_USER_DATA: join(state, "electron"),
  NO_PROXY: [env.NO_PROXY, "127.0.0.1,localhost,::1"].filter(Boolean).join(","),
  no_proxy: [env.no_proxy, "127.0.0.1,localhost,::1"].filter(Boolean).join(","),
});
const panels = [
  {
    name: "main",
    scope: "MAIN",
    shell: ".conversation-pane > .messages-shell",
    input: "chat-input",
    send: "chat-send-button",
  },
  {
    name: "side",
    scope: "SIDE",
    shell: ".side-chat-transcript > .messages-shell",
    input: "side-chat-input",
    send: "side-chat-send",
  },
];
const requests = [],
  commands = [],
  checks = [],
  geometry = [],
  frames = [],
  pageErrors = [],
  stderr = [],
  modelErrors = [];
const held = new Map();
const run = {
  evidence: scratch,
  state,
  workspace,
  projectId,
  binary,
  registry: env.AREAL_HARNESS_SERVICE_HOME,
  desktopHome: env.AREAL_CORE_HOME,
  environment: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("AREAL_"))),
  boundaries: {
    history:
      "The first main and Side prompts use their real Composer. Remaining history uses public desktop send/side commands, through real Main/Desktop/Core, as a fixture boundary.",
    navigation:
      "Real rendered DOM pointer and keyboard actions. DOM evaluation only reads geometry, focus, text and authoritative desktop snapshots.",
    model:
      "Deterministic loopback SSE replaces the external model provider. No credentials or remote providers.",
    artifact:
      "Frozen source Electron Main/preload/packages and a copied built renderer. External locked node_modules remain linked.",
    excluded: ["physical input", "native file dialog", "real provider", "packaged app", "signing"],
  },
};
let app,
  page,
  application,
  server,
  passed = false,
  failure,
  cleanupResult;
const saveRun = () => json(join(scratch, "run.json"), run);
const snapshot = () =>
  withSmokeDeadline("desktop snapshot", () => page.evaluate(() => window.arealDesktop.snapshot()));
const project = (value) => value.projects.find((item) => item.id === projectId);
const thread = (value, panel) => project(value)?.state?.threads?.[panel.threadId];
const prompt = (scope, ordinal) =>
  `TURN_NAV_${scope}_${String(ordinal).padStart(2, "0")} question ${ordinal}`;
const replyPrefix = (scope, ordinal) => `Reply ${scope} ${String(ordinal).padStart(2, "0")}`;
const sseChunk = (content) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
const sseEnd =
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\ndata: [DONE]\n\n';

async function until(read, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(50);
  }
  throw Error(`Timed out waiting for ${label}`);
}

async function checkpoint(step) {
  run.step = step;
  console.log(JSON.stringify({ step }));
  await saveRun();
}

async function artifactFiles(directory) {
  const files = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, hash] of Object.entries(await artifactFiles(path)))
        files[`${entry.name}/${name}`] = hash;
    } else {
      assert.ok(entry.isFile(), `frozen artifact must be a regular file ${path}`);
      files[entry.name] = sha(await readFile(path));
    }
  }
  return files;
}

async function linkDependencies(source, target) {
  let entries;
  try {
    entries = await readdir(join(source, "node_modules"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  await mkdir(join(target, "node_modules"), { recursive: true });
  for (const name of entries) {
    if (name === "@areal") {
      await mkdir(join(target, "node_modules/@areal"));
      for (const dependency of await readdir(join(source, "node_modules/@areal"))) {
        await symlink(
          join(applicationRoot, "packages", dependency),
          join(target, "node_modules/@areal", dependency),
          "dir",
        );
      }
    } else
      await symlink(join(source, "node_modules", name), join(target, "node_modules", name), "dir");
  }
}

async function freeze() {
  const sources = { app: sourceApp, packages: sourcePackages, renderer: sourceRenderer };
  const targets = {
    app: join(applicationRoot, "app"),
    packages: join(applicationRoot, "packages"),
    renderer: join(applicationRoot, "renderer/dist"),
  };
  run.artifacts = {};
  for (const [name, source] of Object.entries(sources)) {
    const files = await artifactFiles(source);
    if (name === "renderer") assert.ok(files["index.html"], "built renderer index exists");
    await cp(source, targets[name], {
      recursive: true,
      filter: (path) => !path.split("/").includes("node_modules"),
    });
    assert.deepEqual(await artifactFiles(source), files, `${name} stayed stable while frozen`);
    assert.deepEqual(
      await artifactFiles(targets[name]),
      files,
      `${name} frozen copy matches source`,
    );
    run.artifacts[name] = { source, path: targets[name], files };
  }
  await linkDependencies(sourceApp, targets.app);
  for (const entry of await readdir(sourcePackages, { withFileTypes: true })) {
    if (entry.isDirectory())
      await linkDependencies(join(sourcePackages, entry.name), join(targets.packages, entry.name));
  }
  for (const dependency of Object.keys(
    require(join(sourceApp, "package.json")).dependencies,
  ).filter((name) => name.startsWith("@areal/"))) {
    assert.ok(
      (await realpath(join(targets.app, "node_modules", dependency))).startsWith(
        targets.packages + "/",
      ),
      `${dependency} resolves to the frozen package`,
    );
  }
  run.source = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    status: execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }),
    guiDiffSha256: sha(
      execFileSync("git", ["diff", "--binary", "HEAD", "--", "clients/gui"], {
        cwd: root,
        maxBuffer: 32 * 1024 * 1024,
      }),
    ),
    scriptSha256: sha(await readFile(script)),
    coreSha256: sha(await readFile(binary)),
    guiSource: sourceGui,
    lockSha256: sha(await readFile(join(sourceGui, "pnpm-lock.yaml"))),
    rendererSources: Object.fromEntries(
      await Promise.all(
        ["TurnNavigation.tsx", "Messages.tsx", "SideChatPane.tsx", "workbench.css"].map(
          async (path) => [path, sha(await readFile(join(sourceGui, "renderer/src", path)))],
        ),
      ),
    ),
  };
  await saveRun();
}

async function fixtureCommand(name, parameters) {
  const result = await page.evaluate(
    async ({ name, parameters }) => window.arealDesktop.command(name, parameters),
    { name, parameters },
  );
  commands.push({ boundary: "history fixture", name, parameters, result });
  assert.equal(result.ok, true, `fixture ${name} accepted ${JSON.stringify(result)}`);
  return result;
}

async function waitTurn(panel, count, status = "completed") {
  return until(async () => {
    const value = await snapshot();
    const turns = thread(value, panel)?.turns;
    return (
      turns?.length === count &&
      turns.at(-1)?.status === status &&
      turns.at(-1)?.items?.some((item) => item.type === "agentMessage" && item.text) &&
      value
    );
  }, `${panel.name} Core turn ${count} ${status}`);
}

async function sendUI(panel, text) {
  const before = panel.threadId ? thread(await snapshot(), panel).turns.length : 0;
  await page.getByTestId(panel.input).fill(text);
  await page.getByTestId(panel.send).click();
  if (!panel.threadId) {
    await until(async () => {
      const value = await snapshot();
      panel.threadId =
        panel.name === "main"
          ? await page.getByTestId("areal-workbench").getAttribute("data-thread-id")
          : Object.values(project(value)?.state?.threads ?? {}).find(
              (item) => item.conversation?.kind === "side",
            )?.id;
      return panel.threadId;
    }, `${panel.name} created by Composer`);
  }
  await waitTurn(panel, before + 1, text.endsWith("_STREAM") ? "inProgress" : "completed");
}

async function measure(panel) {
  return page.locator(panel.shell).evaluate((shell) => {
    const rect = (element) => {
      const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
      return { left, top, right, bottom, width, height };
    };
    const body = shell.querySelector(".messages");
    const rail = shell.querySelector(".turn-navigation");
    const buttons = [...rail.querySelectorAll("button")].map((button, index) => ({
      index,
      ...rect(button),
      label: button.getAttribute("aria-label"),
      focused: document.activeElement === button,
      current: button.getAttribute("aria-current"),
      marker: rect(button.querySelector(".turn-marker")),
    }));
    const tooltipId = rail.querySelector("[aria-describedby]")?.getAttribute("aria-describedby");
    const tooltip = tooltipId && document.getElementById(tooltipId);
    return {
      shell: rect(shell),
      body: {
        ...rect(body),
        scrollTop: body.scrollTop,
        scrollHeight: body.scrollHeight,
        clientHeight: body.clientHeight,
      },
      rail: {
        ...rect(rail),
        scrollTop: rail.scrollTop,
        scrollHeight: rail.scrollHeight,
        clientHeight: rail.clientHeight,
      },
      buttons,
      tooltip: tooltip ? { ...rect(tooltip), text: tooltip.innerText } : null,
      turns: [...body.querySelectorAll("[data-turn-id]")].map((turn) => ({
        id: turn.dataset.turnId,
        ...rect(turn),
      })),
    };
  });
}

const scrolls = () =>
  Promise.all(
    panels.map(async (panel) => ({ name: panel.name, top: (await measure(panel)).body.scrollTop })),
  );
function sameScroll(before, after, label) {
  for (let index = 0; index < before.length; index++)
    assert.ok(
      Math.abs(before[index].top - after[index].top) <= 1,
      `${label} preserves ${before[index].name} scrollTop ${before[index].top} -> ${after[index].top}`,
    );
}
function previewInside(value, panel, ordinal) {
  assert.ok(value.tooltip, `${panel.name} preview is visible`);
  assert.ok(
    value.tooltip.text.includes(prompt(panel.scope, ordinal)),
    `${panel.name} preview contains literal question ${ordinal}`,
  );
  assert.ok(
    value.tooltip.text.includes(replyPrefix(panel.scope, ordinal)),
    `${panel.name} preview contains literal reply ${ordinal}`,
  );
  assert.match(
    value.tooltip.text,
    new RegExp(`第\\s*${ordinal}\\s*轮|(?:^|\\D)${ordinal}\\s*[/／]\\s*\\d+`),
    `${panel.name} preview contains ordinal ${ordinal}`,
  );
  for (const edge of ["left", "top"])
    assert.ok(
      value.tooltip[edge] >= value.shell[edge] - 1,
      `${panel.name} preview ${edge} stays in its transcript`,
    );
  for (const edge of ["right", "bottom"])
    assert.ok(
      value.tooltip[edge] <= value.shell[edge] + 1,
      `${panel.name} preview ${edge} stays in its transcript`,
    );
}
function visibleButton(value, index, label) {
  const button = value.buttons[index];
  assert.ok(
    button.top >= value.rail.top - 1 && button.bottom <= value.rail.bottom + 1,
    `${label} target ${index + 1} is visible in its rail`,
  );
}

async function shot(name) {
  await page.screenshot({ path: join(scratch, name), scale: "css", animations: "disabled" });
  frames.push(name);
}

async function hoverCase(panel, suffix = "") {
  await page.getByTestId(panel.input).focus();
  const initial = await measure(panel);
  await page.mouse.move(initial.shell.right - 12, initial.shell.top + 12);
  await until(
    async () =>
      (await measure(panel)).buttons.every((button) => Math.abs(button.marker.width - 6) <= 0.6),
    `${panel.name} idle marker lengths`,
  );
  const baseline = await measure(panel);
  const visible = baseline.buttons.filter(
    (button) => button.top >= baseline.rail.top && button.bottom <= baseline.rail.bottom,
  );
  assert.ok(visible.length >= 5, `${panel.name} rail exposes five neighboring turns`);
  const target = visible[Math.floor(visible.length / 2)];
  const beforeScroll = await scrolls();
  await page.mouse.move(target.left + target.width / 2, target.top + target.height / 2);
  let previousWidths,
    stable = 0;
  const hovered = await until(async () => {
    const value = await measure(panel);
    const widths = value.buttons.map((button) => button.marker.width);
    stable =
      previousWidths &&
      widths.every((width, index) => Math.abs(width - previousWidths[index]) <= 0.08)
        ? stable + 1
        : 0;
    previousWidths = widths;
    return (
      stable >= 2 &&
      value.tooltip?.text.includes(prompt(panel.scope, target.index + 1)) &&
      widths[target.index] > 24 &&
      value
    );
  }, `${panel.name} pointer ripple settled`);
  const middle = hovered.buttons[target.index].marker;
  for (const offset of [-2, -1, 1, 2]) {
    const neighbor = hovered.buttons[target.index + offset].marker;
    assert.ok(
      neighbor.width > 6.5 && neighbor.width < middle.width,
      `${panel.name} neighbor ${offset} ripples below its peak`,
    );
    assert.ok(
      Math.abs(neighbor.left - middle.left) <= 0.6,
      `${panel.name} ripple has fixed left anchors`,
    );
    assert.ok(
      Math.abs(neighbor.left - baseline.buttons[target.index + offset].marker.left) <= 0.6,
      `${panel.name} neighbor left anchor does not move`,
    );
  }
  for (const direction of [-1, 1])
    assert.ok(
      hovered.buttons[target.index + direction].marker.width >
        hovered.buttons[target.index + 2 * direction].marker.width,
      `${panel.name} ripple tapers away from the pointer`,
    );
  assert.ok(
    Math.abs(middle.left - baseline.buttons[target.index].marker.left) <= 0.6,
    `${panel.name} central left anchor does not move`,
  );
  sameScroll(beforeScroll, await scrolls(), `${panel.name} hover`);
  previewInside(hovered, panel, target.index + 1);
  assert.ok(hovered.rail.height <= 241, `${panel.name} long rail is capped at 240px`);
  assert.ok(
    hovered.rail.scrollHeight > hovered.rail.clientHeight,
    `${panel.name} long history exercises rail scrolling`,
  );
  geometry.push({ case: `${panel.name}-hover${suffix}`, baseline, hovered });
  await shot(`${panel.name}-hover${suffix}.png`);
  await page.mouse.move(target.left + target.width / 2, target.top + target.height * 0.85);
  const fractional = await until(async () => {
    const value = await measure(panel);
    return (
      value.buttons[target.index].marker.width < middle.width - 0.3 &&
      value.buttons[target.index + 1].marker.width >
        hovered.buttons[target.index + 1].marker.width + 0.8 &&
      value.tooltip?.text.includes(prompt(panel.scope, target.index + 1)) &&
      value
    );
  }, `${panel.name} fractional pointer position changes lengths within one turn`);
  geometry.push({ case: `${panel.name}-fractional${suffix}`, value: fractional });
  sameScroll(beforeScroll, await scrolls(), `${panel.name} continuous pointer movement`);
  await page.keyboard.press("Escape");
  await until(
    async () => !(await measure(panel)).tooltip,
    `${panel.name} pointer preview closes with Composer focused`,
  );
  assert.equal(
    await page.getByTestId(panel.input).evaluate((element) => document.activeElement === element),
    true,
    `${panel.name} pointer preview never takes Composer focus`,
  );
  await page.mouse.move(initial.shell.right - 12, initial.shell.top + 12);
  await until(async () => {
    const value = await measure(panel);
    return (
      !value.tooltip && value.buttons.every((button) => Math.abs(button.marker.width - 6) <= 0.6)
    );
  }, `${panel.name} leave restores marker lengths`);
  checks.push(
    `${panel.name} hover${suffix} has tapered lengths, fixed left anchors, a bounded literal preview, no transcript scroll and a settled leave`,
  );
}

async function aligned(panel, index, label) {
  const value = await until(
    async () => {
      const current = await measure(panel);
      return Math.abs(current.turns[index].top - current.body.top - 24) <= 3 && current;
    },
    `${panel.name} ${label} aligns turn ${index + 1}`,
  );
  geometry.push({ case: `${panel.name}-${label}`, value });
  return value;
}

async function clickCase(panel, index = 3) {
  const other = panels.find((item) => item !== panel);
  const otherBefore = (await measure(other)).body.scrollTop;
  await page.locator(panel.shell).locator(".turn-navigation button").nth(index).click();
  await aligned(panel, index, "click");
  assert.ok(
    Math.abs((await measure(other)).body.scrollTop - otherBefore) <= 1,
    `${panel.name} click preserves ${other.name} reading position`,
  );
  await shot(`${panel.name}-clicked.png`);
  checks.push(`${panel.name} click aligns the known earlier turn and preserves the other panel`);
}

async function keyboardCase(panel) {
  const rail = page.locator(panel.shell).locator(".turn-navigation");
  const value = await measure(panel);
  const visible = value.buttons.find(
    (button) => button.top >= value.rail.top && button.bottom <= value.rail.bottom,
  );
  await rail.locator("button").nth(visible.index).focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  assert.ok(
    (await measure(panel)).buttons.some((button) => button.focused),
    `${panel.name} Tab enters the rail`,
  );
  for (const [key, index] of [
    ["Home", 0],
    ["ArrowDown", 1],
    ["ArrowUp", 0],
    ["End", 35],
  ]) {
    const before = await scrolls();
    await page.keyboard.press(key);
    const selected = await until(
      async () => {
        const current = await measure(panel);
        return (
          current.buttons[index].focused &&
          current.tooltip?.text.includes(prompt(panel.scope, index + 1)) &&
          current
        );
      },
      `${panel.name} ${key} selects turn ${index + 1}`,
    );
    sameScroll(before, await scrolls(), `${panel.name} ${key}`);
    previewInside(selected, panel, index + 1);
    visibleButton(selected, index, `${panel.name} ${key}`);
  }
  await shot(`${panel.name}-keyboard-end.png`);
  const other = panels.find((item) => item !== panel);
  const otherTop = (await measure(other)).body.scrollTop;
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await aligned(panel, 1, "keyboard-enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await aligned(panel, 2, "keyboard-space");
  assert.ok(
    Math.abs((await measure(other)).body.scrollTop - otherTop) <= 1,
    `${panel.name} keyboard jumps preserve the other panel`,
  );
  await page.keyboard.press("Home");
  await until(
    async () => (await measure(panel)).tooltip?.text.includes(prompt(panel.scope, 1)),
    `${panel.name} preview is open before Escape`,
  );
  const beforeEscape = await scrolls();
  await page.keyboard.press("Escape");
  await until(async () => !(await measure(panel)).tooltip, `${panel.name} Escape closes preview`);
  sameScroll(beforeEscape, await scrolls(), `${panel.name} Escape`);
  await page.getByTestId(panel.input).focus();
  checks.push(
    `${panel.name} Tab, arrows, Home and End select visible previews without body scrolling; Enter and Space jump; Escape closes`,
  );
}

async function streamCase(panel) {
  await sendUI(panel, `TURN_NAV_${panel.scope}_STREAM`);
  await until(() => held.has(panel.scope), `${panel.name} stream barrier`);
  await clickCase(panel);
  const before = await scrolls();
  const scrollHeight = (await measure(panel)).body.scrollHeight;
  const response = held.get(panel.scope);
  response.end(
    sseChunk(
      Array.from({ length: 44 }, (_, index) =>
        `\n\nStream growth ${panel.scope} paragraph ${index + 1}. Historical reading stays in place. `.repeat(
          3,
        ),
      ).join(""),
    ) + sseEnd,
  );
  await waitTurn(panel, 37);
  await until(
    async () =>
      (await page
        .locator(panel.shell)
        .locator("[data-turn-id]")
        .last()
        .getAttribute("data-turn-status")) === "completed",
    `${panel.name} completed turn renders`,
  );
  await until(
    async () => (await measure(panel)).body.scrollHeight > scrollHeight + 200,
    `${panel.name} stream visibly grows`,
  );
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  sameScroll(before, await scrolls(), `${panel.name} post-navigation stream growth`);
  await aligned(panel, 3, "stream-reading");
  await shot(`${panel.name}-stream-reading.png`);
  checks.push(
    `${panel.name} real Core stream growth after UI navigation preserves historical reading`,
  );
}

async function removeOwnedState(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await removeOwnedState(join(directory, entry.name));
  }
}

async function cleanup() {
  const result = { passed: false, errors: [], state, registry: env.AREAL_HARNESS_SERVICE_HOME };
  for (const response of held.values()) response.end(sseEnd);
  let metadata;
  try {
    metadata = JSON.parse(await readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") result.errors.push(error.message);
  }
  try {
    result.servicesBefore = JSON.parse(
      (await executeCore(binary, ["service", "list", "--json"], { env, timeout: 30000 })).stdout,
    );
    assert.ok(
      result.servicesBefore.every((item) => item.workspace === workspace),
      "cleanup owns only its isolated fixture workspace",
    );
    if (app) await withSmokeDeadline("owned application quit", () => app.close(), 30000);
    await application?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await assertApplicationStopped(binary, env, metadata);
    result.servicesAfter = JSON.parse(
      (await executeCore(binary, ["service", "list", "--json"], { env, timeout: 30000 })).stdout,
    );
    assert.equal(
      await readFile(join(state, ".owner"), "utf8"),
      scratch,
      "temporary data belongs to this evidence run",
    );
    await removeOwnedState(state);
    await rm(state, { recursive: true, force: true });
    result.stateRemoved = true;
  } catch (error) {
    result.errors.push(error.stack ?? String(error));
  }
  result.passed = result.errors.length === 0;
  await json(join(scratch, "cleanup.json"), result);
  return result;
}

console.log("GUI evidence:", scratch);
try {
  await checkpoint("freeze source Main/packages and built renderer");
  await freeze();
  await mkdir(workspace);
  await mkdir(env.AREAL_CORE_USER_HOME);
  await mkdir(env.AREAL_CORE_HOME);
  await writeFile(join(workspace, "fixture.txt"), "turn navigation acceptance workspace\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync(
    "git",
    ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "fixture"],
    { cwd: workspace, stdio: "ignore" },
  );
  await json(join(env.AREAL_CORE_HOME, "projects.json"), [{ id: projectId, root: workspace }]);
  server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      if (respondToSessionName(body, response)) return;
      const last = body.messages?.findLast(
        (message) =>
          message.role === "user" &&
          !String(message.content).startsWith("AReaL runtime context (not a user request):"),
      );
      const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
      requests.push({ sequence: requests.length + 1, body, text });
      const match = /^TURN_NAV_(MAIN|SIDE)_(\d{2}|STREAM)/.exec(text);
      assert.ok(match, `unexpected fixture model question ${text}`);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (match[2] === "STREAM") {
        held.set(match[1], response);
        response.on("close", () => held.delete(match[1]));
        response.write(sseChunk(`Streaming ${match[1]} opening paragraph.`));
      } else {
        const answer =
          `${replyPrefix(match[1], Number(match[2]))}.\n\n` +
          Array.from(
            { length: 4 },
            (_, index) =>
              `Paragraph ${index + 1} contains deterministic transcript text for navigation acceptance. The selected question belongs to this answer.`,
          ).join("\n\n");
        response.end(sseChunk(answer) + sseEnd);
      }
    } catch (error) {
      modelErrors.push(error.stack ?? String(error));
      response.destroy(error);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await writeFile(
    env.AREAL_CORE_CONFIG,
    `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\nmodels=[{id="fixture",enabled=true}]\n`,
  );
  application = await applicationFixture(applicationRoot, join(state, "application-owner"));
  await checkpoint("launch isolated real Electron/Main/Desktop/Core");
  app = await electron.launch({
    executablePath: require("electron"),
    args: [application.path],
    env,
    timeout: 120000,
  });
  app.process().stderr.on("data", (data) => stderr.push(String(data)));
  run.electronPid = app.process().pid;
  await saveRun();
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => {
    pageErrors.push(error.stack ?? error.message);
    void json(join(scratch, "renderer-errors.json"), pageErrors);
  });
  await page.getByTestId("areal-workbench").waitFor({ timeout: 90000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await until(async () => {
    const value = await snapshot();
    return value.connection?.state === "ready" && project(value)?.state?.connected;
  }, "isolated project ready");
  const identity = await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return {
      appPath: app.getAppPath(),
      userData: app.getPath("userData"),
      electron: process.versions.electron,
      preferences: window.webContents.getLastWebPreferences(),
    };
  });
  assert.equal(identity.userData, env.AREAL_GUI_USER_DATA);
  assert.equal(identity.preferences.sandbox, true);
  assert.equal(identity.preferences.contextIsolation, true);
  assert.equal(identity.preferences.nodeIntegration, false);
  assert.equal(await realpath(project(await snapshot()).core.binary), await realpath(binary));
  run.identity = identity;
  await checkpoint("seed real Core history with declared public-command fixture boundary");
  await page
    .getByRole("button", { name: "在项目 workspace 中新建对话", exact: true })
    .press("Enter");
  await page.getByTestId("chat-input").waitFor();
  await sendUI(panels[0], prompt("MAIN", 1));
  for (let ordinal = 2; ordinal <= 36; ordinal++) {
    await fixtureCommand("send", {
      projectId,
      threadId: panels[0].threadId,
      text: prompt("MAIN", ordinal),
    });
    await waitTurn(panels[0], ordinal);
  }
  await page.getByRole("button", { name: "任务操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "侧边聊天", exact: true }).click();
  await page.getByTestId("side-chat-input").waitFor();
  await sendUI(panels[1], prompt("SIDE", 1));
  for (let ordinal = 2; ordinal <= 36; ordinal++) {
    await fixtureCommand("side", {
      projectId,
      operation: "send",
      threadId: panels[1].threadId,
      text: prompt("SIDE", ordinal),
    });
    await waitTurn(panels[1], ordinal);
  }
  run.panels = panels;
  await saveRun();
  for (const panel of panels) {
    assert.equal(
      await page.locator(panel.shell).locator(".turn-navigation button").count(),
      36,
      `${panel.name} renders every real Core turn`,
    );
    await page
      .locator(panel.shell)
      .locator("[data-turn-id]")
      .last()
      .getByText(replyPrefix(panel.scope, 36), { exact: false })
      .waitFor();
  }
  await shot("00-two-long-conversations.png");
  await checkpoint("verify both real navigation rails by pointer and keyboard");
  for (const panel of panels) {
    await hoverCase(panel);
    await clickCase(panel);
    await keyboardCase(panel);
  }
  await checkpoint("verify the idle active marker survives a shorter transcript");
  await page.locator(panels[0].shell).locator(".turn-navigation button").nth(35).click();
  await until(
    async () => (await measure(panels[0])).buttons[35].current === "step",
    "last turn is the current reading position before shrink",
  );
  const beforeShrink = await measure(panels[0]);
  await page.mouse.move(beforeShrink.shell.right - 12, beforeShrink.shell.top + 12);
  await page.getByTestId(panels[0].input).focus();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(980, 420);
    window.setSize(1600, 420);
  });
  const shrunk = await until(async () => {
    const value = await measure(panels[0]);
    const current = value.buttons.find((button) => button.current === "step");
    return (
      value.rail.clientHeight < 240 &&
      current?.index === 35 &&
      current.top >= value.rail.top - 1 &&
      current.bottom <= value.rail.bottom + 1 &&
      value
    );
  }, "unchanged final reading marker remains visible after the rail shrinks");
  geometry.push({ case: "idle-active-after-shrink", value: shrunk });
  await shot("idle-active-after-shrink.png");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
  await until(
    async () => (await measure(panels[0])).rail.clientHeight === 240,
    "restore desktop height",
  );
  checks.push("resizing a short transcript keeps the unchanged active reading marker visible");
  await checkpoint("verify stream growth after navigation in both conversations");
  for (const panel of panels) await streamCase(panel);
  await checkpoint("verify reduced motion keeps feedback and jumps immediately");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => document.documentElement.dataset.reducedMotion === "true");
  for (const panel of panels) {
    await hoverCase(panel, "-reduced");
    await page.locator(panel.shell).locator(".turn-navigation button").nth(4).click();
    const immediate = await page.locator(panel.shell).evaluate(async (shell) => {
      await new Promise(requestAnimationFrame);
      return (
        shell.querySelectorAll("[data-turn-id]")[4].getBoundingClientRect().top -
        shell.querySelector(".messages").getBoundingClientRect().top
      );
    });
    assert.ok(
      Math.abs(immediate - 24) <= 3,
      `${panel.name} reduced-motion navigation has reached its target by the first frame`,
    );
  }
  checks.push(
    "reduced motion retains the visible ripple and finishes navigation by the first observed frame",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await checkpoint("verify bounded previews after native viewport and Side-width changes");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 760));
  const separator = page.getByRole("separator", { name: "调整侧边面板宽度", exact: true });
  await separator.focus();
  for (let index = 0; index < 5; index++) await page.keyboard.press("ArrowRight");
  for (const panel of panels) await hoverCase(panel, "-narrow");
  await shot("99-narrow-two-conversations.png");
  assert.deepEqual(pageErrors, [], "no renderer errors");
  assert.deepEqual(modelErrors, [], "no fixture protocol errors");
  assert.equal(
    sha(await readFile(binary)),
    run.source.coreSha256,
    "fixed Core binary stayed unchanged",
  );
  passed = true;
} catch (error) {
  failure = error.stack ?? String(error);
  console.error(failure);
  if (page) await captureSmokeFailure(page, scratch, error);
} finally {
  try {
    cleanupResult = await cleanup();
  } catch (error) {
    cleanupResult = { passed: false, errors: [error.stack ?? String(error)] };
  }
  passed = passed && cleanupResult.passed;
  await Promise.all([
    saveRun(),
    json(join(scratch, "geometry.json"), geometry),
    json(join(scratch, "model-requests.json"), requests),
    json(join(scratch, "fixture-commands.json"), commands),
    writeFile(join(scratch, "electron.stderr.log"), stderr.join("")),
    json(join(scratch, "manifest.json"), {
      passed,
      failure,
      checks,
      frames,
      pageErrors,
      modelErrors,
      cleanup: cleanupResult,
      source: run.source,
      artifacts: run.artifacts,
      boundaries: run.boundaries,
      versions: {
        node: process.version,
        electron: require("electron/package.json").version,
        playwright: require("playwright-core/package.json").version,
      },
    }),
  ]);
  console.log(
    JSON.stringify(
      { passed, evidence: scratch, checks: checks.length, cleanup: cleanupResult },
      null,
      2,
    ),
  );
  if (!passed) process.exitCode = 1;
}
