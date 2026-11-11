import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { trackedMkdtemp } from "./support/host-cleanup.cjs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { stageMacOSService } from "./stage-macos-service.mjs";

const require = createRequire(import.meta.url);
const { desktopExecutables, serviceName } = require("../app/src/core/desktop-executables.cjs");
const { ServiceConnection } = require("../app/src/core/service-client.cjs");
const plist = (path) =>
  JSON.parse(
    execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" }),
  );

test("development and other platforms retain the supplied executable", () => {
  for (const options of [
    { packaged: false, platform: "darwin" },
    { packaged: true, platform: "linux" },
  ])
    assert.deepEqual(desktopExecutables({ ...options, executable: "/test/electron" }), {
      gui: "/test/electron",
      service: "/test/electron",
    });
});

test(
  "packaged macOS service has a separate identity and resolves shared resources to the same GUI",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const root = await trackedMkdtemp(join(tmpdir(), "areal-service-layout-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const app = join(root, "App with spaces.app"),
      contents = join(app, "Contents");
    for (const name of [
      "MacOS",
      "Resources",
      "Frameworks/Electron Framework.framework/Versions/A",
      "Frameworks/AReaL Harness GUI Helper.app/Contents",
    ])
      await mkdir(join(contents, name), { recursive: true });
    const info = {
      CFBundleIdentifier: "org.areal.fixture",
      CFBundleExecutable: "AReaL Harness GUI",
      CFBundleName: "AReaL Harness GUI",
      CFBundleVersion: "1",
      CFBundleShortVersionString: "1.0",
      ElectronAsarIntegrity: { "Resources/app.asar": { algorithm: "SHA256", hash: "fixture" } },
    };
    await writeFile(join(contents, "Info.plist"), JSON.stringify(info));
    await writeFile(join(contents, "MacOS", info.CFBundleExecutable), "fixture executable");
    await writeFile(join(contents, "Resources", "preserved"), "shared resource");
    await writeFile(
      join(contents, "Frameworks/Electron Framework.framework/Versions/A/preserved"),
      "framework resource",
    );
    await symlink("A", join(contents, "Frameworks/Electron Framework.framework/Versions/Current"));
    await writeFile(
      join(contents, "Frameworks/AReaL Harness GUI Helper.app/Contents/Info.plist"),
      JSON.stringify({ CFBundleIdentifier: "org.areal.fixture.helper" }),
    );
    const built = await stageMacOSService(app);
    const serviceContents = dirname(dirname(built.executable));
    const identity = plist(join(serviceContents, "Info.plist"));
    assert.notEqual(
      identity.CFBundleIdentifier,
      info.CFBundleIdentifier,
      "Finder must not mistake the surviving background for the foreground application",
    );
    assert.equal(identity.LSBackgroundOnly, true);
    assert.deepEqual(
      identity.ElectronAsarIntegrity,
      info.ElectronAsarIntegrity,
      "the background entry must retain the main package's shared-code integrity binding",
    );
    assert.equal(
      identity.CFBundleName,
      info.CFBundleName,
      "secure storage retains its application name",
    );
    assert.equal(
      plist(join(serviceContents, "Frameworks/AReaL Harness GUI Helper.app/Contents/Info.plist"))
        .CFBundleIdentifier,
      "org.areal.fixture.service.helper",
    );
    const mainPaths = desktopExecutables({
      packaged: true,
      platform: "darwin",
      resourcesPath: join(contents, "Resources"),
    });
    const servicePaths = desktopExecutables({
      packaged: true,
      platform: "darwin",
      executable: built.executable,
      resourcesPath: join(serviceContents, "Resources"),
    });
    assert.deepEqual(
      servicePaths,
      mainPaths,
      "notification launch from the service resolves back to the GUI, never recursively launches another service",
    );
    assert.equal(mainPaths.service, await realpath(built.executable));
    assert.equal(
      await realpath(
        join(serviceContents, "Frameworks/Electron Framework.framework/Versions/Current"),
      ),
      join(await realpath(serviceContents), "Frameworks/Electron Framework.framework/Versions/A"),
      "framework aliases must stay inside the background bundle after copying and relocation",
    );
    assert.equal(
      await realpath(join(serviceContents, "Resources")),
      await realpath(join(contents, "Resources")),
    );
    assert.equal(
      await readFile(join(serviceContents, "Resources", "preserved"), "utf8"),
      "shared resource",
    );
  },
);

const candidate = process.env.AREAL_GUI_EXECUTABLE;
test(
  "packaged background requires its application owner and exits when the owner pipe closes",
  {
    skip: process.platform !== "darwin" || !candidate,
    timeout: 45000,
  },
  async (t) => {
    const root = await trackedMkdtemp(join(tmpdir(), "areal-service-native-"));
    const userData = join(root, "user-data"),
      user = join(root, "user");
    await mkdir(user);
    await mkdir(userData);
    const owner = { kind: "gui", appRunId: randomUUID(), profile: await realpath(userData) };
    const contents = dirname(dirname(candidate));
    const paths = desktopExecutables({
      packaged: true,
      resourcesPath: join(contents, "Resources"),
    });
    assert.equal(paths.gui, await realpath(candidate));
    const env = {
      ...process.env,
      AREAL_GUI_USER_DATA: userData,
      AREAL_GUI_OWNER: JSON.stringify(owner),
      AREAL_GUI_DESKTOP_LIFETIME_FD: "3",
      AREAL_CORE_HOME: join(root, "core"),
      AREAL_CORE_USER_HOME: user,
      AREAL_HARNESS_HOME: join(user, ".areal"),
      AREAL_HARNESS_SERVICE_HOME: join(root, "registry"),
    };
    for (const name of [
      "ELECTRON_RUN_AS_NODE",
      "AREAL_CORE_CONFIG",
      "AREAL_HARNESS_CONFIG",
      "AREAL_CORE_BIN",
      "AREAL_CORE_DESKTOP_CONFIG",
    ])
      delete env[name];
    const log = createWriteStream(join(root, "service.log"));
    await once(log, "open");
    const child = spawn(paths.service, [], { env, stdio: ["ignore", log.fd, log.fd, "pipe"] });
    let exited = false;
    const exit = once(child, "exit").then((value) => {
      exited = true;
      return value;
    });
    const connection = new ServiceConnection();
    const waitExit = async (timeout) => {
      let timer;
      try {
        return await Promise.race([
          exit,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), timeout);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    t.after(async () => {
      connection.close();
      try {
        child.stdio[3].destroy();
        if (!exited) child.kill("SIGTERM");
        // 只清理本测试直接启动的空配置后台；启动失败也不能无限等待退出。
        if (!(await waitExit(3000))) child.kill("SIGKILL");
        assert.ok(await waitExit(3000), "isolated background did not exit after bounded cleanup");
      } finally {
        log.end();
      }
    });
    let metadata;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !exited) {
      try {
        metadata = JSON.parse(await readFile(join(root, "core/service.json"), "utf8"));
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(metadata, `background did not start; inspect ${root}`);
    assert.equal(metadata.pid, child.pid);
    assert.deepEqual(metadata.applicationOwner, owner);
    await connection.connect(metadata);
    await connection.request("hello", { protocol: metadata.protocol, identity: metadata.identity });
    const { snapshot } = await connection.request("snapshot");
    assert.deepEqual(
      snapshot.projects,
      [],
      "an empty isolated profile must not load user projects or submit work",
    );
    // 不能在元数据刚落盘时就停止：GPU/网络子进程路径错误会在反复拉起后才终止后台。
    await new Promise((resolve) => setTimeout(resolve, 8000));
    assert.equal(exited, false, `background exited while idle; inspect ${root}`);
    await connection.request("snapshot");
    child.stdio[3].end();
    assert.deepEqual(await exit, [1, null], "owner loss is an interrupted application lifetime");
    console.log(
      JSON.stringify({ nativeServicePassed: true, root, serviceName, pid: metadata.pid }),
    );
  },
);
