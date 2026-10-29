import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite-plus";
import { certificates, relayFixture, hostFixture, waitFor } from "./remote-relay-fixture.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const gui = join(root, "clients/gui");
const require = createRequire(new URL("../app/package.json", import.meta.url));
const { chromium, webkit, devices } = require("playwright-core");
const output = join(root, ".scratch/ios-development/browser", `${Date.now()}`);

// 仅让 Node 信任一次性夹具 CA；浏览器上下文显式使用隔离 TLS 夹具。
if (!process.env.AREAL_IOS_TLS_HOME) {
  const home = await certificates();
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, AREAL_IOS_TLS_HOME: home, NODE_EXTRA_CA_CERTS: join(home, "ca.pem") },
    });
    process.exitCode = await new Promise((resolve) =>
      child.once("exit", (code) => resolve(code ?? 1)),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
} else {
  await mkdir(output, { recursive: true });
  const cleanup = [];
  const fixture = { after: (fn) => cleanup.push(fn) };
  const records = [];
  const started = Date.now();
  const report = {
    source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }).trim(),
    node: process.version,
    relayNode: execFileSync(process.env.AREAL_RELAY_NODE ?? process.execPath, ["--version"], {
      encoding: "utf8",
    }).trim(),
    platform: process.platform,
    arch: process.arch,
    playwright: require("playwright-core/package.json").version,
    boundary:
      "Production React UI and encrypted Relay pairing; in-memory browser platform and fixture Host; no Core/Runtime, native Keychain or iOS keyboard acceptance",
    records,
  };
  try {
    const configFile = join(gui, "renderer/vite.mobile.config.ts");
    const cacheDir = join(output, "vite-cache");
    cleanup.push(() => rm(cacheDir, { recursive: true, force: true }));
    const server = await createServer({
      configFile,
      cacheDir,
      server: {
        port: 0,
        strictPort: false,
        https: {
          key: await readFile(join(process.env.AREAL_IOS_TLS_HOME, "server.key")),
          cert: await readFile(join(process.env.AREAL_IOS_TLS_HOME, "server.pem")),
        },
      },
    });
    cleanup.push(() => server.close());
    await server.listen();
    const origin = server.resolvedUrls.local[0].replace(/\/$/, "");
    const relay = await relayFixture(fixture, {
      tlsHome: process.env.AREAL_IOS_TLS_HOME,
      relayOptions: { allowedClientOrigins: [origin] },
    });
    const host = await hostFixture(fixture);
    await host.remote.control({
      operation: "enable",
      relay: relay.origin,
      code: relay.admin("enrollment").code,
      confirmed: true,
    });
    await waitFor(() => host.remote.state().connected);
    for (const [name, engine] of [
      ["chromium", chromium],
      ["webkit", webkit],
    ]) {
      const before = Date.now();
      const browser = await engine.launch({ headless: true });
      try {
        const context = await browser.newContext({
          ...devices["iPhone 13"],
          defaultBrowserType: undefined,
          locale: "en-US",
          ignoreHTTPSErrors: true,
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => {
          errors.push(error.name);
          console.error(`${name}: ${error.message}`);
        });
        const capture = async (scene) => {
          const path = join(output, `${name}-${scene}.png`);
          await page.screenshot({ path, fullPage: true });
          records.push({
            browser: name,
            scene,
            path,
            sha256: createHash("sha256")
              .update(await readFile(path))
              .digest("hex"),
            viewport: page.viewportSize(),
            dpr: 3,
            theme: await page.evaluate(() =>
              matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
            ),
          });
        };
        await page.goto(origin);
        await page.locator('[data-state="unpaired"]').waitFor();
        assert.equal(await page.evaluate(() => isSecureContext && !!crypto.subtle), true);
        await capture("unpaired");
        await page.locator('[data-action="paste"]').click();
        await page.locator('[data-field="pairing-link"]').fill("invalid");
        await page.locator('[data-action="pair"]').click();
        await page.locator('[data-state="unpaired"]').waitFor();
        assert.ok(
          (await page.getByText("Invalid", { exact: false }).count()) ||
            (await page.locator('[role="alert"]').count()),
        );
        const invitation = await host.remote.control({ operation: "pair", transport: "relay" });
        await page.locator('[data-action="paste"]').click();
        await page.locator('[data-field="pairing-link"]').fill(invitation.payload);
        await page.locator('[data-action="pair"]').click();
        await page.locator('[data-state="pairing"]').waitFor();
        await capture("waiting");
        const peer = await page.locator('[data-field="fingerprint"]').textContent();
        await host.remote.control({
          operation: "approve",
          id: peer,
          projects: ["project"],
          preset: "Observer",
        });
        await page.locator('[data-state="connected"]').waitFor();
        await capture("connected");
        // 走实际 Vite 文件更新事件，验证脚本热更会重载并丢弃浏览器内存身份。
        const navigation = page.waitForEvent("framenavigated", {
          predicate: (frame) => frame === page.mainFrame(),
        });
        server.watcher.emit("change", join(gui, "renderer/src/mobile/MobileApp.tsx"));
        await navigation;
        await page.locator('[data-state="unpaired"]').waitFor();
        assert.deepEqual(errors, []);
        await page.emulateMedia({ colorScheme: "dark" });
        await capture("dark");
        records.push({
          browser: name,
          version: browser.version(),
          result: "passed",
          elapsedMs: Date.now() - before,
        });
      } catch (error) {
        for (const context of browser.contexts())
          for (const page of context.pages())
            await page
              .screenshot({ path: join(output, `${name}-failure.png`), fullPage: true })
              .catch(() => {});
        throw error;
      } finally {
        await browser.close();
      }
    }
    await server.close();
    const buildLog = execFileSync("pnpm", ["--dir", "clients/gui", "mobile:build"], {
      cwd: root,
      env: { ...process.env, NODE_ENV: "production" },
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    await writeFile(join(output, "build.log"), buildLog);
    const html = await readFile(join(gui, "dist/mobile/index.html"), "utf8");
    const assets = join(gui, "dist/mobile/assets");
    const js = (
      await Promise.all(
        (await readdir(assets))
          .filter((file) => file.endsWith(".js"))
          .map((file) => readFile(join(assets, file), "utf8")),
      )
    ).join("\n");
    assert.ok(!html.includes("unsafe-inline") && !html.includes("ws:"));
    assert.ok(!js.includes("Browser development"));
    report.result = "passed";
  } catch (error) {
    report.result = "failed";
    report.error = error.stack;
    process.exitCode = 1;
  } finally {
    report.elapsedMs = Date.now() - started;
    report.cleanupErrors = [];
    for (const action of cleanup.reverse()) {
      await Promise.resolve()
        .then(action)
        .catch((error) => report.cleanupErrors.push(error.name));
    }
    if (report.cleanupErrors.length) process.exitCode = 1;
    await writeFile(join(output, "result.json"), JSON.stringify(report, null, 2));
    console.log(`${report.result}: ${output}`);
    if (report.error) console.error(report.error);
  }
}
