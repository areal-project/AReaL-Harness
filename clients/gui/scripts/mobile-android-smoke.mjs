import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, readFile, writeFile, copyFile, rm, access } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  certificates,
  relayFixture,
  hostFixture,
  waitFor as fixtureWaitFor,
} from "./remote-relay-fixture.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = resolve(process.env.AREAL_MOBILE_EVIDENCE ?? join(root, ".scratch/android/product"));
const serial = process.env.AREAL_ANDROID_SERIAL;
assert.ok(serial?.startsWith("emulator-"), "AREAL_ANDROID_SERIAL must select an isolated emulator");
const adbPath = process.env.AREAL_ANDROID_ADB ?? "adb";
const exec = promisify(execFile);
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => abort.abort(new Error(`Interrupted${signal}`)));
const waitFor = (read, timeout) =>
  fixtureWaitFor(() => {
    abort.signal.throwIfAborted();
    return read();
  }, timeout);
const waitChild = async (child) => {
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    if (abort.signal.aborted) terminate();
    return await new Promise((done, fail) => {
      child.once("error", fail);
      child.once("exit", (code) => done(code ?? 1));
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
};
const run = async (command, args, options = {}) => {
  let child;
  const result = new Promise((done, fail) => {
    child = execFile(
      command,
      args,
      { cwd: root, maxBuffer: 32 * 1024 * 1024, signal: abort.signal, ...options },
      (error, stdout) => (error ? fail(error) : done(stdout)),
    );
  });
  const closed = new Promise((done) => child.once("close", done));
  try {
    return (await result).trim();
  } finally {
    await closed;
  }
};
const adb = (...args) => run(adbPath, ["-s", serial, ...args]);
const bundle = "com.example.arealharness.debug";
const activity = `${bundle}/com.example.arealharness.DebugActivity`;
await mkdir(output, { recursive: true });
const requiresCore = ["workspace", "commands"].includes(process.env.AREAL_MOBILE_SCENARIO);
if (requiresCore && process.env.AREAL_ANDROID_SLOT_LOCKED !== "1") {
  assert.ok(
    isAbsolute(process.env.AREAL_CORE_BIN ?? ""),
    "Set AREAL_CORE_BIN to an absolute deployed verification slot path",
  );
  assert.ok(
    isAbsolute(process.env.AREAL_RUNTIME_BIN ?? ""),
    "Set AREAL_RUNTIME_BIN to the same deployed verification slot",
  );
  const child = spawn(
    "python3",
    [
      "-c",
      `
import json, os, signal, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / "scripts"))
from verification import slot_lock, check_files, digest, RECEIPT
core = Path(sys.argv[2]).resolve()
runtime = Path(os.environ["AREAL_RUNTIME_BIN"]).resolve()
if core.parent != runtime.parent:
    raise ValueError("Core and Runtime must use the same verification slot")
child = None
pending = []
def forward(value, frame):
    if child is None:
        pending.append(value)
    elif child.poll() is None:
        child.send_signal(value)
for sig in (signal.SIGINT, signal.SIGTERM):
    signal.signal(sig, forward)
with slot_lock(core.parent):
    receipt = json.loads((core.parent / RECEIPT).read_text())
    check_files(core.parent, receipt)
    if digest(core) != receipt["files"]["areal"] or digest(runtime) != receipt["files"]["areal-runtime"]:
        raise ValueError("Core or Runtime differs from the deployment receipt")
    if pending:
        raise SystemExit(128 + pending[0])
    child = subprocess.Popen(sys.argv[3:], env=dict(os.environ, AREAL_ANDROID_SLOT_LOCKED="1"))
    for value in pending:
        forward(value, None)
    raise SystemExit(child.wait())
`,
      root,
      process.env.AREAL_CORE_BIN,
      process.execPath,
      fileURLToPath(import.meta.url),
    ],
    { cwd: root, stdio: "inherit", env: process.env },
  );
  process.exitCode = await waitChild(child);
} else if (!process.env.AREAL_ANDROID_TLS_HOME) {
  const tlsHome = await certificates();
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        AREAL_ANDROID_TLS_HOME: tlsHome,
        NODE_EXTRA_CA_CERTS: join(tlsHome, "ca.pem"),
      },
    });
    process.exitCode = await waitChild(child);
  } finally {
    await rm(tlsHome, { recursive: true, force: true });
  }
} else {
  const cleanup = [];
  const fixture = { after: (fn) => cleanup.push(fn) };
  const records = [];
  let stage = "build";
  let relayPort;
  let pairingLink;
  const configPath = join(
    root,
    "clients/mobile/android/app/src/debug/res/xml/network_security_config.xml",
  );
  const caPath = join(root, "clients/mobile/android/app/src/debug/res/raw/areal_gate_ca.pem");
  const original = await readFile(configPath, "utf8");
  try {
    await mkdir(join(root, "clients/mobile/android/app/src/debug/res/raw"), { recursive: true });
    await copyFile(join(process.env.AREAL_ANDROID_TLS_HOME, "ca.pem"), caPath);
    await writeFile(
      configPath,
      original.replace(
        '<certificates src="user" />',
        '<certificates src="user" /><certificates src="@raw/areal_gate_ca" />',
      ),
    );
    await run("pnpm", ["--dir", "clients/gui", "mobile:android:build"]);
    await adb("install", "-r", "clients/mobile/android/app/build/outputs/apk/debug/app-debug.apk");
    assert.equal(
      await adb("shell", "pm", "clear", bundle),
      "Success",
      "Reset the isolated debug app before initial pairing",
    );
    await writeFile(
      join(output, "environment.json"),
      JSON.stringify(
        {
          serial,
          source: await run("git", ["rev-parse", "HEAD"]),
          dirtyPaths: (await run("git", ["status", "--porcelain"])).split("\n").filter(Boolean),
          diffStat: await run("git", ["diff", "--stat"]),
          apkSha256: createHash("sha256")
            .update(
              await readFile(
                join(root, "clients/mobile/android/app/build/outputs/apk/debug/app-debug.apk"),
              ),
            )
            .digest("hex"),
          ...(requiresCore
            ? {
                coreBinary: {
                  path: process.env.AREAL_CORE_BIN,
                  sha256: createHash("sha256")
                    .update(await readFile(process.env.AREAL_CORE_BIN))
                    .digest("hex"),
                },
                runtimeBinary: {
                  path: process.env.AREAL_RUNTIME_BIN,
                  sha256: createHash("sha256")
                    .update(await readFile(process.env.AREAL_RUNTIME_BIN))
                    .digest("hex"),
                },
              }
            : {}),
          node: process.version,
          relayNode: process.env.AREAL_RELAY_NODE ?? process.execPath,
          android: await adb("shell", "getprop", "ro.build.version.release"),
          webview: await adb("shell", "dumpsys", "webviewupdate"),
        },
        null,
        2,
      ),
    );
    stage = "fixtures";
    const relay = await relayFixture(fixture, {
      tlsHome: process.env.AREAL_ANDROID_TLS_HOME,
      relayOptions: { allowedClientOrigins: ["https://localhost"] },
    });
    relayPort = new URL(relay.origin).port;
    await adb("reverse", `tcp:${relayPort}`, `tcp:${relayPort}`);
    const scenario = process.env.AREAL_MOBILE_SCENARIO ?? "pairing";
    const commands = scenario === "commands";
    const workspace = scenario === "workspace";
    abort.signal.throwIfAborted();
    const host =
      commands || workspace
        ? await (await import("./mobile-core-fixture.mjs")).mobileCoreFixture(fixture, { commands })
        : await hostFixture(fixture);
    abort.signal.throwIfAborted();
    await host.remote.control({
      operation: "enable",
      relay: relay.origin,
      code: relay.admin("enrollment").code,
      confirmed: true,
    });
    await waitFor(() => host.remote.state().connected);
    const invitation = await host.remote.control({ operation: "pair", transport: "relay" });
    pairingLink = invitation.payload;
    const cases = commands
      ? ["pair", "new", "models", "send", "permissions", "queue", "stop", "unknown", "recover"]
      : workspace
        ? ["pair", "projects", "sessions", "baseline", "history", "live", "release"]
        : ["pair", "restore", "lifecycle", "revoked", "clear", "unpaired"];
    let pairedPeer;
    const readEvent = async (kind) => {
      try {
        return JSON.parse(
          await adb("shell", "run-as", bundle, "cat", `files/product-${kind}.json`),
        );
      } catch {
        return null;
      }
    };
    for (const name of cases) {
      stage = `product-${name}`;
      for (const kind of ["pairing", "ready", "background", "result"])
        await adb("shell", "run-as", bundle, "rm", "-f", `files/product-${kind}.json`);
      const config = {
        mode: name,
        ...(name === "pair" ? { link: invitation.payload } : {}),
        ...(name !== "pair" && (commands || workspace)
          ? { projectId: host.projectIds[0], threadId: host.threadId }
          : {}),
      };
      if (name === "unknown") host.loseNext("areal/turn/start");
      await adb("shell", "am", "force-stop", bundle);
      const escapedConfig = "'" + JSON.stringify(config).replaceAll("'", "'\\''") + "'";
      await adb("shell", `am start -W -n ${activity} --es arealProduct ${escapedConfig}`);
      let approved = false;
      let transitioned = false;
      const result = await waitFor(async () => {
        const pairing = await readEvent("pairing");
        if (pairing && !approved) {
          assert.equal(host.remote.state().pending[0].clientKind, "android");
          await host.remote.control({
            operation: "approve",
            id: pairing.peer,
            projects: host.projectIds ?? ["project"],
            preset: commands ? "Operator" : "Observer",
          });
          approved = true;
        }
        const ready = await readEvent("ready");
        if (ready && !transitioned) {
          transitioned = true;
          if (name === "lifecycle") {
            await adb("shell", "input", "keyevent", "KEYCODE_HOME");
            await waitFor(() => readEvent("background"), 10000);
            await waitFor(() => host.remote.sessions.sockets.size === 0, 10000);
            await adb("shell", "am", "start", "-n", activity);
          }
          if (name === "revoked")
            await host.remote.control({ operation: "revoke", id: pairedPeer });
          if (name === "live") await host.send("MOBILE_LIVE_UPDATE");
          if (name === "queue") {
            const queue = await host.backend.projects
              .get(host.projectIds[0])
              .client.request("areal/queue/list", { threadId: host.threadId });
            assert.equal(
              queue.items.find((item) => item.id === ready.queueItemId)?.status,
              "pending",
            );
            host.release();
          }
        }
        return readEvent("result");
      }, 60000);
      const record = { case: name, ...result.result };
      records.push(record);
      await writeFile(join(output, "results.json"), JSON.stringify(records, null, 2));
      await exec(adbPath, ["-s", serial, "exec-out", "screencap", "-p"], {
        encoding: "buffer",
        maxBuffer: 32 * 1024 * 1024,
      }).then(({ stdout }) => writeFile(join(output, `${name}.png`), stdout));
      console.log(JSON.stringify(record));
      assert.equal(record.origin, "https://localhost");
      assert.equal(record.status, "success", `Android product failed in ${name}`);
      if (commands || workspace || ["pair", "restore", "lifecycle"].includes(name)) {
        assert.equal(record.state, "connected");
        assert.equal(record.remembered, "true");
        assert.equal(record.keychainPresent, true);
        assert.equal(record.identityPresent, true);
        if (name === "pair") pairedPeer = record.peer;
        else {
          assert.equal(record.peer, pairedPeer);
          assert.equal(approved, false);
        }
      } else if (name === "revoked") {
        assert.equal(record.state, "revoked");
        assert.equal(record.peer, pairedPeer);
      } else {
        assert.equal(record.state, "unpaired");
        assert.equal(record.keychainPresent, false);
      }
      if (name === "pair" && process.env.AREAL_ANDROID_HOLD === "1") {
        const hold = join(output, "hold.json");
        await writeFile(
          hold,
          JSON.stringify(
            {
              serial,
              activity,
              bundle,
              pid: process.pid,
              projectId: host.projectIds?.[0],
              threadId: host.threadId,
            },
            null,
            2,
          ),
        );
        const deadline = Date.now() + 600000;
        console.log(`Android UI hold active. Remove ${hold} to continue.`);
        while (
          Date.now() < deadline &&
          (await access(hold).then(
            () => true,
            () => false,
          ))
        )
          await delay(1000, undefined, { signal: abort.signal });
        await rm(hold, { force: true });
      }
      if (
        commands &&
        ["send", "permissions", "queue", "stop", "unknown", "recover"].includes(name)
      ) {
        if (name === "send") host.threadId = record.threadId;
        assert.equal(record.threadId, host.threadId);
        const { thread } = await host.backend.projects
          .get(host.projectIds[0])
          .client.request("thread/read", { threadId: host.threadId, includeTurns: true });
        assert.equal(
          thread.turns.length,
          { send: 1, permissions: 1, queue: 3, stop: 4, unknown: 5, recover: 5 }[name],
        );
        assert.equal(thread.desktop.configuration.model.modelId, "fixture-alt");
        assert.equal(thread.desktop.configuration.parameters.reasoningEffort, "high");
        if (name === "stop") assert.equal(thread.turns.at(-1).status, "interrupted");
        if (name === "unknown") assert.equal(record.locators, 1);
        if (name === "recover") assert.equal(record.locators, 0);
      }
      if (workspace && name !== "pair") assert.equal(record.projects, 2);
      if (["history", "live"].includes(name)) assert.equal(record.history, true);
      if (name === "history") assert.equal(record.historyAutoload, true);
      if (name === "live") assert.equal(record.live, true);
      if (name === "release")
        await waitFor(() => host.remote.sessions.observers.viewers.size === 0);
      assert.equal(host.remote.state().pending.length, 0);
    }
  } catch (error) {
    await writeFile(
      join(output, "failure.json"),
      JSON.stringify(
        {
          stage,
          error: pairingLink ? error.message.replaceAll(pairingLink, "[redacted]") : error.message,
        },
        null,
        2,
      ),
    );
    await adb("logcat", "-d", "-t", "500")
      .then((log) => writeFile(join(output, "logcat.txt"), log))
      .catch(() => {});
    throw new Error(
      `Android product gate failed during ${stage}; see ${join(output, "failure.json")}`,
    );
  } finally {
    await rm(join(output, "hold.json"), { force: true });
    await writeFile(configPath, original);
    await rm(caPath, { force: true });
    const cleanupResults = [];
    for (const [name, close] of [
      [
        "app",
        () =>
          run(adbPath, ["-s", serial, "shell", "am", "force-stop", bundle], { signal: undefined }),
      ],
      ...(relayPort
        ? [
            [
              "reverse",
              () =>
                run(adbPath, ["-s", serial, "reverse", "--remove", `tcp:${relayPort}`], {
                  signal: undefined,
                }),
            ],
          ]
        : []),
      ...cleanup.reverse().map((close, index) => [`fixture-${index}`, close]),
    ]) {
      try {
        await close();
        cleanupResults.push({ name, closed: true });
      } catch {
        cleanupResults.push({ name, closed: false });
        process.exitCode = 1;
      }
    }
    await writeFile(join(output, "cleanup.json"), JSON.stringify(cleanupResults, null, 2));
  }
}
