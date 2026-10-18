// 真实发行布局和原生 Runtime：源码定位、搬迁后默认定位、显式覆盖均需产出可读取的制品。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rename, cp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnNative } from "../../scripts/native-child.mjs";
import { connect } from "./client.mjs";
import { fixture } from "./fixture.mjs";

const root = await mkdtemp("/tmp/areal-package-workgroup-");
const bundle = join(root, "relocated bundle"),
  override = join(root, "explicit helpers");
const model = await fixture(),
  evidence = [];
let child,
  c,
  logs = "";
async function stop() {
  await c?.close();
  c = null;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    const [code] = await exited;
    clearTimeout(timer);
    assert.equal(code, 0, logs);
  }
}
try {
  execFileSync(
    "python3",
    ["scripts/package.py", "--profile", "debug", "--output", join(root, "original")],
    { stdio: "pipe" },
  );
  await rename(join(root, "original"), bundle);
  const manifest = JSON.parse(await readFile(join(bundle, "manifest.json"), "utf8"));
  await cp(join(bundle, "libexec/areal"), override, { recursive: true });
  const policy = join(root, "policy.json"),
    config = join(root, "config.toml");
  await writeFile(config, "schema_version=1\n");
  await writeFile(
    policy,
    JSON.stringify({
      allowedDirectories: ["game"],
      checks: [["/bin/sh", "-c", "test -s game/PRD.md"]],
      workers: 1,
      verifiers: 1,
      activeGroups: 1,
      timeoutSeconds: 30,
      commandTimeoutMs: 5000,
      maxModelRequests: 8,
    }),
  );
  for (const mode of ["source", "packaged", "explicit"]) {
    const workspace = join(root, `${mode}-workspace`),
      data = join(root, `${mode}-state`),
      ready = join(root, `${mode}-ready.json`);
    await mkdir(workspace);
    logs = "";
    const args = [
      "--workspace",
      workspace,
      "--data-dir",
      data,
      "--config",
      config,
      "--ready-metadata-file",
      ready,
      "--allow-write",
      "--workgroup-policy",
      policy,
      "--model",
      "fixture",
      "--model-endpoint",
      model.endpoint,
    ];
    const options = {
      cwd: workspace,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: root,
        AREAL_HARNESS_HOME: root,
        NO_PROXY: "127.0.0.1,localhost",
        OTEL_SDK_DISABLED: "true",
      },
      stdio: ["ignore", "ignore", "pipe"],
    };
    if (mode === "source") {
      child = spawn(
        "/usr/bin/python3",
        [
          "-I",
          "-S",
          resolve("scripts/launch.py"),
          "--bin-dir",
          resolve("target/debug"),
          "--desktop",
          ...args,
        ],
        options,
      );
    } else if (mode === "packaged") {
      child = spawnNative(join(bundle, "bin/areal"), ["serve", "--desktop", ...args], options);
    } else {
      // 默认位置不可用时仍成功，才证明实际使用了显式路径。
      for (const name of ["areal-runtime", "areal-runtime-fs"])
        await rename(
          join(bundle, "libexec/areal", name),
          join(bundle, "libexec/areal", `${name}.unused`),
        );
      child = spawnNative(
        join(bundle, "bin/areal"),
        [
          "app-server",
          "--listen",
          "127.0.0.1:0",
          "--runtime",
          join(override, "areal-runtime"),
          "--file-helper",
          join(override, "areal-runtime-fs"),
          ...args,
        ],
        options,
      );
    }
    child.stderr.on("data", (b) => {
      logs = (logs + b).slice(-32768);
    });
    let metadata;
    const deadline = Date.now() + 30000;
    while (!metadata) {
      assert(child.exitCode === null && child.signalCode === null && Date.now() < deadline, logs);
      metadata = JSON.parse(await readFile(ready, "utf8").catch(() => "null"));
      if (!metadata) await new Promise((r) => setTimeout(r, 25));
    }
    c = await connect(metadata.endpoint, metadata.authFile);
    const started = await c.call("areal/workgroup/start", {
      requestId: crypto.randomUUID(),
      plan: {
        objective: "Verify packaged worker execution",
        tasks: [{ id: "design", instruction: "PGC_STAGE:design", writes: ["game/PRD.md"] }],
      },
    });
    let state = started;
    const until = Date.now() + 40000;
    while (state.record.status === "running" && Date.now() < until)
      state = await c.call("areal/workgroup/wait", {
        id: started.id,
        afterRevision: state.record.revision,
        timeoutMs: 1000,
      });
    assert.equal(state.record.status, "completed", JSON.stringify(state));
    assert.equal(state.record.cleanupConfirmed, true);
    const artifact = await c.call("areal/workgroup/artifact", {
      id: started.id,
      path: "game/PRD.md",
    });
    assert.equal(
      Buffer.from(artifact.dataBase64, "base64").toString(),
      "Click counter specification",
    );
    assert.equal((await c.call("areal/server/status")).restartSafe, true);
    evidence.push({ mode, artifactSha256: artifact.sha256, cleanupConfirmed: true });
    await stop();
  }
  assert.deepEqual(model.failures, []);
  console.log(
    JSON.stringify({
      status: "passed",
      sourceRevision: manifest.sourceRevision,
      workingTree: manifest.workingTree,
      platform: manifest.platform,
      model: "local-fixture",
      binarySha256: manifest.files["bin/areal"],
      evidence,
    }),
  );
} finally {
  await stop();
  await model.close();
  await rm(root, { recursive: true, force: true });
}
