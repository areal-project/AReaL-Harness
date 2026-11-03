const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { mkdtemp, mkdir, readFile, writeFile } = require("node:fs/promises");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { crc32 } = require("node:zlib");
const gui = resolve(__dirname, "..");
const appRequire = createRequire(join(gui, "app/package.json"));
const { _electron } = appRequire("playwright-core");
const electron = appRequire("electron");

(async () => {
  const scratch = await mkdtemp(join(tmpdir(), "areal-bug-electron-"));
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
  Object.assign(env, {
    AREAL_GUI_USER_DATA: join(scratch, "profile"),
    AREAL_CORE_HOME: join(scratch, "core"),
    AREAL_CORE_USER_HOME: join(scratch, "user"),
    AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
    AREAL_CORE_CONFIG: join(scratch, "config.toml"),
    AREAL_CORE_BIN: join(scratch, "missing-core"),
    HOME: join(scratch, "user"),
    XDG_CONFIG_HOME: join(scratch, "config"),
    XDG_DATA_HOME: join(scratch, "data"),
  });
  await mkdir(env.AREAL_CORE_HOME, { recursive: true });
  await mkdir(env.AREAL_CORE_USER_HOME, { recursive: true });
  await writeFile(env.AREAL_CORE_CONFIG, "schema_version=1\n");
  const manifest = {
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: gui, encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--short"], { cwd: gui, encoding: "utf8" }).trim(),
    scope: "isolated Electron Main IPC; missing Core; injected native save picker",
    checks: [],
    cleanup: "pending",
    passed: false,
  };
  let app;
  try {
    app = await _electron.launch({
      executablePath: electron,
      args: [join(gui, "app")],
      env,
      timeout: 30000,
    });
    manifest.mainPid = app.process().pid;
    const page = await app.firstWindow({ timeout: 30000 });
    await page.waitForFunction(() => !!window.arealDesktop, { timeout: 30000 });
    const id = randomUUID();
    const data = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 8;
      canvas.height = 8;
      canvas.getContext("2d").fillRect(0, 0, 8, 8);
      return canvas.toDataURL("image/png");
    });
    const sentinel = "PRIVATE_PNG_METADATA_SENTINEL";
    const original = Buffer.from(data.split(",")[1], "base64");
    const content = Buffer.from(`Comment\0${sentinel}`);
    const typeAndContent = Buffer.concat([Buffer.from("tEXt"), content]);
    const chunk = Buffer.alloc(content.length + 12);
    chunk.writeUInt32BE(content.length, 0);
    typeAndContent.copy(chunk, 4);
    chunk.writeUInt32BE(crc32(typeAndContent), chunk.length - 4);
    const withMetadata = Buffer.concat([original.subarray(0, 33), chunk, original.subarray(33)]);
    assert.ok(withMetadata.includes(sentinel));
    const result = await page.evaluate(
      async ({ id, data }) => {
        const command = (params) => window.arealDesktop.command("bugReport", params);
        return {
          save: await command({
            operation: "save",
            id,
            description: "Electron IPC fixture",
            screenshots: [data],
          }),
          read: await command({ operation: "read", id }),
        };
      },
      { id, data: `data:image/png;base64,${withMetadata.toString("base64")}` },
    );
    assert.equal(result.save.ok, true, JSON.stringify(result.save));
    assert.equal(result.read.ok, true, JSON.stringify(result.read));
    assert.ok(result.read.value.report.screenshots[0].startsWith("data:image/png;base64,"));
    const normalized = Buffer.from(result.read.value.report.screenshots[0].split(",")[1], "base64");
    assert.equal(normalized.includes(sentinel), false);
    assert.equal(normalized.readUInt32BE(16), 8);
    assert.equal(normalized.readUInt32BE(20), 8);
    manifest.checks.push("Main nativeImage removes PNG metadata and preserves dimensions");
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true });
    });
    const canceled = await page.evaluate(
      (id) => window.arealDesktop.command("bugReport", { operation: "export", id }),
      id,
    );
    assert.equal(canceled.value.canceled, true);
    manifest.checks.push("cancel native picker");
    const dest = join(scratch, "export.json");
    await app.evaluate(({ dialog }, dest) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: dest });
    }, dest);
    const exported = await page.evaluate(
      (id) => window.arealDesktop.command("bugReport", { operation: "export", id }),
      id,
    );
    assert.equal(exported.ok, true, JSON.stringify(exported));
    assert.equal(exported.value.path, dest);
    const archive = JSON.parse(await readFile(dest, "utf8"));
    assert.equal(archive.id, id);
    assert.equal(archive.screenshots[0], result.read.value.report.screenshots[0]);
    assert.equal(Buffer.from(archive.screenshots[0].split(",")[1], "base64").readUInt32BE(16), 8);
    manifest.checks.push("export PNG via Main IPC and actual filesystem");
    manifest.passed = true;
  } catch (error) {
    manifest.error = String(error.stack || error);
    throw error;
  } finally {
    if (app) {
      const handle = app.process();
      await Promise.race([
        app.evaluate(({ app }) => app.exit(0)).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
      await new Promise((resolve) => {
        if (handle.exitCode !== null || handle.signalCode !== null) return resolve();
        const timer = setTimeout(() => handle.kill("SIGKILL"), 5000);
        handle.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      manifest.cleanup = `Main exited: ${handle.exitCode ?? handle.signalCode}`;
    } else manifest.cleanup = "Main not launched";
    await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log("Electron evidence:", scratch, JSON.stringify(manifest));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
