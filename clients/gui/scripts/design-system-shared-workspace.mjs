import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function runSharedWorkspace(page, scratch, report, baseline) {
  const scope = page.getByRole("region", { name: "共享工作区预览", exact: true });
  const main = scope.getByTestId("shared-main-input");
  const side = () => scope.getByTestId("side-chat-input");
  const frames = [];
  const settle = () =>
    page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter(
            (a) =>
              a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime),
          )
          .map((a) => a.finished.catch(() => {})),
      );
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
  const capture = async (id) => {
    await scope.scrollIntoViewIfNeeded();
    await settle();
    const facts = await scope.evaluate((el) => {
      const geometry = (selector) => {
        const target = el.querySelector(selector);
        if (!target) return null;
        const root = target.closest(".composer-surface"),
          css = getComputedStyle(root),
          r = root.getBoundingClientRect();
        return {
          layout: root.dataset.layout,
          display: css.display,
          padding: css.padding,
          radius: css.borderRadius,
          width: r.width,
          height: r.height,
          font: getComputedStyle(target).fontSize,
          draft: target.textContent,
          overflow: root.scrollWidth - root.clientWidth,
          buttons: [...root.querySelectorAll("button")].map((b) => {
            const q = b.getBoundingClientRect();
            return {
              label: b.getAttribute("aria-label"),
              disabled: b.disabled,
              left: q.left - r.left,
              right: q.right - r.right,
            };
          }),
        };
      };
      return {
        mode: el.querySelector("[data-shared-mode]").dataset.sharedMode,
        viewport: [innerWidth, innerHeight],
        theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
        font: getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size"),
        main: geometry('[data-testid="shared-main-input"]'),
        side: geometry('[data-testid="side-chat-input"]'),
      };
    });
    await scope.screenshot({ path: join(scratch, id + ".png"), animations: "disabled" });
    await writeFile(join(scratch, id + ".aria.txt"), await scope.ariaSnapshot());
    frames.push({ id, facts });
    await writeFile(join(scratch, "shared-states.json"), JSON.stringify(frames, null, 2));
    return facts;
  };
  for (const [input, text] of [
    [main, "主草稿：检查面板返回"],
    [side(), "Side草稿：保留独立问题"],
  ]) {
    await input.click();
    await input.press("Meta+A");
    await page.keyboard.insertText(text);
  }
  await page.waitForFunction(() =>
    Object.values(localStorage).some((v) => v === "Side草稿：保留独立问题"),
  );
  if (!baseline) {
    const mainModel = scope.locator(".work-surface").getByTestId("composer-model-trigger");
    const sideModel = scope.locator(".side-chat-pane").getByTestId("composer-model-trigger");
    assert.equal(
      await sideModel.innerText(),
      await mainModel.innerText(),
      "new Side uses the same model name and effort as main",
    );
    await sideModel.click();
    const modelMenu = page.getByRole("dialog", { name: "选择模型", exact: true });
    const models = modelMenu.getByRole("radiogroup", { name: "模型列表", exact: true });
    await models.waitFor();
    assert.equal(
      await models.getByRole("radio", { name: /继承/ }).count(),
      0,
      "model menu has no separate inheritance copy",
    );
    assert.equal(
      await models.getByRole("radio", { checked: true }).count(),
      1,
      "source model is selected in the shared catalog",
    );
    assert.equal(await models.getByRole("radio").count(), 1, "current provider owns one model");
    const preview = modelMenu.getByRole("tab", { name: "preview", exact: true });
    const alternate = modelMenu.getByRole("tab", { name: "preview-alternate", exact: true });
    assert.ok(await preview.isVisible());
    assert.ok(await alternate.isVisible());
    await alternate.click();
    const alternatePanel = modelMenu.getByRole("tabpanel", {
      name: "preview-alternate",
      exact: true,
    });
    await alternatePanel.getByRole("radio").waitFor();
    assert.equal(
      await alternatePanel.getByRole("radio").count(),
      1,
      "alternate provider owns one model",
    );
    assert.equal(
      await page
        .locator('[data-model-value="preview-alternate/shared"]')
        .getByRole("radio")
        .isChecked(),
      false,
      "same-named model from another provider is a distinct selection",
    );
    await page.keyboard.press("Escape");
    await modelMenu.waitFor({ state: "detached" });
    await mainModel.click();
    await alternate.click();
    await page.locator('[data-model-value="preview-alternate/shared"]').getByRole("radio").click();
    await modelMenu.waitFor({ state: "detached" });
    assert.match(await mainModel.getAttribute("title"), /preview-alternate/);
    await mainModel.click();
    assert.equal(
      await page
        .locator('[data-model-value="preview-alternate/shared"]')
        .getByRole("radio")
        .isChecked(),
      true,
    );
    await preview.click();
    assert.equal(
      await page.locator('[data-model-value="preview/shared"]').getByRole("radio").isChecked(),
      false,
    );
    await page.locator('[data-model-value="preview/shared"]').getByRole("radio").click();
    await modelMenu.waitFor({ state: "detached" });
    await page.keyboard.press("Escape");
    assert.equal(
      await main.innerText(),
      "主草稿：检查面板返回",
      "provider switch preserves the draft",
    );
    report.checks.push(
      "Same-named models stay distinct across provider tabs and identify the selected provider in the trigger title; selection remains provider-specific and preserves the draft (local fixture only)",
    );
    report.checks.push(
      "New Side model name and effort match main, without a separate inheritance menu entry",
    );
  }
  const split = await capture("01-split");
  await scope.getByRole("button", { name: "进入完整视图", exact: true }).click();
  const full = await capture("02-side-full");
  assert.equal(
    await scope.locator(".work-surface").evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgba(0, 0, 0, 0)",
    "the production shell keeps the mounted main surface from obscuring the full Side view",
  );
  if (!baseline) {
    assert.equal(full.side.padding, split.side.padding);
    assert.equal(full.side.display, split.side.display);
    assert.equal(full.side.layout, "default");
    assert.equal(full.side.font, split.side.font);
  }
  const model = scope.locator(".side-chat-pane").getByTestId("composer-model-trigger");
  await model.click();
  await page.keyboard.press("Escape");
  await side().waitFor();
  assert.equal(await side().innerText(), "Side草稿：保留独立问题");
  await scope.getByRole("tab", { name: "文件", exact: true }).click();
  await scope.getByRole("region", { name: "共享文件阅读", exact: true }).waitFor();
  const file = await capture("03-file-full");
  if (!baseline) assert.equal(file.main.layout, "compact");
  // The full resource view uses the input's own width, including long drafts.
  await page.getByLabel("面板宽度", { exact: true }).selectOption("narrow");
  const longDraft = "长输入保持在原编辑区内滚动。\n".repeat(30);
  await main.click();
  await main.press("Meta+A");
  await page.keyboard.insertText(longDraft);
  const narrow = await capture("03a-file-narrow-long");
  if (!baseline) {
    assert.equal(narrow.main.layout, "compact");
    assert.equal(narrow.main.display, "flex");
    assert.ok(narrow.main.overflow <= 1, "compact input stays within its actual narrow container");
    const scroll = await main.evaluate((el) => {
      const editor = el.closest(".composer-editor");
      return { height: editor.clientHeight, scroll: editor.scrollHeight };
    });
    assert.ok(
      scroll.scroll > scroll.height,
      "long compact draft uses the existing editor scroll owner",
    );
    for (const b of narrow.main.buttons)
      assert.ok(b.left >= -1 && b.right <= 1, "compact " + b.label + " stays reachable");
  }
  await main.press("Meta+A");
  await page.keyboard.insertText("主草稿：检查面板返回");
  await page.getByLabel("面板宽度", { exact: true }).selectOption("wide");
  await scope.getByRole("tab", { name: "侧边聊天", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="side-chat-input"]')?.textContent ===
      "Side草稿：保留独立问题",
  );
  assert.equal(await side().innerText(), "Side草稿：保留独立问题");
  await scope.getByRole("button", { name: "返回主会话", exact: true }).click();
  assert.equal(await main.innerText(), "主草稿：检查面板返回");
  await scope.getByRole("button", { name: "打开共享设置", exact: true }).click();
  await page.getByRole("dialog").getByLabel("共享阅读密度", { exact: true }).click();
  await page.getByRole("option", { name: "宽松", exact: true }).click();
  await page.keyboard.press("Escape");
  assert.equal(await main.innerText(), "主草稿：检查面板返回");
  await scope.getByRole("button", { name: "打开侧边聊天", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="side-chat-input"]')?.textContent ===
      "Side草稿：保留独立问题",
  );
  assert.equal(await side().innerText(), "Side草稿：保留独立问题");
  await capture("04-return");
  const panel = scope.locator(".workspace-side-panel");
  const fileTab = scope.locator('[data-side-pane-tab-id="文件"]');
  await fileTab.hover();
  await fileTab.locator('[aria-label="关闭 文件 标签"]').click();
  await fileTab.waitFor({ state: "detached" });
  assert.equal(
    await panel.isVisible(),
    true,
    "closing a sibling tab keeps the remaining panel open",
  );
  const sideTab = scope.getByRole("tab", { name: "侧边聊天", exact: true });
  await sideTab.focus();
  await sideTab.press("Delete");
  await panel.waitFor({ state: "hidden" });
  assert.equal(
    await main.innerText(),
    "主草稿：检查面板返回",
    "last tab close preserves the main draft",
  );
  await capture("06-last-tab-closed");
  await scope.getByRole("button", { name: "打开侧边聊天", exact: true }).click();
  assert.equal(
    await panel.locator("[data-side-pane-tab-id]").count(),
    1,
    "reopening does not resurrect the closed file tab",
  );
  await scope.getByRole("button", { name: "进入完整视图", exact: true }).click();
  await scope.getByRole("tab", { name: "侧边聊天", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "关闭所有标签页", exact: true }).click();
  await panel.waitFor({ state: "hidden" });
  assert.equal(
    await scope.locator("[data-shared-mode]").getAttribute("data-shared-mode"),
    "split",
    "closing all tabs exits full panel view",
  );
  assert.equal(await main.innerText(), "主草稿：检查面板返回");
  await capture("07-all-tabs-closed");
  report.checks.push(
    "Closing a sibling keeps the panel; closing the last tab or all tabs hides it, exits full view and preserves the main draft",
  );
  await scope.getByRole("button", { name: "打开侧边聊天", exact: true }).click();
  await side().waitFor();
  for (const sample of [
    { theme: "light", font: "14", width: 1440 },
    { theme: "dark", font: "18", width: 900 },
  ]) {
    await page.setViewportSize({ width: sample.width, height: 1100 });
    await page.getByLabel("主题", { exact: true }).selectOption(sample.theme);
    await page.getByLabel("字号", { exact: true }).selectOption(sample.font);
    await model.click();
    await settle();
    await page.screenshot({
      path: join(scratch, "models-" + sample.theme + ".png"),
      animations: "disabled",
    });
    const modelRows = await page
      .getByRole("radiogroup", { name: "模型列表", exact: true })
      .evaluate((el) => ({
        width: el.clientWidth,
        scroll: el.scrollWidth,
        rows: [...el.querySelectorAll('[role="radio"]')].map((row) => ({
          width: row.clientWidth,
          scroll: row.scrollWidth,
        })),
      }));
    assert.ok(
      modelRows.scroll <= modelRows.width + 1 &&
        modelRows.rows.every((row) => row.scroll <= row.width + 1),
      "provider/model labels fit the menu at " + sample.theme + " " + sample.font,
    );
    await page.keyboard.press("Escape");
    const f = await capture("05-" + sample.theme + "-" + sample.font);
    if (!baseline)
      for (const owner of ["main", "side"]) {
        assert.ok(f[owner].overflow <= 1, owner + " surface stays within its column");
        for (const b of f[owner].buttons)
          assert.ok(b.left >= -1 && b.right <= 1, owner + " " + b.label + " stays reachable");
      }
  }
  report.steps.push(...frames);
  report.checks.push(
    "Production Composer/SidePane/Side/Settings composition: explicit full-view layout, separate drafts, model-menu return, tab revisit and representative narrow typography; fixture boundary only",
  );
}
