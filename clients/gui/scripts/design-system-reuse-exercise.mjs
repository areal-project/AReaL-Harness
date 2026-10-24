import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const objects = [
  { id: "guide", name: "项目快速开始.md", type: "文档" },
  { id: "trace", name: "本轮执行过程与工具返回记录-包含中文和English的长文件名.ndjson", type: "记录" },
  { id: "screenshot", name: "结果截图.png", type: "图片" },
  { id: "remote", name: "远端模型产物.bin", type: "其他" },
  { id: "draft", name: "交付摘要草稿.md", type: "文档" },
  { id: "metrics", name: "运行指标.json", type: "记录" },
];
const escapePattern = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

export async function runReuseExercise(page, scratch, gui, exercise) {
  const registry = JSON.parse(await readFile(join(gui, "design-system/registry.json"), "utf8"));
  const consumerSource = exercise.consumerSource ?? "renderer/src/design-system/ArtifactReviewExercise.tsx";
  const sourceFiles = [consumerSource, "renderer/src/design-system/base-components.ts", "design-system/base.md", "design-system/registry.json"];
  const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, digest(await readFile(join(gui, path)))])));
  const briefSha256 = digest(await readFile(resolve(gui, "../../design/components/reuse-exercise.md")));
  const require = createRequire(join(gui, "renderer/package.json"));
  const ts = require("typescript");
  const source = await readFile(join(gui, consumerSource), "utf8");
  const syntax = ts.createSourceFile(consumerSource, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = [], violations = [];
  const inspect = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const module = node.moduleSpecifier.text;
      imports.push(module);
      if (!["react", "./base-components", "./base-components.js"].includes(module)) violations.push(`unapproved import ${module}`);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) violations.push("runtime module loading");
    if (ts.isJsxAttribute(node) && node.name.getText(syntax) === "style") violations.push("inline style");
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ["style", "link"].includes(node.tagName.getText(syntax))) violations.push("local stylesheet element");
    ts.forEachChild(node, inspect);
  };
  inspect(syntax);
  Object.assign(exercise, {
    id: "artifact-review-reuse", questionId: "Q-BASE-REUSE-01", candidateVersion: registry.baseCandidate.version,
    inputBaseSnapshot: exercise.inputBaseSnapshot ?? registry.baseCandidate.snapshot.revision,
    briefSha256, sourceHashes, sourceAudit: { consumerSource, imports, violations },
    scope: exercise.purpose === "migration-regression" ? "existing independent consumer migrated to the current frozen Base; browser regression, not a new blind trial" : "independent local renderer consumer of frozen Base; browser behavior and computed layout",
    verdicts: { behavior: "NOT VERIFIED", sourceReuse: "NOT VERIFIED", visualReview: "NOT VERIFIED" },
    gaps: ["screenshots require independent visual review", "single bounded task does not establish general component or platform coverage", "no Electron, Core, provider, filesystem or package acceptance"],
  });
  exercise.steps ??= [];
  exercise.checks ??= [];
  const save = () => writeFile(join(scratch, "exercise-steps.json"), JSON.stringify(exercise, null, 2));
  await save();
  assert.equal(registry.baseCandidate.status, "frozen-beta", "consumer must use the frozen-beta input");
  assert.match(exercise.inputBaseSnapshot ?? "", /^[0-9a-f]{40}$/, "frozen input commit must be recorded");
  assert.deepEqual(violations, [], "consumer imports only React and Base and has no local or inline visual styles");
  assert.ok(imports.some(module => module.startsWith("./base-components")), "consumer must import the frozen public entry");
  exercise.verdicts.sourceReuse = "VERIFIED";
  await page.clock.install({ time: new Date("2026-10-23T00:00:00Z") });
  await page.reload();
  const region = page.locator("#artifact-review-exercise");
  await region.waitFor();
  await page.clock.pauseAt(new Date("2026-10-23T00:01:00Z"));
  const detail = region.getByRole("region", { name: "交付物详情", exact: true });
  const filter = region.getByLabel("类型筛选", { exact: true });
  const refresh = region.getByRole("button", { name: "刷新资料", exact: true });
  const action = () => detail.getByRole("button", { name: "核对交付物", exact: true });
  const row = id => region.getByRole("button", { name: new RegExp(escapePattern(objects.find(object => object.id === id).name)) });
  const selected = async id => {
    await detail.getByRole("heading", { name: objects.find(object => object.id === id).name, exact: true }).waitFor();
  };
  const hasResult = async (target, result) => {
    await target.getByText(result, { exact: true }).waitFor();
  };
  const checkRow = async (id, text) => {
    const content = await row(id).evaluate((button, name) => {
      for (let node = button; node; node = node.parentElement) if (node.textContent.includes(name)) return node.textContent;
      return "";
    }, objects.find(object => object.id === id).name);
    assert.ok(content.includes(text), `${id} list result contains ${text}`);
  };
  const setFilter = async name => {
    if (await filter.evaluate(element => element.tagName === "SELECT")) await filter.selectOption({ label: name });
    else { await filter.click(); await page.clock.runFor(200); await page.getByRole("option", { name, exact: true }).click(); }
  };
  const tabTo = async target => {
    for (let index = 0; index < 80; index++) {
      await page.keyboard.press("Tab");
      if (await target.evaluate(element => element === document.activeElement)) return;
    }
    assert.fail(`keyboard Tab cannot reach ${await target.getAttribute("aria-label") ?? await target.innerText()}`);
  };
  let previous = null, scenario = "light14-wide";
  const frame = async (id, actionText, readiness, target = detail) => {
    await target.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
    const observed = await target.evaluate(element => {
      const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      const css = getComputedStyle(element), active = document.activeElement, focus = active && getComputedStyle(active);
      const box = rect(element);
      let fullyVisible = box.x >= 0 && box.y >= 0 && box.x + box.width <= innerWidth + 1 && box.y + box.height <= innerHeight + 1;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const bounds = parent.getBoundingClientRect(), style = getComputedStyle(parent);
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && (box.x < bounds.left - 1 || box.x + box.width > bounds.right + 1)) fullyVisible = false;
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (box.y < bounds.top - 1 || box.y + box.height > bounds.bottom + 1)) fullyVisible = false;
      }
      const root = document.getElementById("artifact-review-exercise");
      return {
        fullyVisible, box, text: element.textContent, fontSize: css.fontSize, color: css.color, background: css.backgroundColor,
        horizontalOverflow: [...root.querySelectorAll("*")].some(node => { const style = getComputedStyle(node); return style.display !== "none" && style.visibility !== "hidden" && !["hidden", "clip"].includes(style.overflowX) && node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1; }),
        buttons: [...element.querySelectorAll("button")].map(button => ({ label: button.textContent, disabled: button.disabled, box: rect(button) })),
        styles: [...new Set([...root.querySelectorAll("[class]")].map(node => node.className))],
        focus: active ? { label: active.getAttribute("aria-label") ?? active.textContent, visible: active.matches(":focus-visible"), outline: focus.outlineStyle, outlineWidth: focus.outlineWidth, boxShadow: focus.boxShadow, box: rect(active) } : null,
        theme: document.documentElement.classList.contains("dark") ? "dark" : "light", uiFont: getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size").trim(), reducedMotion: document.documentElement.dataset.reducedMotion,
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, desktopBridgePresent: typeof window.arealDesktop !== "undefined",
      };
    });
    const screenshot = `${id}.png`, observation = `${id}.json`;
    await target.screenshot({ path: join(scratch, screenshot), animations: "disabled" });
    await writeFile(join(scratch, observation), JSON.stringify(observed, null, 2));
    exercise.steps.push({ id, scenario, from: previous, action: actionText, readiness, observedAt: new Date().toISOString(), observation, screenshot: { path: screenshot, sha256: digest(await readFile(join(scratch, screenshot))), status: observed.fullyVisible ? "captured" : "partial" }, briefSha256, sourceHashes, network: { status: "not_requested", reason: "fixed local simulation" } });
    await save();
    previous = id;
    assert.equal(observed.desktopBridgePresent, false, "renderer exercise has no desktop bridge");
    assert.equal(observed.horizontalOverflow, false, "consumer content has no horizontal overflow");
    assert.equal(observed.fullyVisible, true, "evidence target is visible without clipping");
    for (const button of observed.buttons) assert.ok(button.box.x >= observed.box.x - 1 && button.box.x + button.box.width <= observed.box.x + observed.box.width + 1, "actions remain inside detail");
    return observed;
  };
  const appearance = async (theme, font, width) => {
    await page.getByLabel("主题", { exact: true }).selectOption(theme);
    await page.getByLabel("字号", { exact: true }).selectOption(font);
    await page.getByLabel("面板宽度", { exact: true }).selectOption(width);
    await page.waitForFunction(({ theme, font }) => document.documentElement.classList.contains("dark") === (theme === "dark") && getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size").trim() === `${font}px`, { theme, font });
  };
  await appearance("light", "14", "wide");
  await selected("guide");
  assert.ok((await region.innerText()).includes(registry.baseCandidate.version), "visible Base version matches frozen source");
  assert.match(await region.innerText(), /本地模拟/);
  await region.getByText("资料刷新：0", { exact: true }).waitFor();
  for (const object of objects) {
    assert.equal(await row(object.id).count(), 1);
    await checkRow(object.id, object.type);
    await checkRow(object.id, "未核对");
  }
  const wide = await frame("initial", "open fixed task", "six unreviewed objects; guide selected; refresh zero");
  assert.equal(wide.uiFont, "14px");
  assert.equal(wide.theme, "light");
  exercise.checks.push("fixed initial six names/types/results, selected guide, refresh zero, visible frozen version and simulation boundary");
  for (const [name, ids] of [["文档", ["guide", "draft"]], ["记录", ["trace", "metrics"]], ["图片", ["screenshot"]], ["其他", ["remote"]], ["视频", []]]) {
    await setFilter(name);
    for (const object of objects) assert.equal(await row(object.id).count(), ids.includes(object.id) ? 1 : 0, `${name} filter membership for ${object.id}`);
    if (ids.length) await selected(ids[0]);
    else {
      assert.equal(await detail.count(), 0, "empty filter has no stale selected detail");
      assert.match(await region.innerText(), /没有|暂无|无匹配/);
      await frame("empty-video", "select video filter", "empty state without hidden selection detail", region);
    }
  }
  await setFilter("全部");
  await selected("guide");
  await tabTo(action());
  const focus = await frame("keyboard-action-focus", "Tab to review action", "visible keyboard focus before Enter");
  assert.ok(focus.focus.visible && (focus.focus.outline !== "none" && parseFloat(focus.focus.outlineWidth) > 0 || focus.focus.boxShadow !== "none"), "keyboard action has visible focus styling");
  await page.keyboard.press("Enter");
  await hasResult(detail, "处理中");
  assert.equal(await action().isDisabled(), true, "pending review disables duplicate action");
  await frame("guide-pending", "Enter on guide review", "pending remains observable before timer completion");
  await setFilter("图片");
  await selected("screenshot");
  await page.clock.runFor(700);
  await setFilter("全部");
  await selected("screenshot");
  await hasResult(detail, "未核对");
  await checkRow("guide", "已核对");
  await checkRow("screenshot", "未核对");
  await frame("late-guide-result", "switch to screenshot while guide pending; advance local timers", "guide succeeded and screenshot detail remains unreviewed");
  exercise.checks.push("filters include exact memberships and empty detail removal; guide pending blocks repeat; late result belongs only to guide");
  await tabTo(row("trace"));
  await page.keyboard.press("Space");
  await selected("trace");
  await action().click();
  await page.clock.runFor(700);
  await hasResult(detail, "明确失败");
  if (!await detail.getByText("明确失败，文件已移走。", { exact: true }).isVisible()) await detail.getByRole("button", { name: "查看详情", exact: true }).click();
  assert.match(await detail.innerText(), /文件已移走/);
  await frame("trace-failed", "Space selects trace; review and complete timer", "explicit failure retains complete long name and cause");
  await row("remote").click();
  await selected("remote");
  assert.equal(await action().isDisabled(), true);
  assert.match(await detail.innerText(), /仅远端|远端.*本地|本地.*不可用/);
  await frame("remote-unavailable", "select remote", "disabled review with visible local-unavailable reason");
  await row("trace").click();
  await hasResult(detail, "明确失败");
  if (!await detail.getByText("明确失败，文件已移走。", { exact: true }).isVisible()) await detail.getByRole("button", { name: "查看详情", exact: true }).click();
  assert.match(await detail.innerText(), /文件已移走/);
  await row("draft").click();
  await selected("draft");
  assert.match(await detail.innerText(), /可能过期/);
  await action().click();
  await page.clock.runFor(700);
  await hasResult(detail, "结果未知");
  const operation = (await detail.innerText()).match(/操作标识[：:]\s*([^\s]+)/)?.[1];
  assert.ok(operation, "unknown review exposes a nonempty operation identity");
  assert.ok(await action().count() === 0 || await action().isDisabled(), "unknown cannot trigger another review");
  await frame("draft-unknown", "review draft and complete first timer", "unknown with stable operation identity and explicit reconciliation");
  await page.clock.runFor(2000);
  await hasResult(detail, "结果未知");
  assert.ok((await detail.innerText()).includes(operation));
  await tabTo(refresh);
  await page.keyboard.press("Enter");
  await region.getByText("资料刷新：1", { exact: true }).waitFor();
  await selected("draft");
  await page.clock.runFor(2000);
  await hasResult(detail, "结果未知");
  assert.ok((await detail.innerText()).includes(operation), "refresh preserves unknown operation identity");
  const reconcile = detail.getByRole("button", { name: "核对结果", exact: true });
  await tabTo(reconcile);
  await page.keyboard.press("Space");
  await page.clock.runFor(700);
  await hasResult(detail, "已核对");
  await checkRow("guide", "已核对");
  await checkRow("trace", "明确失败");
  await checkRow("screenshot", "未核对");
  await checkRow("remote", "未核对");
  await checkRow("metrics", "未核对");
  await frame("draft-reconciled", "Space activates explicit reconciliation", "draft succeeds only after explicit action; other object results retained");
  exercise.checks.push("failure cause persists on reselection; remote review is unavailable; unknown keeps operation identity across time and refresh until explicit keyboard reconciliation");
  await tabTo(refresh);
  await page.keyboard.press("Space");
  await region.getByText("资料刷新：2", { exact: true }).waitFor();
  await selected("draft");
  await hasResult(detail, "已核对");
  await checkRow("guide", "已核对");
  await checkRow("trace", "明确失败");
  await checkRow("draft", "已核对");
  await checkRow("screenshot", "未核对");
  await page.clock.runFor(2000);
  await selected("draft");
  await checkRow("guide", "已核对");
  await checkRow("trace", "明确失败");
  await checkRow("draft", "已核对");
  await checkRow("screenshot", "未核对");
  await tabTo(filter);
  if (await filter.evaluate(element => element.tagName === "SELECT")) { await page.keyboard.press("Home"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter"); }
  else { await page.keyboard.press("Enter"); await page.clock.runFor(200); await page.keyboard.press("Home"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter"); }
  await selected("draft");
  assert.equal(await row("trace").count(), 0, "keyboard filter selects documents and retains included selection");
  await setFilter("全部");
  await row("trace").click();
  await selected("trace");
  await frame("light14-wide-long-name", "restore all and select failed long-name trace", "full name and persisted failure in light14 wide");
  scenario = "dark18-narrow"; previous = null;
  await appearance("dark", "18", "narrow");
  const name = detail.getByRole("heading", { name: objects[1].name, exact: true });
  const fullName = await name.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const bounds = element.getBoundingClientRect(), css = getComputedStyle(element);
    return { text: element.textContent, ellipsis: css.textOverflow === "ellipsis", clipped: element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1, rects: [...range.getClientRects()].map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })), bounds: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom } };
  });
  assert.equal(fullName.text, objects[1].name);
  assert.equal(fullName.clipped, false, "complete long filename wraps without clipping");
  for (const rect of fullName.rects) assert.ok(rect.left >= fullName.bounds.left - 1 && rect.right <= fullName.bounds.right + 1 && rect.top >= fullName.bounds.top - 1 && rect.bottom <= fullName.bounds.bottom + 1, "all filename glyph ranges fit the heading");
  await writeFile(join(scratch, "dark18-narrow-long-name-text.json"), JSON.stringify(fullName, null, 2));
  const narrow = await frame("dark18-narrow-long-name", "change theme, font and panel width", "long full name, retained failure and contained actions");
  assert.ok(narrow.box.width < wide.box.width, "narrow condition has a smaller consumer detail width");
  assert.equal(narrow.uiFont, "18px");
  assert.equal(narrow.theme, "dark");
  await page.getByLabel("减少动态效果", { exact: true }).check();
  await page.waitForFunction(() => document.documentElement.dataset.reducedMotion === "true");
  await row("metrics").click();
  await selected("metrics");
  await tabTo(action());
  const darkFocus = await frame("dark18-keyboard-focus", "Tab to review in dark narrow reduced-motion", "visible keyboard focus remains in the current flow");
  assert.ok(darkFocus.focus.visible && (darkFocus.focus.outline !== "none" && parseFloat(darkFocus.focus.outlineWidth) > 0 || darkFocus.focus.boxShadow !== "none"), "dark narrow keyboard action has visible focus styling");
  await page.keyboard.press("Enter");
  await hasResult(detail, "处理中");
  await page.clock.runFor(700);
  await hasResult(detail, "已核对");
  await checkRow("guide", "已核对");
  await checkRow("trace", "明确失败");
  await checkRow("draft", "已核对");
  await checkRow("screenshot", "未核对");
  await frame("reduced-motion-complete", "enable reduced motion and review metrics", "same successful terminal result with prior object states retained");
  exercise.checks.push("keyboard Tab/Enter/Space reach object selection, filtering, refresh, review and reconciliation; focus indicator recorded");
  exercise.checks.push("refresh count increments without result reset or implicit unknown settlement; light14 wide and dark18 narrow retain complete long name and contained content; reduced motion keeps terminal behavior");
  exercise.verdicts.behavior = "VERIFIED";
  await save();
  return exercise;
}
