import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { certificates, relayFixture, hostFixture, waitFor } from "./remote-relay-fixture.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = resolve(
  process.env.AREAL_MOBILE_EVIDENCE ?? join(root, ".scratch/ios-remote-v1/mobile-pairing"),
);
const commandScenario = process.env.AREAL_MOBILE_SCENARIO === "commands";
const workspaceScenario = process.env.AREAL_MOBILE_SCENARIO === "workspace";
const runtime = process.env.AREAL_IOS_RUNTIME ?? "17.5";
const bundleId = process.env.AREAL_MOBILE_BUNDLE_ID ?? "com.example.arealharness";
const run = async (command, args, options = {}) =>
  (await exec(command, args, { cwd: root, maxBuffer: 32 * 1024 * 1024, ...options })).stdout.trim();
await mkdir(output, { recursive: true });

if (!process.env.AREAL_IOS_TLS_HOME) {
  const tlsHome = await certificates();
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        AREAL_IOS_TLS_HOME: tlsHome,
        NODE_EXTRA_CA_CERTS: join(tlsHome, "ca.pem"),
      },
    });
    process.exitCode = await new Promise((resolve) =>
      child.once("exit", (code) => resolve(code ?? 1)),
    );
  } finally {
    await rm(tlsHome, { recursive: true, force: true });
  }
} else {
  const cleanup = [];
  const fixture = {
    after: (fn) => cleanup.push(fn),
    diagnostic: (message) => console.log(JSON.stringify({ diagnostic: message })),
  };
  let simulator;
  let simulatorName;
  let host;
  let stage = "sync";
  const records = [];
  const cleaned = [];
  const sim = (...args) => run("xcrun", ["simctl", ...args]);
  try {
    await run("pnpm", ["--dir", "clients/gui", "mobile:sync"]);
    stage = "simulator";
    simulatorName = `AReaL mobile gate ${runtime} ${Date.now()}`;
    simulator = await sim(
      "create",
      simulatorName,
      "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro",
      `com.apple.CoreSimulator.SimRuntime.iOS-${runtime.replaceAll(".", "-")}`,
    );
    await sim("boot", simulator);
    await sim("bootstatus", simulator, "-b");
    await sim(
      "keychain",
      simulator,
      "add-root-cert",
      join(process.env.AREAL_IOS_TLS_HOME, "ca.pem"),
    );
    stage = "build";
    const derived = process.env.AREAL_MOBILE_DERIVED ?? join(output, `derived-${runtime}`);
    try {
      const build = await run("xcodebuild", [
        "-project",
        "clients/mobile/ios/App/App.xcodeproj",
        "-scheme",
        "App",
        "-configuration",
        "Debug",
        "-sdk",
        "iphonesimulator",
        "-destination",
        `id=${simulator}`,
        "-derivedDataPath",
        derived,
        "CODE_SIGNING_ALLOWED=YES",
        "CODE_SIGN_IDENTITY=-",
        `AREAL_MOBILE_BUNDLE_ID=${bundleId}`,
        "build",
      ]);
      await writeFile(join(output, `build-${runtime}.log`), build);
    } catch (error) {
      await writeFile(
        join(output, `build-${runtime}.log`),
        `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
      );
      throw new Error("SimulatorBuildFailed");
    }
    await sim("install", simulator, join(derived, "Build/Products/Debug-iphonesimulator/App.app"));
    const container = await sim("get_app_container", simulator, bundleId, "data");
    stage = "fixtures";
    const relay = await relayFixture(fixture, {
      tlsHome: process.env.AREAL_IOS_TLS_HOME,
      relayOptions: { allowedAppOrigins: ["capacitor://localhost"] },
    });
    host =
      workspaceScenario || commandScenario
        ? await (
            await import("./mobile-core-fixture.mjs")
          ).mobileCoreFixture(fixture, { commands: commandScenario })
        : await hostFixture(fixture);
    await host.remote.control({
      operation: "enable",
      relay: relay.origin,
      code: relay.admin("enrollment").code,
      confirmed: true,
    });
    await waitFor(async () => {
      if (workspaceScenario || commandScenario) await host.remote.refresh();
      return host.remote.state().connected;
    });
    const invitation = await host.remote.control({ operation: "pair", transport: "relay" });
    const cases = commandScenario
      ? ["pair", "new", "models", "send", "permissions", "queue", "stop", "unknown", "recover"]
      : workspaceScenario
        ? ["pair", "projects", "sessions", "baseline", "history", "live", "release"]
        : ["pair", "restore", "lifecycle", "revoked", "clear", "unpaired", "unpaired-dark"];
    let pairedPeer;
    let droppedSubmission;
    for (const name of cases) {
      const productConfig = {
        mode: name === "unpaired-dark" ? "unpaired" : name,
        ...(name === "pair" ? { link: invitation.payload } : {}),
        ...(name !== "pair" && (workspaceScenario || commandScenario)
          ? { projectId: host.projectIds[0], threadId: host.threadId }
          : {}),
      };
      for (const kind of ["pairing", "ready", "background", "result"])
        await rm(join(container, "Documents", `product-${kind}.json`), { force: true });
      stage = `probe-${name}`;
      if (name === "unpaired-dark") await sim("ui", simulator, "appearance", "dark");
      await run(
        "xcrun",
        [
          "simctl",
          "launch",
          "--terminate-running-process",
          `--stdout=${join(output, `${runtime}-${name}-stdout.log`)}`,
          `--stderr=${join(output, `${runtime}-${name}-stderr.log`)}`,
          simulator,
          bundleId,
        ],
        {
          env: { ...process.env, SIMCTL_CHILD_AREAL_MOBILE_PRODUCT: JSON.stringify(productConfig) },
        },
      );
      let approved = false;
      let transitioned = false;
      const result = await waitFor(async () => {
        const event = await readFile(join(container, "Documents/product-pairing.json"), "utf8")
          .then(JSON.parse)
          .catch(() => null);
        if (event && !approved) {
          await sim("io", simulator, "screenshot", join(output, `${runtime}-pair-waiting.png`));
          await host.remote.control({
            operation: "approve",
            id: event.peer,
            projects: host.projectIds ?? ["project"],
            preset: commandScenario ? "Operator" : "Observer",
          });
          approved = true;
        }
        const ready = await readFile(join(container, "Documents/product-ready.json"), "utf8")
          .then(JSON.parse)
          .catch(() => null);
        if (ready && !transitioned) {
          transitioned = true;
          if (name === "lifecycle") {
            await sim("launch", simulator, "com.apple.Preferences");
            await waitFor(
              () =>
                readFile(join(container, "Documents/product-background.json"), "utf8")
                  .then(JSON.parse)
                  .catch(() => null),
              10000,
            );
            await waitFor(() => host.remote.sessions.sockets.size === 0, 10000);
            await sim("launch", simulator, bundleId);
          }
          if (name === "queue") {
            const queue = await host.project.core.call("areal/queue/list", {
              threadId: host.threadId,
            });
            const item = queue.items.find((item) => item.id === ready.queueItemId);
            assert.equal(item?.status, "pending");
            assert.ok(item.input.some((part) => part.text === "MOBILE_QUEUED_AFTER_CURRENT"));
            host.release();
          }
          if (name === "live") {
            await host.send("MOBILE_LIVE_UPDATE");
          }
          if (name === "revoked")
            await host.remote.control({ operation: "revoke", id: pairedPeer });
        }
        return readFile(join(container, "Documents/product-result.json"), "utf8")
          .then(JSON.parse)
          .catch(() => null);
      }, 60000);
      const record = { runtime, case: name, ...result.result };
      records.push(record);
      await writeFile(
        join(output, `result-${runtime}.json`),
        JSON.stringify(records, null, 2) + "\n",
      );
      await sim("io", simulator, "screenshot", join(output, `${runtime}-${name}.png`));
      console.log(JSON.stringify(record));
      assert.equal(record.origin, "capacitor://localhost");
      assert.equal(record.status, "success", `Mobile product failed in ${name}`);
      if (workspaceScenario || commandScenario || ["pair", "restore", "lifecycle"].includes(name)) {
        assert.equal(record.state, "connected");
        assert.equal(record.remembered, "true");
        assert.equal(record.keychainPresent, true);
        assert.equal(record.identityPresent, true);
        assert.ok(Number.isSafeInteger(record.grantRevision));
        if (name === "pair") pairedPeer = record.peer;
        else {
          assert.equal(record.peer, pairedPeer);
          assert.equal(approved, false);
        }
      } else if (name === "revoked") {
        assert.equal(record.state, "revoked");
        assert.equal(record.keychainPresent, true);
        assert.equal(record.peer, pairedPeer);
        assert.equal(host.remote.sessions.sockets.size, 0);
      } else {
        assert.equal(record.state, "unpaired");
        assert.equal(record.keychainPresent, false);
      }
      if (commandScenario && name !== "pair") {
        assert.ok(
          Number.parseFloat(record.inputFontSize) >= 16,
          "Mobile editor must avoid focus zoom",
        );
        assert.equal(record.viewport.scale, 1);
        assert.ok(
          record.touchTargets.every((target) => target.width >= 44 && target.height >= 44),
          "Visible buttons must have 44pt targets",
        );
      }
      if (
        commandScenario &&
        ["send", "permissions", "queue", "stop", "unknown", "recover"].includes(name)
      ) {
        if (name === "send") host.threadId = record.threadId;
        assert.equal(record.threadId, host.threadId);
        const { thread } = await host.project.core.call("thread/read", {
          threadId: host.threadId,
          includeTurns: true,
        });
        const expected = { send: 1, permissions: 1, queue: 3, stop: 4, unknown: 5, recover: 5 }[
          name
        ];
        assert.equal(thread.turns.length, expected);
        assert.equal(thread.desktop.configuration.model.modelId, "fixture-alt");
        assert.equal(thread.desktop.configuration.parameters.reasoningEffort, "high");
        if (name === "permissions") {
          assert.equal(record.permissionSelection, true);
          assert.equal(thread.desktop.configuration.options.permissionPreset, "ask");
        }
        if (name === "queue") assert.ok(thread.turns.every((turn) => turn.status === "completed"));
        if (name === "stop") assert.equal(thread.turns.at(-1).status, "interrupted");
        if (name === "unknown") {
          assert.equal(record.locators, 1);
          const sends = record.requests.filter((request) => request.method === "session.send");
          assert.equal(sends.length, 1);
          droppedSubmission = sends[0];
          assert.equal(droppedSubmission.admissionState, "accepted");
          assert.equal(typeof droppedSubmission.commandId, "string");
          assert.equal(typeof droppedSubmission.operationId, "string");
          assert.equal(droppedSubmission.turnId, thread.turns.at(-1).id);
          const receipts = await host.project.core.call("areal/request/read", {
            threadId: host.threadId,
            requestId: droppedSubmission.operationId,
          });
          const original = receipts.data.filter(
            (receipt) =>
              receipt.requestId === droppedSubmission.operationId &&
              receipt.method === "areal/turn/start",
          );
          assert.equal(original.length, 1);
          assert.equal(original[0].result.turn.id, droppedSubmission.turnId);
          record.originalReceipt = {
            requestId: original[0].requestId,
            turnId: original[0].result.turn.id,
          };
        }
        if (name === "recover") {
          assert.equal(record.locators, 0);
          assert.equal(
            record.requests.some((request) => request.method === "session.send"),
            false,
          );
          const reads = record.requests.filter((request) => request.method === "command.read");
          assert.equal(reads.length, 1);
          assert.equal(reads[0].admissionState, "accepted");
          assert.equal(reads[0].commandId, droppedSubmission.commandId);
          assert.equal(reads[0].operationId, droppedSubmission.operationId);
          assert.equal(reads[0].turnId, droppedSubmission.turnId);
        }
      }
      if (workspaceScenario && name !== "pair") assert.equal(record.projects, 2);
      if (["history", "live"].includes(name)) assert.equal(record.history, true);
      if (name === "history") assert.equal(record.historyAutoload, true);
      if (name === "live") {
        assert.equal(record.live, true);
        const thread = await host.project.core.call("thread/read", {
          threadId: host.threadId,
          includeTurns: true,
        });
        assert.equal(thread.thread.turns.length, 53);
        assert.ok(thread.thread.turns.every((turn) => turn.status === "completed"));
        assert.ok(host.modelRequests() >= 53);
      }
      if (name === "release") {
        const opened = record.requests.find((request) => request.method === "session.open");
        const closed = record.requests.filter((request) => request.method === "subscription.close");
        assert.equal(typeof opened?.subscriptionId, "string");
        assert.equal(closed.length, 1);
        assert.equal(closed[0].subscriptionId, opened.subscriptionId);
        assert.equal(closed[0].closed, true);
      }
      if (workspaceScenario || commandScenario) await host.remote.refresh();
      assert.equal(host.remote.state().pending.length, 0);
      await writeFile(
        join(output, `result-${runtime}.json`),
        JSON.stringify(records, null, 2) + "\n",
      );
    }
    if (commandScenario && process.env.AREAL_MOBILE_HOLD === "1") {
      const until = Date.now() + 600000;
      await writeFile(
        join(output, "hold.json"),
        JSON.stringify(
          {
            simulator,
            simulatorName,
            bundleId,
            evidence: output,
            projectId: host.projectIds[0],
            threadId: host.threadId,
            expiresAt: new Date(until).toISOString(),
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify({ holding: true, evidence: output }));
      while (
        Date.now() < until &&
        !(await readFile(join(output, "release"), "utf8")
          .then(() => true)
          .catch(() => false))
      )
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (error) {
    console.error(`${stage}: ${error.message}`);
    if (simulator)
      await sim("io", simulator, "screenshot", join(output, `${runtime}-failure.png`)).catch(
        () => {},
      );
    process.exitCode = 1;
  } finally {
    for (const fn of cleanup.reverse()) {
      try {
        await fn();
        cleaned.push(true);
      } catch {
        cleaned.push(false);
        process.exitCode = 1;
      }
    }
    if (simulator) {
      await sim("terminate", simulator, bundleId).catch(() => {});
      await sim("shutdown", simulator).catch(() => {});
      await sim("delete", simulator);
    }
    await writeFile(
      join(output, `environment-${runtime}.json`),
      JSON.stringify(
        {
          revision: await run("git", ["rev-parse", "HEAD"]),
          runtime,
          dirty: (await run("git", ["status", "--porcelain"])).length > 0,
          dirtyPaths: (await run("git", ["status", "--porcelain"])).split("\n").filter(Boolean),
          stage,
          xcode: await run("xcodebuild", ["-version"]),
          node: process.version,
          relayNode: {
            path: process.env.AREAL_RELAY_NODE ?? process.execPath,
            version: await run(process.env.AREAL_RELAY_NODE ?? process.execPath, ["--version"]),
          },
          records: records.length,
          cleanup: cleaned,
          ...(workspaceScenario || commandScenario
            ? {
                nativeHostEvidence: host?.evidence
                  ? join(host.evidence.root, "evidence.json")
                  : null,
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
          processExitCode: process.exitCode ?? 0,
        },
        null,
        2,
      ) + "\n",
    );
  }
}
