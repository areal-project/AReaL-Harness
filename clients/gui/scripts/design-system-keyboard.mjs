import assert from "node:assert/strict";

async function tabTo(page, target) {
  for (let step = 0; step < 30; step++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  assert.fail(
    `Tab did not reach ${(await target.getAttribute("aria-label")) ?? (await target.innerText())}`,
  );
}

export async function runAccessibilityKeyboard(page, checks) {
  const origin = new URL(page.url()).origin;
  for (const decision of ["拒绝 Esc", "允许一次"]) {
    await page.goto(`${origin}/design-system.html?content-system`);
    const region = page.getByRole("region", { name: "内容与决策系统", exact: true });
    const approval = region.getByRole("region", { name: "审批预览", exact: true });
    await approval.locator("summary").filter({ hasText: "查看完整请求" }).focus();
    const button = approval.getByRole("button", { name: decision, exact: true });
    await tabTo(page, button);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
      document.querySelector('[aria-label="预览调用记录"]')?.textContent.includes("响应次数：1"),
    );
    assert.equal(await button.isDisabled(), true, "accepted decision cannot be sent twice");
  }
  await page.goto(`${origin}/design-system.html?content-system`);
  const question = page.getByRole("region", { name: "提问预览", exact: true });
  const radios = question.getByRole("radio");
  await radios.first().focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await radios.nth(1).isChecked(),
    true,
    "native arrows select an answer without submitting it",
  );
  await page.keyboard.press("Escape");
  const restore = question.getByRole("button", { name: "展开待回答问题", exact: true });
  await restore.waitFor();
  assert.equal(
    await restore.evaluate((element) => element === document.activeElement),
    true,
    "deferred question retains reachable keyboard focus",
  );
  await page.keyboard.press("Enter");
  assert.equal(await radios.nth(1).isChecked(), true, "answer draft survives Escape and reopening");
  await tabTo(page, question.getByRole("button", { name: "发送", exact: true }));
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.querySelector('[aria-label="预览调用记录"]')?.textContent.includes("响应次数：1"),
  );
  checks.push(
    "Tab and Enter approve and deny once; native radio arrows select; Escape defers and restores focus without losing the answer",
  );

  await page.goto(`${origin}/design-system.html`);
  const composer = page.getByTestId("preview-composer");
  await composer.focus();
  await page.keyboard.insertText("键盘发送验收");
  await page.keyboard.press("Enter");
  await page.getByText("预览收到输入，草稿保留。", { exact: true }).waitFor();
  checks.push("production Composer receives text and sends using the keyboard");

  await page.goto(`${origin}/design-system.html?settings`);
  const settings = page.locator('[data-settings-host="page"]');
  const controls = settings.locator(
    ':is(button, input, textarea, select):visible:enabled:not([tabindex="-1"])',
  );
  assert.ok((await controls.count()) >= 5, "settings keyboard fixture needs real controls");
  await controls.first().focus();
  for (let index = 1; index < Math.min(5, await controls.count()); index++) {
    await page.keyboard.press("Tab");
    assert.equal(
      await controls.nth(index).evaluate((element) => element === document.activeElement),
      true,
      "settings Tab follows DOM order",
    );
    const previous = await controls.nth(index - 1).boundingBox();
    const current = await controls.nth(index).boundingBox();
    assert.ok(
      current.y >= previous.y - 1,
      "settings focus does not move upward against its visual order",
    );
  }
  checks.push("settings controls follow visual and DOM order with Tab");
}
