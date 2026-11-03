import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export function settingsI18n(scratch) {
  const frames = [],
    observations = [];
  return {
    model: () => false,
    frames: () => frames,
    async run({ app, page: getPage, button, until, received, checks, quit, launch }) {
      let page = getPage();
      const capture = async (name) => {
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        await page.screenshot({
          path: join(scratch, `${name}.png`),
          scale: "css",
          animations: "disabled",
        });
        await writeFile(
          join(scratch, `${name}.aria.txt`),
          await page.locator("body").ariaSnapshot(),
        );
        frames.push(`${name}.png`);
        const metrics = await page.evaluate(() => ({
          locale: document.documentElement.lang,
          overflow: [...document.querySelectorAll(".settings-workspace, .plugin-center")]
            .filter((el) => el.checkVisibility())
            .some((el) => el.scrollWidth > el.clientWidth + 1),
          headings: [...document.querySelectorAll("main h1, main h2")]
            .filter((el) => el.checkVisibility())
            .map((el) => el.textContent),
        }));
        assert.equal(metrics.overflow, false, `${name} has no horizontal overflow`);
        observations.push({ name, ...metrics });
      };
      const selectLocale = async (current, target) => {
        const group = page.getByRole("tablist", {
          name: current === "en" ? "Language" : "语言",
          exact: true,
        });
        await group
          .getByRole("tab", { name: target === "en" ? "English" : "简体中文", exact: true })
          .click();
        await page.waitForFunction((locale) => document.documentElement.lang === locale, target);
      };
      const navigation = page.locator(".settings-category-navigation");
      try {
        await app().evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(1440, 960),
        );
        await writeFile(
          join(scratch, "i18n-host.json"),
          JSON.stringify(
            await app().evaluate(({ app, BrowserWindow }) => ({
              pid: process.pid,
              userData: app.getPath("userData"),
              versions: process.versions,
              preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
            })),
            null,
            2,
          ),
        );
        const input = page.locator('[data-testid="chat-input"]');
        await input.fill("I18N_UNSENT_DRAFT");
        await page.waitForFunction(() => Object.values(localStorage).includes("I18N_UNSENT_DRAFT"));
        await button("设置").click();
        await navigation.getByRole("button", { name: "常规", exact: true }).click();
        assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
        await capture("i18n-01-chinese-general");
        const generalNode = page.locator(".settings-workspace");
        await generalNode.evaluate((el) => {
          el.dataset.localeProbe = "same-page";
        });
        await selectLocale("zh-CN", "en");
        assert.equal(
          await generalNode.getAttribute("data-locale-probe"),
          "same-page",
          "language changes preserve the mounted page",
        );
        await page.getByRole("heading", { name: "General", exact: true }).waitFor();
        await page.getByText("System default app", { exact: true }).waitFor();
        await capture("i18n-02-english-general");
        const labels = [
          "General",
          "Appearance",
          "Usage",
          "Plugins",
          "Browser",
          "Hooks",
          "Models",
          "Session configuration",
          "Data sharing",
          "Mobile connection",
        ];
        assert.deepEqual(
          await navigation.locator(".settings-navigation-item span").allTextContents(),
          labels,
        );
        const search = page.locator(".settings-navigation-search input");
        await search.fill("appearance");
        assert.deepEqual(
          await navigation.locator(".settings-navigation-item span").allTextContents(),
          ["Appearance"],
        );
        await search.fill("missing-setting");
        await page.getByText("No matching settings", { exact: true }).waitFor();
        await search.fill("");
        for (const [index, label] of labels.entries()) {
          await navigation.getByRole("button", { name: label, exact: true }).click();
          await page.locator('[data-view="settings"]').waitFor();
          if (label !== "Plugins")
            await page.getByRole("heading", { name: label, exact: true }).waitFor();
          if (label === "Models")
            await page
              .getByText("Loading providers…", { exact: true })
              .waitFor({ state: "hidden" });
          await capture(`i18n-en-${String(index + 1).padStart(2, "0")}`);
        }
        await navigation.getByRole("button", { name: "Models", exact: true }).click();
        await button("Add provider").click();
        await page.getByTestId("custom-provider").click();
        await page.getByRole("heading", { name: /Custom provider/ }).waitFor();
        await page
          .locator(".provider-method-card")
          .filter({ hasText: "No authentication" })
          .click();
        const providerName = page.getByRole("textbox", { name: "Provider name", exact: true });
        assert.equal(await providerName.inputValue(), "Custom provider");
        await providerName.fill("I18N_DRAFT_PROVIDER");
        await page.getByRole("tab", { name: "Model", exact: true }).click();
        await button("Add model").click();
        const editor = page.getByRole("dialog", { name: "Add model", exact: true });
        await editor.getByRole("button", { name: "Save model", exact: true }).click();
        await editor
          .getByRole("alert")
          .filter({ hasText: "Model ID must be unique and cannot be empty" })
          .waitFor();
        await editor
          .getByRole("textbox", { name: "Model ID", exact: true })
          .fill("I18N_MODEL_DRAFT");
        await editor.getByRole("button", { name: "Cancel", exact: true }).click();
        const discard = page.getByRole("dialog", { name: "Discard model changes?", exact: true });
        await discard.getByRole("button", { name: "Keep editing", exact: true }).click();
        assert.equal(
          await editor.getByRole("textbox", { name: "Model ID", exact: true }).inputValue(),
          "I18N_MODEL_DRAFT",
        );
        await capture("i18n-06-model-validation-draft");
        await editor.getByRole("button", { name: "Cancel", exact: true }).click();
        await page
          .getByRole("dialog", { name: "Discard model changes?", exact: true })
          .getByRole("button", { name: "Discard changes", exact: true })
          .click();
        await navigation.getByRole("button", { name: "General", exact: true }).click();
        const unsaved = page.getByRole("dialog", {
          name: "Provider has unsaved changes",
          exact: true,
        });
        await unsaved.getByRole("button", { name: "Keep editing", exact: true }).click();
        await page.getByRole("tab", { name: "Connection settings", exact: true }).click();
        assert.equal(await providerName.inputValue(), "I18N_DRAFT_PROVIDER");
        await navigation.getByRole("button", { name: "General", exact: true }).click();
        await page
          .getByRole("dialog", { name: "Provider has unsaved changes", exact: true })
          .getByRole("button", { name: "Discard and continue", exact: true })
          .click();
        await navigation.getByRole("button", { name: "Appearance", exact: true }).click();
        await app().evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(1000, 720),
        );
        const size = page.getByRole("spinbutton", { name: "Interface font size", exact: true });
        await size.fill("18");
        await size.press("Tab");
        await capture("i18n-03-english-narrow-large");
        await size.fill("14");
        await size.press("Tab");
        await app().evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(1440, 960),
        );
        await navigation.getByRole("button", { name: "General", exact: true }).click();
        await selectLocale("en", "zh-CN");
        await capture("i18n-04-chinese-restored");
        await page.locator(".settings-navigation-search input").fill("外观");
        assert.deepEqual(
          await navigation.locator(".settings-navigation-item span").allTextContents(),
          ["外观"],
        );
        await page.locator(".settings-navigation-search input").fill("");
        await selectLocale("zh-CN", "en");
        await button("Back to app").click();
        await page.waitForFunction(() =>
          document
            .querySelector('[data-testid="chat-input"]')
            ?.textContent?.includes("I18N_UNSENT_DRAFT"),
        );
        assert.equal((await input.innerText()).trim(), "I18N_UNSENT_DRAFT");
        assert.equal(received.length, 0, "locale and settings navigation never invoke the model");
        await quit();
        await launch();
        page = getPage();
        await button("Settings").click();
        await page
          .locator(".settings-category-navigation")
          .getByRole("button", { name: "General", exact: true })
          .click();
        assert.equal(await page.locator("html").getAttribute("lang"), "en");
        assert.equal(
          await page
            .getByRole("tablist", { name: "Language", exact: true })
            .getByRole("tab", { name: "English", exact: true })
            .getAttribute("aria-selected"),
          "true",
        );
        await capture("i18n-05-reopened-english");
        assert.equal(received.length, 0);
        checks.push(
          "settings i18n: real Electron zh-CN/en switch without page remount; all 11 English settings routes, bilingual search, narrow large text, composer draft retention, custom provider creation, model validation and nested discard dialogs, cold restart persistence; no model requests",
        );
        await until((snapshot) => snapshot.connection.state === "ready", "reopened backend ready");
      } finally {
        await writeFile(
          join(scratch, "i18n-observations.json"),
          JSON.stringify(
            {
              observations,
              limits: [
                "source macOS Electron with real Core",
                "native project picker injected",
                "external plugin content and raw service diagnostics keep their language",
                "no package, native menu or other OS acceptance",
              ],
            },
            null,
            2,
          ),
        );
      }
    },
  };
}
