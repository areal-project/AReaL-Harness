import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const assetsRoot = new URL("./fixtures/vendor/browser-task-sources/", import.meta.url);
export const externalSourcesManifest = JSON.parse(
  await readFile(new URL("manifest.json", assetsRoot), "utf8"),
);
export const TODO_ITEMS = Object.freeze([
  "buy some cheese",
  "feed the cat",
  "book a doctors appointment",
]);
export const EXTERNAL_TASK_CATALOG = [
  ...["enter-text", "choose-list", "click-checkboxes", "click-option"].map((name) => ({
    id: `miniwob/${name}`,
    sourceId: "miniwob-plusplus-original",
    goal: "Click START once, follow the instruction on the page, and submit once.",
    oracle:
      "Original episode result and native controls against the independently latched initial goal.",
    asset: `miniwob/miniwob/html/miniwob/${name}.html`,
  })),
  ...[
    [
      "add",
      `Add ${JSON.stringify(TODO_ITEMS[0])}, then ${JSON.stringify(TODO_ITEMS[1])}. Leave both incomplete.`,
    ],
    [
      "edit",
      `Add these three items in order: ${TODO_ITEMS.map((item) => JSON.stringify(item)).join(", ")}. Edit the second item to "buy some sausages", keeping the other items in order and incomplete.`,
    ],
    [
      "active",
      `Add these three items in order: ${TODO_ITEMS.map((item) => JSON.stringify(item)).join(", ")}. Mark the second item complete, then switch to Active so only the remaining items are shown.`,
    ],
  ].map(([name, goal]) => ({
    id: `todomvc/${name}`,
    sourceId: "todomvc-official-react",
    goal,
    oracle: "Official visible list assertions, with exact count/order and native filter state.",
    asset: "todomvc/examples/react/dist/index.html",
  })),
];
export const EXTERNAL_TASK_IDS = EXTERNAL_TASK_CATALOG.map((task) => task.id);
const taskById = new Map(EXTERNAL_TASK_CATALOG.map((task) => [task.id, task]));
const runtimeFiles = new Map(
  externalSourcesManifest.files
    .filter(
      ({ file }) =>
        file.startsWith("miniwob/miniwob/html/") || file.startsWith("todomvc/examples/react/dist/"),
    )
    .map((entry) => [`/${entry.file}`, entry]),
);
const contentTypes = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  png: "image/png",
  txt: "text/plain; charset=utf-8",
};

export async function createExternalTaskFixture(id, { seed = 104729 } = {}) {
  const task = taskById.get(id);
  if (!task) throw Error(`Unknown external task ${id}`);
  if (!Number.isSafeInteger(seed) || seed < 0)
    throw Error("Task seed must be a nonnegative safe integer");
  const facts = { gets: [], effects: [] };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    facts.gets.push({ path, destination: request.headers["sec-fetch-dest"] ?? null });
    const asset = runtimeFiles.get(path);
    if (request.method !== "GET" || !asset) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    const bytes = await readFile(new URL(asset.file, assetsRoot));
    const type = asset.file.split(".").at(-1);
    response.setHeader("Content-Type", contentTypes[type] ?? "application/octet-stream");
    response.setHeader("Cache-Control", "no-store");
    if (asset.file.startsWith("miniwob/") && type === "html") {
      const original = bytes.toString("utf8");
      const anchor = '<script src="../core/core.js"></script>';
      response.end(
        original.replace(
          anchor,
          `${anchor}<script>Math.seedrandom(${JSON.stringify(String(seed))});core.EPISODE_MAX_TIME=180000;</script>`,
        ),
      );
      return;
    }
    response.end(bytes);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    id,
    origin,
    origins: [origin],
    url: `${origin}/${task.asset}`,
    prompt: `Open ${origin}/${task.asset}. ${task.goal}`,
    expected: {},
    source: externalSourcesManifest.sources.find((source) => source.id === task.sourceId),
    seed,
    facts,
    nativeOracleScript: externalNativeSnapshotScript(id),
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// 固定脚本只读原生页面。初始快照由 Main 保存，页面不保存评分目标。
export function externalNativeSnapshotScript(id) {
  if (!taskById.has(id)) throw Error(`Unknown external task ${id}`);
  if (id.startsWith("miniwob/"))
    return `(() => {
    const controls = Array.from(document.querySelectorAll('#area input, #area select')).map((node) => ({
      id: node.id, type: node.type, value: node.value, checked: node.checked ?? null,
      label: node.closest('label')?.textContent.trim() ?? null,
      options: node.options ? Array.from(node.options, option => option.textContent) : null,
      selectedIndex: node.selectedIndex ?? null
    }));
    return { kind: 'miniwob', url: location.href, query: document.querySelector('#query')?.textContent ?? '', controls,
      done: window.WOB_DONE_GLOBAL === true, rawReward: window.WOB_RAW_REWARD_GLOBAL,
      reward: window.WOB_REWARD_GLOBAL, episodeId: window.WOB_EPISODE_ID,
      episodeActive: Boolean(window.core?.ept0 && window.core?.EP_TIMER !== null && !window.WOB_DONE_GLOBAL),
      episodeMaxTime: window.core?.EPISODE_MAX_TIME, startVisible: document.querySelector('#sync-task-cover')?.style.display !== 'none'
    };
  })()`;
  return `(() => {
    const visible = node => Boolean(node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
    const items = Array.from(document.querySelectorAll('.todo-list li')).filter(visible).map(node => ({
      label: node.querySelector('label')?.textContent.trim() ?? '',
      checked: node.querySelector('input.toggle')?.checked ?? null,
      editing: node.classList.contains('editing')
    }));
    return { kind: 'todomvc', url: location.href, items, hash: location.hash,
      selectedFilter: document.querySelector('.filters a.selected')?.textContent.trim() ?? null,
      remaining: document.querySelector('.todo-count')?.textContent.trim() ?? null,
      clearCompletedVisible: Array.from(document.querySelectorAll('.clear-completed')).some(visible)
    };
  })()`;
}

export function extractMiniwobGoal(id, initial) {
  if (
    initial?.kind !== "miniwob" ||
    !initial.episodeActive ||
    initial.episodeId !== 0 ||
    initial.done ||
    initial.rawReward !== 0
  )
    return null;
  const query = initial.query;
  const controls = initial.controls;
  if (typeof query !== "string" || !Array.isArray(controls)) return null;
  if (id === "miniwob/enter-text") {
    const match = /^Enter "(.+)" into the text field and press Submit\.$/.exec(query);
    return match && controls.length === 1 && controls[0].id === "tt" && controls[0].value === ""
      ? { value: match[1] }
      : null;
  }
  if (id === "miniwob/choose-list") {
    const match = /^Select (.+) from the list and click Submit\.$/.exec(query);
    return match &&
      controls.length === 1 &&
      controls[0].options?.filter((option) => option === match[1]).length === 1
      ? { value: match[1] }
      : null;
  }
  const match = /^Select (.+) and click Submit\.$/.exec(query);
  if (!match || controls.length < 2 || controls.some((control) => control.checked !== false))
    return null;
  const labels = controls.map((control) => control.label);
  if (
    labels.some((label) => typeof label !== "string" || !label) ||
    new Set(labels).size !== labels.length
  )
    return null;
  const selected =
    id === "miniwob/click-checkboxes"
      ? match[1] === "nothing"
        ? []
        : match[1].split(", ")
      : [match[1]];
  return selected.every((label) => labels.includes(label)) ? { selected } : null;
}

function hasNativeDocumentIdentity(snapshot) {
  return (
    Number.isInteger(snapshot?.nativePageId) &&
    typeof snapshot.documentId === "string" &&
    snapshot.documentId.length > 0
  );
}

export function gradeExternalTask(id, { initialSnapshot, nativeSnapshot } = {}) {
  if (!taskById.has(id)) throw Error(`Unknown external task ${id}`);
  const current = nativeSnapshot;
  if (id.startsWith("miniwob/")) {
    const goal = extractMiniwobGoal(id, initialSnapshot);
    if (!goal || !current || current.kind !== "miniwob")
      return {
        valid: false,
        checks: {
          initialGoalCaptured: Boolean(goal),
          nativePageCaptured: current?.kind === "miniwob",
        },
        unknownReason: "Missing or ambiguous initial MiniWoB episode/native evidence",
      };
    if (
      !hasNativeDocumentIdentity(initialSnapshot) ||
      !hasNativeDocumentIdentity(current) ||
      typeof current.runnerEvidence?.observedRestart !== "boolean"
    )
      return {
        valid: false,
        checks: { nativeDocumentContinuityCaptured: false },
        unknownReason: "Missing trusted MiniWoB document continuity evidence",
      };
    const initialControls = initialSnapshot.controls;
    const controls = current.controls ?? [];
    const sameControls =
      controls.length === initialControls.length &&
      controls.every((control, index) => {
        const previous = initialControls[index];
        return (
          control.id === previous.id &&
          control.type === previous.type &&
          control.label === previous.label &&
          JSON.stringify(control.options) === JSON.stringify(previous.options)
        );
      });
    const selected = controls.filter((control) => control.checked).map((control) => control.label);
    const controlsCorrect =
      id === "miniwob/enter-text"
        ? controls[0]?.value === goal.value
        : id === "miniwob/choose-list"
          ? controls[0]?.options?.[controls[0]?.selectedIndex] === goal.value
          : selected.length === goal.selected.length &&
            goal.selected.every((label) => selected.includes(label));
    return {
      valid: true,
      checks: {
        initialGoalCaptured: true,
        samePage: current.url === initialSnapshot.url,
        sameNativePage: current.nativePageId === initialSnapshot.nativePageId,
        sameDocument: current.documentId === initialSnapshot.documentId,
        noObservedRestart: current.runnerEvidence.observedRestart === false,
        unchangedGoal: current.query === initialSnapshot.query,
        unchangedControls: sameControls,
        originalDone: current.done === true,
        originalFullReward: current.rawReward === 1,
        singleEpisode: current.episodeId === 1,
        nativeControlsCorrect: controlsCorrect,
        portedTimeBudget:
          initialSnapshot.episodeMaxTime === 180000 && current.episodeMaxTime === 180000,
      },
    };
  }
  if (current?.kind !== "todomvc")
    return {
      valid: false,
      checks: { nativePageCaptured: false },
      unknownReason: "Missing native TodoMVC evidence",
    };
  const expected =
    id === "todomvc/add"
      ? TODO_ITEMS.slice(0, 2)
      : id === "todomvc/edit"
        ? [TODO_ITEMS[0], "buy some sausages", TODO_ITEMS[2]]
        : [TODO_ITEMS[0], TODO_ITEMS[2]];
  const items = current.items ?? [];
  const checks = {
    nativePageCaptured: true,
    exactItemCount: items.length === expected.length,
    originalVisibleLabels: expected.every((label, index) => items[index]?.label.includes(label)),
    exactItemOrder: expected.every((label, index) => items[index]?.label === label),
    incompleteItems: items.every((item) => item.checked === false),
    editCommitted: items.every((item) => item.editing === false),
  };
  if (id === "todomvc/active") {
    Object.assign(checks, {
      activeRoute: current.hash === "#/active",
      activeFilter: current.selectedFilter === "Active",
      remainingCount: /^2 items left!?$/.test(current.remaining ?? ""),
      completedItemRetained: current.clearCompletedVisible === true,
    });
    const evidence = current.runnerEvidence;
    const all = evidence?.allSnapshot;
    const restored = evidence?.restoredSnapshot;
    if (
      evidence?.verificationError ||
      all?.kind !== "todomvc" ||
      restored?.kind !== "todomvc" ||
      ![current, all, restored].every(hasNativeDocumentIdentity)
    )
      return {
        valid: false,
        checks: { ...checks, completeListAndRestorationCaptured: false },
        unknownReason: "Missing trusted TodoMVC complete list or restored Active evidence",
      };
    const allItems = all.items ?? [];
    const restoredItems = restored.items ?? [];
    Object.assign(checks, {
      verificationUsesSameDocument: [all, restored].every(
        (state) =>
          state.nativePageId === current.nativePageId && state.documentId === current.documentId,
      ),
      allFilterInspected: all.hash === "#/" && all.selectedFilter === "All",
      exactCompleteList:
        allItems.length === TODO_ITEMS.length &&
        TODO_ITEMS.every((label, index) => allItems[index]?.label === label),
      onlySecondItemCompleted:
        allItems.length === TODO_ITEMS.length &&
        allItems.every((item, index) => item.checked === (index === 1) && item.editing === false),
      activeRestored:
        restored.hash === "#/active" &&
        restored.selectedFilter === "Active" &&
        /^2 items left!?$/.test(restored.remaining ?? "") &&
        restored.clearCompletedVisible === true,
      restoredItemsCorrect:
        restoredItems.length === expected.length &&
        expected.every(
          (label, index) =>
            restoredItems[index]?.label === label &&
            restoredItems[index].checked === false &&
            restoredItems[index].editing === false,
        ),
    });
  }
  return { valid: true, checks };
}

// 只供确定性执行链校验使用。真实模型仅收到普通任务提示。
export function externalFixtureSteps(id, { pageId, origin, initialSnapshot } = {}) {
  const task = taskById.get(id);
  if (!task) throw Error(`Unknown external task ${id}`);
  const locator = (selector, operation, rest = {}) => ({
    operation: "command",
    parameters: {
      pageId,
      command: { method: "playwright", action: { name: "locator", selector, operation, ...rest } },
    },
  });
  const snapshot = {
    operation: "command",
    parameters: { pageId, command: { method: "playwright", action: { name: "domSnapshot" } } },
  };
  const steps = [{ operation: "navigate", parameters: { pageId, url: `${origin}/${task.asset}` } }];
  if (id.startsWith("miniwob/")) {
    steps.push(locator("#sync-task-cover", "click"), snapshot);
    const goal = extractMiniwobGoal(id, initialSnapshot);
    if (!goal) return steps;
    if (id === "miniwob/enter-text") steps.push(locator("#tt", "fill", { value: goal.value }));
    if (id === "miniwob/choose-list")
      steps.push(locator("#options", "selectOption", { selections: [{ label: goal.value }] }));
    if (goal.selected)
      for (const control of initialSnapshot.controls) {
        if (goal.selected.includes(control.label))
          steps.push(locator(`#${control.id}`, "setChecked", { checked: true }));
      }
    steps.push(locator("#area button", "click"), snapshot);
    return steps;
  }
  for (const item of id === "todomvc/add" ? TODO_ITEMS.slice(0, 2) : TODO_ITEMS) {
    steps.push(
      locator(".new-todo", "fill", { value: item }),
      locator(".new-todo", "press", { value: "Enter" }),
    );
  }
  if (id === "todomvc/edit")
    steps.push(
      locator(".todo-list li:nth-child(2) label", "dblclick"),
      locator(".edit", "fill", { value: "buy some sausages" }),
      locator(".edit", "press", { value: "Enter" }),
    );
  if (id === "todomvc/active")
    steps.push(
      locator(".todo-list li:nth-child(2) .toggle", "setChecked", { checked: true }),
      locator('.filters a[href="#/active"]', "click"),
    );
  steps.push(snapshot);
  return steps;
}
