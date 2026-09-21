// 实际发行目录、Core HTTP/WS、原生 Runtime；两次换 epoch 后检查历史和旧句柄。
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fixture, png } from "./fixture.mjs";
import { connect } from "./client.mjs";
const root = await mkdtemp(join(tmpdir(), "areal-package-soak-"));
const workspace = join(root, "workspace with spaces"),
  data = join(root, "state"),
  home = join(root, "home");
const source = join(root, "original"),
  bundle = join(root, "relocated bundle");
const model = await fixture();
const started = Date.now(),
  curve = [],
  epochs = new Set();
let child,
  c,
  logs = "",
  previous;
async function close() {
  await c?.close();
  c = null;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    const [code] = await exit;
    clearTimeout(timer);
    assert.equal(code, 0, logs);
  }
}
try {
  await mkdir(workspace);
  await mkdir(home);
  execFileSync(
    "python3",
    [
      "scripts/package.py",
      "--profile",
      process.env.AREAL_PACKAGE_PROFILE ?? "debug",
      "--output",
      source,
    ],
    { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"] },
  );
  await rename(source, bundle);
  assert.match(
    execFileSync(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-c",
        "import signal,subprocess,sys; p=subprocess.Popen(sys.argv[1:]); signal.signal(signal.SIGTERM,lambda s,f:p.send_signal(s)); signal.signal(signal.SIGINT,lambda s,f:p.send_signal(s)); r=p.wait(); sys.exit(r if r>=0 else 128-r)",
        join(bundle, "bin/areal"),
        "--version",
      ],
      { encoding: "utf8" },
    ),
    /^areal /,
  );
  const manifest = JSON.parse(await readFile(join(bundle, "manifest.json"), "utf8"));
  for (const [file, sha] of Object.entries(manifest.files))
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(bundle, file)))
        .digest("hex"),
      sha,
    );
  const config = join(root, "config.toml"),
    deployment = join(root, "deployment.json");
  await writeFile(config, "schema_version = 1\n");
  await writeFile(
    deployment,
    JSON.stringify({
      profiles: [
        {
          id: "terminal",
          revision: "v1",
          displayName: "Soak",
          instructions: "Use managed resources",
          allowThreadProcesses: true,
        },
      ],
    }),
  );
  for (let cycle = 0; cycle < 3; cycle++) {
    const ready = join(root, `ready-${cycle}.json`);
    logs = "";
    child = spawn(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-c",
        "import signal,subprocess,sys; p=subprocess.Popen(sys.argv[1:]); signal.signal(signal.SIGTERM,lambda s,f:p.send_signal(s)); signal.signal(signal.SIGINT,lambda s,f:p.send_signal(s)); r=p.wait(); sys.exit(r if r>=0 else 128-r)",
        join(bundle, "bin/areal"),
        "serve",
        "--desktop",
        "--workspace",
        workspace,
        "--data-dir",
        data,
        "--config",
        config,
        "--desktop-config",
        deployment,
        "--ready-metadata-file",
        ready,
        "--allow-write",
        "--allow-concurrent-writes",
        "--model-endpoint",
        model.endpoint,
        "--model",
        "fixture",
        ...(cycle === 0 ? ["--runtime-max-scopes", "4", "--runtime-max-operations", "32"] : []),
      ],
      {
        cwd: workspace,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: home,
          AREAL_HARNESS_HOME: home,
          NO_PROXY: "127.0.0.1,localhost",
          OTEL_SDK_DISABLED: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.resume();
    child.stderr.on("data", (b) => {
      logs = (logs + b).slice(-32768);
    });
    let metadata;
    const deadline = Date.now() + 30000;
    while (!metadata) {
      try {
        metadata = JSON.parse(await readFile(ready, "utf8"));
      } catch {
        if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline)
          throw Error(
            `package startup failed code=${child.exitCode} signal=${child.signalCode}: ${logs}`,
          );
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    c = await connect(metadata.endpoint, metadata.authFile);
    const initial = await c.call("areal/server/status");
    epochs.add(initial.runtime.runtimeEpoch);
    if (previous) {
      await assert.rejects(c.call("areal/process/get", previous.process), /STALE_HANDLE/);
      const history = await c.call("thread/read", {
        threadId: previous.threadId,
        includeTurns: true,
      });
      assert.equal(history.thread.turns.length, previous.turns);
      assert.equal(history.thread.desktop.archived, true);
    }
    const { thread } = await c.call("areal/thread/start", {
      requestId: crypto.randomUUID(),
      agentProfile: { id: "terminal", revision: "v1" },
    });
    let threadId = thread.id;
    let threadTurns = 0;
    const configuredRounds = Number(process.env.AREAL_SOAK_ROUNDS ?? 12);
    assert(
      Number.isInteger(configuredRounds) && configuredRounds >= 12 && configuredRounds <= 100,
      "AREAL_SOAK_ROUNDS must be 12..100 per normal epoch",
    );
    const rounds = cycle === 0 ? 3 : configuredRounds;
    let handle;
    for (let n = 0; n < rounds; n++) {
      if (n > 0 && n % 12 === 0) {
        await c.call("areal/thread/archive", { threadId });
        await c.call("areal/subscription/remove", { threadIds: [threadId] });
        const next = await c.call("areal/thread/start", {
          requestId: crypto.randomUUID(),
          agentProfile: { id: "terminal", revision: "v1" },
        });
        threadId = next.thread.id;
        threadTurns = 0;
      }
      const accepted = await c.call("areal/process/start", {
        threadId,
        requestId: crypto.randomUUID(),
        lifetime: "thread",
        argv: ["/bin/sh", "-c", "printf soak"],
        tty: false,
      });
      handle = accepted.id;
      const waited = await c.call("areal/process/wait", { threadId, id: handle, timeoutMs: 5000 });
      assert.equal(waited.runtime.exitCode, 0);
      await c.call("areal/thread/closeResources", { threadId });
      const receipt = await c.call("areal/turn/start", {
        threadId,
        requestId: crypto.randomUUID(),
        input: [{ type: "text", text: `soak-${cycle}-${n}` }],
      });
      const event = await c.waitEvent("turn/completed", (p) => p.turn.id === receipt.turn.id);
      assert.equal(event.turn.status, "completed");
      threadTurns++;
      const sample = await c.call("areal/server/status");
      const rss = Number(
        execFileSync("/bin/ps", ["-o", "rss=", "-p", String(metadata.pid)], {
          encoding: "utf8",
        }).trim(),
      );
      curve.push({
        cycle,
        round: n,
        rssKiB: rss,
        scopes: sample.runtime.scopes,
        operations: sample.runtime.operations,
        activeProcesses: sample.runtime.activeProcesses,
      });
      assert.equal(sample.runtime.activeProcesses, 0);
    }
    if (cycle === 0)
      await assert.rejects(
        c.call("areal/process/start", {
          threadId,
          requestId: crypto.randomUUID(),
          lifetime: "thread",
          argv: ["/bin/true"],
        }),
        /exhaust|capacity|scope/i,
      );
    const upload = async (bytes, mime) => {
      const response = await fetch(
        new URL(`/areal/blobs?threadId=${threadId}`, metadata.endpoint.replace("ws:", "http:")),
        {
          method: "POST",
          headers: { Authorization: `Bearer ${c.token}`, "Content-Type": mime },
          body: bytes,
        },
      );
      assert.equal(response.status, 201);
      return response.json();
    };
    const media = await upload(png, "image/png"),
      discard = await upload(Buffer.from(`unused-${cycle}`), "text/plain");
    const imageTurn = await c.call("areal/turn/start", {
      threadId,
      requestId: crypto.randomUUID(),
      input: [{ type: "image", url: media.uri }],
    });
    await c.waitEvent("turn/completed", (p) => p.turn.id === imageTurn.turn.id);
    await assert.rejects(c.call("areal/blob/release", { threadId, uri: media.uri }), /referenced/);
    await c.call("areal/blob/release", { threadId, uri: discard.uri });
    await c.call("areal/thread/archive", { threadId });
    const drained = await c.call("areal/server/drain", { strategy: "cancel", timeoutMs: 10000 });
    assert.equal(drained.restartSafe, true, JSON.stringify(drained));
    await assert.rejects(c.call("areal/thread/start", { requestId: crypto.randomUUID() }));
    const gc = await c.call("areal/server/gc");
    assert(gc.deletedBlobs >= 1);
    assert(gc.retainedBytes >= png.length);
    previous = { threadId, process: { threadId, id: handle }, turns: threadTurns + 1 };
    await close();
  }
  assert.equal(epochs.size, 3);
  assert.deepEqual(model.failures, []);
  const report = {
    exampleId: "EX-16",
    names: ["desktop-soak", "packaged-launch"],
    status: "passed",
    platform: process.platform + "/" + process.arch,
    rotations: 2,
    rounds: curve.length,
    durationMs: Date.now() - started,
    manifest,
    curve,
    cleanupConfirmed: true,
    external: { electron: "pending", developerIdSigning: "pending", notarization: "pending" },
  };
  if (process.env.AREAL_SOAK_REPORT)
    await writeFile(process.env.AREAL_SOAK_REPORT, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally {
  await close();
  await model.close();
  await rm(root, { recursive: true, force: true });
}
