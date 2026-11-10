import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export function nativeDialogI18n(scratch) {
  const frames = [],
    observations = [];
  return {
    model: () => false,
    frames: () => frames,
    async run({ app, page: getPage, button, state, call, received, checks, quit, launch }) {
      let page = getPage();
      const selectLocale = async (current, target) => {
        await page
          .getByRole("tablist", { name: current === "en" ? "Language" : "语言", exact: true })
          .getByRole("tab", { name: target === "en" ? "English" : "简体中文", exact: true })
          .click();
        await page.waitForFunction((locale) => document.documentElement.lang === locale, target);
      };
      const capture = async (name) => {
        await page.screenshot({ path: join(scratch, `${name}.png`), animations: "disabled" });
        frames.push(`${name}.png`);
        await writeFile(
          join(scratch, `${name}.aria.txt`),
          await page.locator("body").ariaSnapshot(),
        );
      };
      const projectId = (await state()).projects.find((project) => !project.projectless).id;
      const { threadId } = await call("create", {
        projectId,
        profile: { id: "standard", revision: "v1" },
      });
      const checkDialogs = async (locale) => {
        await app().evaluate(({ app, dialog }) => {
          app.i18nDialogs = [];
          dialog.showMessageBox = async (...args) => {
            app.i18nDialogs.push({ kind: "message", ...args.at(-1) });
            return { response: 0 };
          };
          dialog.showSaveDialog = async (...args) => {
            app.i18nDialogs.push({ kind: "save", ...args.at(-1) });
            return { canceled: true };
          };
          dialog.showOpenDialog = async (...args) => {
            app.i18nDialogs.push({ kind: "open", ...args.at(-1) });
            return { canceled: true, filePaths: [] };
          };
        });
        assert.equal(
          (await call("manage", { projectId, threadId, operation: "archive" })).canceled,
          true,
        );
        assert.equal((await call("exportDiagnostics", {})).canceled, true);
        assert.deepEqual(
          await page.evaluate(async () => [
            await window.arealDesktop.chooseProject(),
            await window.arealDesktop.chooseTaskDirectory(),
            await window.arealDesktop.chooseProjectlessDirectory(),
          ]),
          [null, null, null],
        );
        const dialogs = await app().evaluate(({ app }) => app.i18nDialogs);
        observations.push({ locale, dialogs });
        await writeFile(
          join(scratch, "native-dialogs.json"),
          JSON.stringify(observations, null, 2),
        );
        assert.equal(
          dialogs[0].message,
          locale === "en" ? "Archive this conversation?" : "归档此会话？",
        );
        assert.deepEqual(
          dialogs[0].buttons,
          locale === "en" ? ["Cancel", "Archive conversation"] : ["取消", "归档会话"],
        );
        assert.equal(dialogs[1].title, locale === "en" ? "Export diagnostics" : "导出诊断包");
        assert.deepEqual(
          dialogs.slice(2).map((dialog) => dialog.title),
          locale === "en"
            ? ["Open project", "Choose working directory", "Choose projectless task folder"]
            : ["打开项目", "选择工作目录", "选择无项目任务文件夹"],
        );
        if (locale === "en")
          assert.doesNotMatch(
            JSON.stringify(dialogs),
            /\p{Script=Han}/u,
            "all application-owned native copy follows English",
          );
        const invalidTheme = await page.evaluate(async () => {
          try {
            await window.arealDesktop.theme("unknown-fixture-theme");
          } catch (error) {
            return error.message;
          }
        });
        assert.match(invalidTheme, locale === "en" ? /Unknown theme/ : /未知主题/);
        assert.equal(
          (await state()).projects.find((project) => project.id === projectId).state.threads[
            threadId
          ].desktop?.archived === true,
          false,
        );
        await capture(`native-dialogs-${observations.length}-${locale}`);
      };
      try {
        await button("设置").click();
        await page
          .locator(".settings-category-navigation")
          .getByRole("button", { name: "常规", exact: true })
          .click();
        await checkDialogs("zh-CN");
        await selectLocale("zh-CN", "en");
        await checkDialogs("en");
        await page.evaluate(() =>
          window.arealDesktop.setInterfaceLocale("unsupported-fixture-locale"),
        );
        await app().evaluate(({ ipcMain }) =>
          ipcMain.emit("areal-core:interface-locale", { sender: null, senderFrame: null }, "zh-CN"),
        );
        await checkDialogs("en");
        await page.reload();
        await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
        assert.equal(await page.locator("html").getAttribute("lang"), "en");
        await checkDialogs("en");
        if (!(await page.locator(".settings-category-navigation").isVisible()))
          await button("Settings").click();
        await page
          .locator(".settings-category-navigation")
          .getByRole("button", { name: "General", exact: true })
          .click();
        await selectLocale("en", "zh-CN");
        await checkDialogs("zh-CN");
        await selectLocale("zh-CN", "en");
        await quit();
        await launch();
        page = getPage();
        await button("Settings").click();
        await page
          .locator(".settings-category-navigation")
          .getByRole("button", { name: "General", exact: true })
          .click();
        assert.equal(await page.locator("html").getAttribute("lang"), "en");
        await checkDialogs("en");
        assert.equal(
          received.length,
          0,
          "native confirmations and locale switching invoke no model",
        );
        checks.push(
          "native dialog i18n through real Electron preload/Main/Core; zh-CN/en switch and cold restart; archive/export/diagnostics/directory options and theme error; invalid locale and injected untrusted sender cannot change locale; cancellation preserves conversation; no model requests",
        );
      } finally {
        await writeFile(
          join(scratch, "native-dialog-observations.json"),
          JSON.stringify(
            {
              observations,
              limits: [
                "native dialogs intercepted at Electron dialog API",
                "archive/export initiated through production preload commands",
                "macOS source build; no package or other OS acceptance",
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
