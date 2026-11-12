import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execFile, spawnSync } from "node:child_process";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { withSmokeDeadline } from "./smoke-deadline.mjs";
const executeFile = promisify(execFile);
const require = createRequire(new URL("../app/package.json", import.meta.url));

export async function stopFixtureHost(binary, home, evidence) {
  const descriptor = await readFile(join(home, "host", "host.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (!descriptor) return null;
  const { HostClient } = require("@areal/client/node");
  const { readHostReceipt, readOfflineHostReceipt } = require("../app/src/core/host-lifecycle.cjs");
  const reference = {
    kind: "stopHost",
    requestId: randomUUID(),
    home,
    hostId: descriptor.hostId,
    generation: descriptor.generation,
    strategy: "cancel",
  };
  await writeFile(join(evidence, "host-stop-reference.json"), JSON.stringify(reference, null, 2));
  const host = new HostClient();
  try {
    let receipt;
    try {
      await host.connect(home);
      assert.equal(host.hostId, reference.hostId);
      assert.equal(host.generation, reference.generation);
      receipt = readHostReceipt(
        reference,
        await host.stop(reference.requestId, reference.generation, reference.strategy),
      );
    } catch {
      host.close();
      receipt = await readOfflineHostReceipt(binary, reference);
    }
    await writeFile(join(evidence, "host-stop.json"), JSON.stringify(receipt ?? null, null, 2));
    assert.equal(receipt?.state, "completed", "original fixture Host stop remains UNKNOWN");
    return receipt;
  } finally {
    host.close();
  }
}

export async function cleanupSyntheticHostKeychain(hostHome, isolatedRoot) {
  if (process.platform !== "darwin") return [];
  const root = await realpath(isolatedRoot);
  const home = await realpath(hostHome);
  const child = relative(root, home);
  assert.ok(
    child && !child.startsWith("..") && !isAbsolute(child),
    "Host home must be inside this fixture",
  );
  const service = `org.areal.host.v1.${createHash("sha256").update(home).digest("hex")}`;
  const entries = [];
  for (const directory of ["vault-operations", "remote-operations"]) {
    for (const name of await readdir(join(home, "host", directory)).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })) {
      const receipt = JSON.parse(await readFile(join(home, "host", directory, name), "utf8"));
      assert.equal(name, `${receipt.requestId}.json`);
      if (!["vault.replace", "remote.replace"].includes(receipt.method) || !receipt.entryId)
        continue;
      assert.match(receipt.entryId, /^[a-f0-9-]{36}$/);
      const removal = spawnSync(
        "/usr/bin/security",
        ["delete-generic-password", "-s", service, "-a", receipt.entryId],
        { stdio: "ignore" },
      );
      const absent = spawnSync(
        "/usr/bin/security",
        ["find-generic-password", "-s", service, "-a", receipt.entryId],
        { stdio: "ignore" },
      );
      entries.push({
        entryId: receipt.entryId,
        removal: removal.status,
        absent: absent.status === 44,
      });
      assert.equal(absent.status, 44, "original synthetic Keychain entry is absent");
    }
  }
  return entries;
}

export async function assertApplicationStopped(binary, env, metadata) {
  const alive = (pid) => {
    if (!Number.isSafeInteger(pid) || pid <= 1) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  const deadline = Date.now() + 30000;
  let records;
  do {
    // 使用产品的原生启动适配，同时让同进程中的模型 HTTP 夹具继续响应。
    const { stdout } = await executeFile(binary, ["service", "list", "--json"], {
      env,
      timeout: 20000,
    });
    records = JSON.parse(stdout);
    if (
      !alive(metadata?.pid) &&
      records.every(
        (record) => record.state === "stopped" && !alive(record.hostPid) && !alive(record.corePid),
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail("Application quit left a live isolated adapter or Core generation");
}

// A failed quit must not leave the test runner held open until the CI job timeout.
// Only the exact child returned by this fixture's Electron launch may be killed.
export async function closeSmokeApplication(application, timeoutMs = 20000) {
  const child = application.process();
  if (!child) throw new Error("Owned Electron process unavailable");
  let onExit;
  const exited = new Promise((resolve, reject) => {
    onExit = (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`Owned Electron process exit: code=${code} signal=${signal}`));
    };
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null)
      onExit(child.exitCode, child.signalCode);
  });
  try {
    await withSmokeDeadline(
      "Electron cleanup",
      () =>
        Promise.race([
          exited,
          Promise.resolve()
            .then(() => application.close())
            .then(() => exited),
        ]),
      timeoutMs,
    );
  } catch (error) {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await withSmokeDeadline("owned Electron process exit", () => exited, 5000);
    }
    throw error;
  } finally {
    child.removeListener("exit", onExit);
    // 子进程已退出时，后代继承的 stderr 写端仍可能让 Playwright 管道保持打开。
    if (child.exitCode !== null || child.signalCode !== null) child.stderr?.destroy();
  }
}

export async function closeRecordedSmokeApplication(
  application,
  timeoutMs = 20000,
  prepare = async () => {},
) {
  return closeSmokeApplication(
    {
      process: () => application.process(),
      close: async () => {
        await prepare();
        // Playwright 的 close 先结算录像才请求 app.quit；提前走同一产品退出流程，避免录像挤占退出期限。
        // 仍等待 close 结算录像和进程，不绕过草稿确认、生命周期检查或原有失败期限。
        await application.evaluate(({ app }) => {
          app.quit();
        });
        await application.close();
      },
    },
    timeoutMs,
  );
}
