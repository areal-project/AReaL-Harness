import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import {
  createExternalTaskFixture,
  externalSourcesManifest,
  EXTERNAL_TASK_IDS,
  externalFixtureSteps,
  externalNativeSnapshotScript,
  extractMiniwobGoal,
  gradeExternalTask,
  TODO_ITEMS,
} from "./browser-task-external-sources.mjs";

const assets = new URL("./fixtures/vendor/browser-task-sources/", import.meta.url);
const initial = (name) => ({
  kind: "miniwob",
  nativePageId: 7,
  documentId: "7:frame1:time1",
  runnerEvidence: { observedRestart: false },
  url: `http://127.0.0.1:1234/${name}`,
  episodeActive: true,
  episodeId: 0,
  done: false,
  rawReward: 0,
  episodeMaxTime: 180000,
  ...{
    "enter-text": {
      query: 'Enter "Morgan" into the text field and press Submit.',
      controls: [{ id: "tt", type: "text", value: "", label: null, options: null }],
    },
    "choose-list": {
      query: "Select Canada from the list and click Submit.",
      controls: [
        {
          id: "options",
          type: "select-one",
          value: "France",
          options: ["France", "Canada"],
          selectedIndex: 0,
          label: null,
        },
      ],
    },
    "click-checkboxes": {
      query: "Select abc, def and click Submit.",
      controls: ["abc", "def", "ghi", "jkl"].map((label, index) => ({
        id: `ch${index}`,
        type: "checkbox",
        label,
        checked: false,
        options: null,
      })),
    },
    "click-option": {
      query: "Select def and click Submit.",
      controls: ["abc", "def"].map((label, index) => ({
        id: `ch${index}`,
        type: "radio",
        label,
        checked: false,
        options: null,
      })),
    },
  }[name],
});
const final = (name) => {
  const state = structuredClone(initial(name));
  Object.assign(state, { done: true, rawReward: 1, episodeId: 1, episodeActive: false });
  if (name === "enter-text") state.controls[0].value = "Morgan";
  if (name === "choose-list")
    Object.assign(state.controls[0], { value: "Canada", selectedIndex: 1 });
  if (name === "click-checkboxes") state.controls[0].checked = state.controls[1].checked = true;
  if (name === "click-option") state.controls[1].checked = true;
  return state;
};
const passed = (result) => result.valid && Object.values(result.checks).every(Boolean);

test("vendored files match pinned public source digests and include dependency notices", async () => {
  assert.equal(EXTERNAL_TASK_IDS.length, 7);
  assert.equal(externalSourcesManifest.sources.length, 2);
  for (const entry of externalSourcesManifest.files) {
    const bytes = await readFile(new URL(entry.file, assets));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, entry.file);
    if (entry.gitBlobSha1)
      assert.equal(
        createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
        entry.gitBlobSha1,
        entry.file,
      );
  }
  for (const path of [
    "miniwob/LICENSE",
    "miniwob/dependency-licenses/d3-v3.5.12/LICENSE",
    "miniwob/dependency-licenses/jquery-v1.12.4/LICENSE.txt",
    "miniwob/dependency-licenses/jquery-ui-v1.12.1/LICENSE.txt",
    "miniwob/dependency-licenses/seedrandom-upstream-notice/README.md",
    "todomvc/license.md",
    "todomvc/examples/react/dist/app.bundle.js.LICENSE.txt",
  ]) {
    assert.ok(externalSourcesManifest.files.some((entry) => entry.file === path));
  }
});

test("asset server preserves upstream bytes and only ports MiniWoB seed and timer", async () => {
  const fixture = await createExternalTaskFixture("miniwob/enter-text", { seed: 130363 });
  try {
    assert.deepEqual(fixture.origins, [fixture.origin]);
    assert.doesNotMatch(fixture.prompt, /pageId|querySelector|RAW_REWARD|oracle|104729/);
    for (const entry of externalSourcesManifest.files.filter(
      ({ file }) => file.includes("/html/") || file.includes("/dist/"),
    )) {
      const response = await fetch(`${fixture.origin}/${entry.file}`);
      assert.equal(response.status, 200, entry.file);
      const actual = Buffer.from(await response.arrayBuffer());
      const original = await readFile(new URL(entry.file, assets));
      if (entry.file.endsWith(".html") && entry.file.startsWith("miniwob/")) {
        const adaptation =
          '<script>Math.seedrandom("130363");core.EPISODE_MAX_TIME=180000;</script>';
        assert.equal(actual.toString().replace(adaptation, ""), original.toString());
        assert.equal(actual.toString().split(adaptation).length, 2);
        assert.ok(
          actual.toString().indexOf(adaptation) < actual.toString().indexOf("window.onload"),
        );
      } else assert.deepEqual(actual, original);
    }
    for (const path of [
      "/learn.json",
      "/manifest.json",
      "/todomvc/cypress/e2e/spec.cy.js",
      "/unknown",
      "/miniwob/LICENSE",
    ])
      assert.equal((await fetch(`${fixture.origin}${path}`)).status, 404);
    assert.equal((await fetch(fixture.url, { method: "POST" })).status, 404);
    assert.equal(fixture.facts.effects.length, 0);
  } finally {
    await fixture.close();
  }
});

test("all original HTML and CSS runtime references resolve to vendored assets", async () => {
  const runtime = externalSourcesManifest.files.filter(
    ({ file }) => file.includes("/html/") || file.includes("/dist/"),
  );
  const paths = new Set(runtime.map(({ file }) => `/${file}`));
  let checked = 0;
  for (const { file } of runtime.filter(({ file }) => /\.(html|css)$/.test(file))) {
    const text = (await readFile(new URL(file, assets), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
    const references = file.endsWith("html")
      ? [...text.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1])
      : [...text.matchAll(/url\(["']?([^)"']+)["']?\)/g)].map((match) => match[1]);
    for (const reference of references) {
      if (/^(?:data:|https?:|#)/.test(reference)) continue;
      const resolved = new URL(reference, `http://127.0.0.1/${file}`);
      assert.ok(paths.has(resolved.pathname), `${file} -> ${reference}`);
      checked++;
    }
  }
  assert.ok(checked >= 30);
});

test("original MiniWoB RNG is deterministic for all paired seeds", async () => {
  const source = await readFile(new URL("miniwob/miniwob/html/core/core.js", assets), "utf8");
  const sample = (seed) => {
    const context = vm.createContext({ window: { location: { search: "" } }, console });
    vm.runInContext(source, context);
    return vm.runInContext(
      `Math.seedrandom(${JSON.stringify(String(seed))}); JSON.stringify(Array.from({length: 10}, () => core.randi(0, 100000)))`,
      context,
    );
  };
  const seeds = [104729, 130363, 155921, 181081, 206369];
  for (const seed of seeds) assert.equal(sample(seed), sample(seed));
  assert.equal(new Set(seeds.map(sample)).size, seeds.length);
});

test("MiniWoB grading requires latched goal, exact controls, full original reward, and one episode", () => {
  for (const name of ["enter-text", "choose-list", "click-checkboxes", "click-option"]) {
    const id = `miniwob/${name}`;
    const check = (current, first = initial(name)) =>
      gradeExternalTask(id, { initialSnapshot: first, nativeSnapshot: current });
    assert.equal(passed(check(final(name))), true, id);
    assert.equal(check(final(name), null).valid, false);
    for (const patch of [
      { rawReward: 0.5 },
      { done: false },
      { episodeId: 2 },
      { query: "rewritten goal" },
      { episodeMaxTime: 10000 },
    ])
      assert.equal(
        passed(check({ ...final(name), ...patch })),
        false,
        `${id}: ${JSON.stringify(patch)}`,
      );
    const wrong = final(name);
    if (name === "enter-text") wrong.controls[0].value = "wrong";
    if (name === "choose-list") wrong.controls[0].selectedIndex = 0;
    if (name === "click-checkboxes") wrong.controls[3].checked = true;
    if (name === "click-option") wrong.controls[1].checked = false;
    assert.equal(passed(check(wrong)), false, id);
  }
  const empty = initial("click-checkboxes");
  empty.query = "Select nothing and click Submit.";
  assert.deepEqual(extractMiniwobGoal("miniwob/click-checkboxes", empty), { selected: [] });
  assert.equal(
    passed(
      gradeExternalTask("miniwob/click-checkboxes", {
        initialSnapshot: empty,
        nativeSnapshot: { ...empty, episodeActive: false, done: true, rawReward: 1, episodeId: 1 },
      }),
    ),
    true,
  );
});

test("original submit handlers distinguish success, failure, and positive partial checkbox reward", async () => {
  const coreSource = await readFile(new URL("miniwob/miniwob/html/core/core.js", assets), "utf8");
  for (const name of ["enter-text", "choose-list", "click-checkboxes", "click-option"]) {
    const html = await readFile(
      new URL(`miniwob/miniwob/html/miniwob/${name}.html`, assets),
      "utf8",
    );
    const handler = html.match(/\.on\('click', (function\(\)\{[\s\S]*?)\n  \}\);/)[1] + "\n}";
    for (const correct of [false, true]) {
      const state = correct ? final(name) : initial(name);
      const nodes = Object.fromEntries(
        state.controls.map((control) => [
          control.id,
          { ...control, options: control.options?.map((text) => ({ innerHTML: text })) },
        ]),
      );
      const context = vm.createContext({
        window: { location: { search: "" } },
        console: { log() {} },
        clearTimeout() {},
        document: { getElementById: (id) => (id === "episode-id" ? {} : nodes[id]) },
        d3: { select: (selector) => [[nodes[selector.slice(1)]]] },
        q: "Morgan",
        gt_txt: "Canada",
        correctElement: { index: 1 },
        checkboxData: { elems: 4, toclick: { 0: true, 1: true, 2: false, 3: false } },
      });
      vm.runInContext(coreSource, context);
      vm.runInContext(
        "core.EP_TIMER=1;core.ept0=Date.now();core.updateDisplay=()=>{};core.clearTimer=()=>{};core.startEpisode=()=>{};",
        context,
      );
      vm.runInContext(`(${handler})()`, context);
      assert.equal(context.WOB_DONE_GLOBAL, true);
      assert.equal(
        context.WOB_RAW_REWARD_GLOBAL,
        correct ? 1 : name === "click-checkboxes" ? 0 : -1,
        name,
      );
      if (name === "click-checkboxes") {
        Object.assign(nodes.ch0, { checked: true });
        Object.assign(nodes.ch1, { checked: true });
        Object.assign(nodes.ch3, { checked: true });
        vm.runInContext(`core.EP_TIMER=1;(${handler})()`, context);
        assert.equal(context.WOB_RAW_REWARD_GLOBAL, 0.5);
        assert.equal(
          passed(
            gradeExternalTask(`miniwob/${name}`, {
              initialSnapshot: initial(name),
              nativeSnapshot: { ...final(name), rawReward: context.WOB_RAW_REWARD_GLOBAL },
            }),
          ),
          false,
        );
      }
    }
  }
});

test("TodoMVC official visible assertions reject wrong edit, extra items, and incorrect Active state", () => {
  for (const id of ["todomvc/add", "todomvc/edit", "todomvc/active"]) {
    const labels =
      id === "todomvc/add"
        ? TODO_ITEMS.slice(0, 2)
        : id === "todomvc/edit"
          ? [TODO_ITEMS[0], "buy some sausages", TODO_ITEMS[2]]
          : [TODO_ITEMS[0], TODO_ITEMS[2]];
    const state = {
      kind: "todomvc",
      nativePageId: 8,
      documentId: "8:frame1:time2",
      items: labels.map((label) => ({ label, checked: false, editing: false })),
      hash: "#/active",
      selectedFilter: "Active",
      remaining: "2 items left!",
      clearCompletedVisible: true,
    };
    if (id === "todomvc/active")
      state.runnerEvidence = {
        allSnapshot: {
          ...state,
          hash: "#/",
          selectedFilter: "All",
          items: TODO_ITEMS.map((label, index) => ({
            label,
            checked: index === 1,
            editing: false,
          })),
        },
        restoredSnapshot: structuredClone(state),
      };
    const check = (nativeSnapshot) => gradeExternalTask(id, { nativeSnapshot });
    assert.equal(passed(check(state)), true);
    assert.equal(check(null).valid, false);
    for (const items of [
      [...state.items, state.items[0]],
      state.items.toReversed(),
      [{ ...state.items[0], checked: true }, ...state.items.slice(1)],
    ])
      assert.equal(passed(check({ ...state, items })), false);
    if (id === "todomvc/edit")
      assert.equal(
        passed(
          check({
            ...state,
            items: state.items.map((item, index) =>
              index === 1 ? { ...item, label: TODO_ITEMS[1] } : item,
            ),
          }),
        ),
        false,
      );
    if (id === "todomvc/active")
      for (const patch of [
        { hash: "#/" },
        { selectedFilter: "All" },
        { remaining: "3 items left!" },
        { clearCompletedVisible: false },
      ])
        assert.equal(passed(check({ ...state, ...patch })), false);
  }
});

test("MiniWoB rejects same-goal reloads and retains observed restart failure", () => {
  const first = initial("enter-text");
  const solved = final("enter-text");
  const check = (nativeSnapshot) =>
    gradeExternalTask("miniwob/enter-text", { initialSnapshot: first, nativeSnapshot });
  assert.equal(passed(check(solved)), true);
  for (const patch of [
    { documentId: "7:frame1:time2" },
    { nativePageId: 9 },
    { runnerEvidence: { observedRestart: true } },
  ]) {
    const result = check({ ...solved, ...patch });
    assert.equal(result.valid, true);
    assert.equal(passed(result), false);
  }
  for (const patch of [
    { documentId: undefined },
    { nativePageId: undefined },
    { runnerEvidence: undefined },
  ]) {
    const result = check({ ...solved, ...patch });
    assert.equal(result.valid, false);
    assert.match(result.unknownReason, /continuity evidence/);
  }
});

test("TodoMVC Active rejects hidden incorrect or extra completed items and requires restored native state", () => {
  const active = {
    kind: "todomvc",
    nativePageId: 8,
    documentId: "8:frame1:time2",
    hash: "#/active",
    selectedFilter: "Active",
    remaining: "2 items left!",
    clearCompletedVisible: true,
    items: [TODO_ITEMS[0], TODO_ITEMS[2]].map((label) => ({
      label,
      checked: false,
      editing: false,
    })),
  };
  const all = {
    ...active,
    hash: "#/",
    selectedFilter: "All",
    items: TODO_ITEMS.map((label, index) => ({ label, checked: index === 1, editing: false })),
  };
  const check = (evidence) =>
    gradeExternalTask("todomvc/active", {
      nativeSnapshot: { ...active, runnerEvidence: evidence },
    });
  const evidence = { allSnapshot: all, restoredSnapshot: structuredClone(active) };
  assert.equal(passed(check(evidence)), true);
  for (const items of [
    all.items.map((item, index) => (index === 1 ? { ...item, label: "wrong item" } : item)),
    [...all.items, { label: "extra completed", checked: true, editing: false }],
    all.items.map((item, index) => ({ ...item, checked: index === 0 })),
  ]) {
    const result = check({ ...evidence, allSnapshot: { ...all, items } });
    assert.equal(result.valid, true);
    assert.equal(passed(result), false);
  }
  for (const patch of [{ hash: "#/" }, { items: [] }, { documentId: "8:frame1:time3" }]) {
    assert.equal(passed(check({ ...evidence, restoredSnapshot: { ...active, ...patch } })), false);
  }
  for (const patch of [
    { allSnapshot: null },
    { restoredSnapshot: null },
    { verificationError: "All control failed" },
  ])
    assert.equal(check({ ...evidence, ...patch }).valid, false);
});

test("scripted control operations pass real command validators and require generated initial goals", () => {
  const require = createRequire(import.meta.url);
  const { validToolInput } = require("@areal/workbench-service/desktop/core/browser-tool.cjs");
  const { validateBrowserCommand } = createRequire(new URL("../app/package.json", import.meta.url))(
    "@areal/browser-automation",
  );
  for (const id of EXTERNAL_TASK_IDS) {
    const context = {
      pageId: "11111111-1111-1111-1111-111111111111",
      origin: "http://127.0.0.1:1234",
      initialSnapshot: initial(id.split("/")[1]),
    };
    const steps = externalFixtureSteps(id, context);
    for (const step of steps) {
      assert.equal(validToolInput(step), true, JSON.stringify(step));
      if (step.operation === "command") validateBrowserCommand(step.parameters.command);
    }
    assert.doesNotThrow(() => new vm.Script(externalNativeSnapshotScript(id)));
    if (id.startsWith("miniwob/")) {
      const prefix = externalFixtureSteps(id, { ...context, initialSnapshot: null });
      assert.equal(prefix.length, 3);
      assert.equal(prefix[1].parameters.command.action.selector, "#sync-task-cover");
      assert.deepEqual(steps.slice(0, 3), prefix);
    }
  }
});
