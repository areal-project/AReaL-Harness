import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../../examples/desktop-api/client.mjs";
import { nativeHostFixture, nativeCoreProject } from "./remote-native-host-fixture.mjs";
import { pushRelay, phone, until, runWithIsolatedCA } from "./remote-native-push-fixture.mjs";

function errorDetails(error) {
  return {
    message: String(error?.stack ?? error),
    ...(Array.isArray(error?.errors) ? { errors: error.errors.map(errorDetails) } : {}),
  };
}

async function lldbBarrier(pid, fixture) {
  assert.equal(process.platform, "darwin", "LLDB barrier requires macOS");
  assert.equal(pid, fixture.evidence.hostPid);
  const command = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  }).trim();
  assert.equal(command, `${fixture.evidence.binary} host run`);
  assert.equal(
    createHash("sha256")
      .update(await readFile(fixture.evidence.binary))
      .digest("hex"),
    fixture.evidence.binarySha256,
  );
  const root = fixture.evidence.root;
  const helper = fileURLToPath(new URL("./remote-native-lldb-barrier.py", import.meta.url));
  const child = spawn(
    "/usr/bin/lldb",
    [
      "--batch",
      "-o",
      `process attach --pid ${pid}`,
      "-o",
      'breakpoint set --func-regex "settle_command::h[0-9a-f]+$"',
      "-o",
      "breakpoint list",
      "-o",
      "script lldb.debugger.SetAsync(True)",
      "-o",
      "process continue",
      "-o",
      `script exec(open(${JSON.stringify(helper)}).read())`,
    ],
    { env: { ...process.env, AREAL_T18_LLDB_ROOT: root }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "",
    exited;
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output += chunk;
    });
  const exit = new Promise((resolve) => {
    child.once("error", (error) => {
      exited = { error: String(error) };
      resolve(exited);
    });
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      resolve(exited);
    });
  });
  const waitFile = async (name, milliseconds) => {
    const end = Date.now() + milliseconds;
    while (Date.now() < end) {
      try {
        return JSON.parse(await readFile(join(root, name), "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (exited) throw new Error(`LLDB exited before ${name}: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`LLDB deadline before ${name}: ${output}`);
  };
  const boundedExit = async (milliseconds) => {
    let timer;
    return Promise.race([
      exit,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), milliseconds);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  const decide = async (value) => {
    const temporary = join(root, "lldb-decision.tmp");
    await writeFile(temporary, value, { mode: 0o600 });
    await rename(temporary, join(root, "lldb-decision"));
  };
  const cleanup = async () => {
    const failures = [];
    try {
      if (!exited) {
        await decide("abort");
        if (!(await boundedExit(80000))) {
          if (/Process \d+ stopped/.test(output))
            throw new Error(
              "attached LLDB did not detach; preserve the original Host and debugger for inspection",
            );
          const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
            encoding: "utf8",
          })
            .split("\n")
            .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
            .filter(Boolean);
          const servers = rows
            .filter(
              (row) =>
                Number(row[2]) === child.pid &&
                row[3].includes("/LLDB.framework/Resources/debugserver"),
            )
            .map((row) => Number(row[1]));
          child.kill("SIGTERM");
          for (const id of servers)
            try {
              process.kill(id, "SIGTERM");
            } catch (error) {
              if (error.code !== "ESRCH") throw error;
            }
          assert.ok(await boundedExit(5000), "unattached LLDB did not exit");
        }
      }
    } catch (error) {
      failures.push(error);
    }
    let result;
    try {
      result = JSON.parse(await readFile(join(root, "lldb-result.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") failures.push(error);
    }
    if (result && !result.success)
      failures.push(new Error(`LLDB cleanup failed: ${JSON.stringify(result)}`));
    try {
      await writeFile(join(root, "lldb.log"), output, { mode: 0o600 });
    } catch (error) {
      failures.push(error);
    }
    try {
      await writeFile(
        join(root, "lldb-cleanup.json"),
        JSON.stringify({
          pid: child.pid,
          hostPid: pid,
          exit: exited,
          result,
          errors: failures.map(errorDetails),
        }),
        { mode: 0o600 },
      );
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, "LLDB cleanup failed");
  };
  try {
    await waitFile("lldb-ready.json", 120000);
    assert.match(output, /locations = 1\b/);
    return {
      pid: child.pid,
      hit: async () => {
        const hit = await waitFile("lldb-hit.json", 30000);
        assert.equal(hit.state, "stopped");
        assert.equal(hit.pid, pid);
        assert.equal(hit.breakpoint, 1);
        assert.equal(hit.location, 1);
        assert.ok(hit.threads > 0);
        return hit;
      },
      kill: async () => {
        await decide("kill");
        const result = await boundedExit(30000);
        assert.ok(result, "LLDB did not terminate the original Host");
        assert.equal(result.code, 0, output);
        const action = JSON.parse(await readFile(join(root, "lldb-result.json"), "utf8"));
        assert.equal(action.action, "kill");
        assert.equal(action.success, true);
      },
      cleanup,
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "LLDB barrier and cleanup failed");
    }
    throw error;
  }
}

if (!process.env.RC12_TLS_HOME) {
  test("T18 barrier uses isolated CA", async () => runWithIsolatedCA(import.meta.filename));
} else {
  test("recover original creation after independent Host crash", { timeout: 270000 }, async (t) => {
    const relay = await pushRelay(t);
    const fixture = await nativeHostFixture(t);
    const project = await nativeCoreProject(t, fixture, { effectModel: true });
    const proof = {
      passed: false,
      boundary:
        "single independent Host crash with real Noise, Core and Runtime; no 100-race claim",
      barrier: process.env.AREAL_T18_BARRIER === "lldb" ? "lldb" : "filesystem",
      scriptSha256: createHash("sha256")
        .update(await readFile(import.meta.filename))
        .digest("hex"),
    };
    const path = join(fixture.evidence.root, "t18-crash-recovery.json");
    t.after(() => writeFile(path, JSON.stringify(proof, null, 2), { mode: 0o600 }));
    await fixture.remote.control({
      operation: "enable",
      relay: relay.origin,
      code: relay.enrollment(),
      confirmed: true,
    });
    await until(async () => (await fixture.remote.refresh()).connected, "native Relay ready");
    const device = await phone(t, fixture.remote, project.alias, undefined, true);
    const disconnected = once(device.socket, "close").then(
      ([code]) => ({ code }),
      (error) => ({ error: String(error) }),
    );
    const identity = JSON.parse(await readFile(join(fixture.home, "host/host.json"), "utf8"));
    assert.equal(identity.pid, fixture.evidence.hostPid);
    assert.equal(identity.hostId, fixture.client.hostId);
    assert.equal(identity.generation, fixture.client.generation);
    const records = join(fixture.home, "host/journals/records");
    const filename = join(
      records,
      createHash("sha256").update(project.projectId).digest("hex") + ".json",
    );
    const commandId = randomUUID();
    const readRecord = async () => {
      try {
        return JSON.parse(await readFile(filename, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    };
    let stopped = false;
    let response;
    let watcher;
    let debuggerBarrier;
    let failure;
    try {
      if (process.env.AREAL_T18_BARRIER === "lldb")
        debuggerBarrier = await lldbBarrier(identity.pid, fixture);
      const found = debuggerBarrier
        ? debuggerBarrier.hit().then(async (hit) => {
            stopped = true;
            proof.lldb = { pid: debuggerBarrier.pid, hostPid: identity.pid, hit };
            const record = await readRecord();
            return record?.snapshot.pending.find((row) => row.remote?.commandId === commandId);
          })
        : new Promise((resolve, reject) => {
            let reading = false;
            const inspect = async () => {
              if (reading || stopped) return;
              reading = true;
              try {
                const record = await readRecord();
                const pending = record?.snapshot.pending.find(
                  (row) => row.remote?.commandId === commandId,
                );
                if (pending) {
                  assert.equal(fixture.evidence.hostPid, identity.pid);
                  process.kill(identity.pid, "SIGSTOP");
                  stopped = true;
                  resolve(pending);
                } else if (
                  Object.values(record?.snapshot.outcomes ?? {}).some(
                    (row) => row.remote?.commandId === commandId,
                  )
                ) {
                  reject(new Error("original outcome settled before barrier; no retry"));
                }
              } catch (error) {
                reject(error);
              } finally {
                reading = false;
              }
            };
            watcher = watch(records, () => void inspect());
          });
      const context = {
        projectId: project.alias,
        gatewayGeneration: device.active.gatewayGeneration,
        grantRevision: device.active.grantRevision,
        serviceGeneration: project.service.generation,
      };
      const sent = device.rpc("session.create", {}, commandId, context).then(
        (value) => {
          response = value;
        },
        (error) => {
          response = { error: String(error) };
        },
      );
      let deadline;
      const pending = await Promise.race([
        found,
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error("pending barrier deadline; no retry")),
            debuggerBarrier ? 30000 : 10000,
          );
        }),
      ]).finally(() => clearTimeout(deadline));
      assert.ok(pending, "original pending command must exist at barrier");
      if (!debuggerBarrier)
        await until(
          () =>
            execFileSync("/bin/ps", ["-o", "stat=", "-p", String(identity.pid)], {
              encoding: "utf8",
            })
              .trim()
              .startsWith("T"),
          "exact Host stopped",
        );
      const frozen = await readRecord();
      const original = frozen.snapshot.pending.find((row) => row.remote?.commandId === commandId);
      assert.deepEqual(original, pending);
      assert.equal(frozen.snapshot.outcomes[pending.operationId], undefined);
      let matches = [];
      await until(async () => {
        const receipt = await project.core.call("areal/request/read", {
          requestId: pending.operationId,
          creationAdmission: pending.params.creationAdmission,
        });
        matches = receipt.data.filter(
          (row) =>
            row.requestId === pending.operationId &&
            row.method === "areal/thread/start" &&
            row.digest === pending.nativeDigest &&
            row.identity === pending.params.creationAdmission.identity &&
            row.status === "completed",
        );
        return matches.length > 0;
      }, "original Core creation receipt");
      assert.equal(matches.length, 1, "original Core receipt must already be completed");
      const threadId = matches[0].threadId ?? matches[0].result?.threadId;
      assert.ok(threadId);
      assert.equal(matches[0].operation.target.threadId, threadId);
      assert.deepEqual(await readRecord(), frozen);
      watcher?.close();
      watcher = undefined;
      Object.assign(proof, {
        hostId: identity.hostId,
        hostGeneration: identity.generation,
        pid: identity.pid,
        commandId,
        operationId: pending.operationId,
        threadId,
        pending,
        receipt: matches[0],
      });
      const listing = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
        encoding: "utf8",
      });
      const rows = listing
        .split("\n")
        .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
        .filter(Boolean)
        .map((row) => ({ pid: Number(row[1]), ppid: Number(row[2]), command: row[3] }));
      const owned = new Set([identity.pid]);
      let size;
      do {
        size = owned.size;
        for (const row of rows) if (owned.has(row.ppid)) owned.add(row.pid);
      } while (size !== owned.size);
      proof.oldProcesses = rows.filter((row) => owned.has(row.pid));
      assert(proof.oldProcesses.some((row) => row.pid === project.service.hostPid));
      assert(proof.oldProcesses.some((row) => row.pid === project.service.corePid));
      const launchPath = join(
        fixture.home,
        "host/launch",
        createHash("sha256").update(project.projectId).digest("hex"),
        "inputs.json",
      );
      const launchInputs = JSON.parse(await readFile(launchPath, "utf8"));
      const remote = await fixture.crashRestart(
        async () => {
          stopped = false;
          await until(
            () =>
              [...owned].every((pid) => {
                try {
                  process.kill(pid, 0);
                  return false;
                } catch (error) {
                  if (error.code === "ESRCH") return true;
                  throw error;
                }
              }),
            "original process topology exits",
          );
          const lockPaths = [
            join(fixture.home, "host.lock"),
            join(project.service.dataDir, "service.lock"),
            join(project.service.dataDir, "owner.lock"),
          ];
          await until(() => {
            const script =
              'import fcntl,sys\nfor p in sys.argv[1:]:\n f=open(p,"r+")\n try: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\n except BlockingIOError: sys.exit(1)\n f.close()';
            try {
              execFileSync("/usr/bin/python3", ["-c", script, ...lockPaths], { stdio: "ignore" });
              return true;
            } catch {
              return false;
            }
          }, "original Host and Core locks released");
          proof.oldLocksReleased = lockPaths;
          const cleanupPath = join(
            fixture.home,
            "services",
            project.service.serviceId,
            "cleanup.json",
          );
          const cleanup = JSON.parse(await readFile(cleanupPath, "utf8"));
          assert.equal(cleanup.identity.generation, project.service.generation);
          assert.equal(cleanup.identity.serviceId, project.service.serviceId);
          assert.deepEqual(cleanup.owner, project.service.owner);
          assert.equal(cleanup.cleanupConfirmed, true);
          proof.originalCleanup = cleanup;
        },
        debuggerBarrier
          ? async (pid) => {
              assert.equal(pid, identity.pid);
              await debuggerBarrier.kill();
            }
          : undefined,
      );
      let closeDeadline;
      const close = await Promise.race([
        disconnected,
        new Promise((_, reject) => {
          closeDeadline = setTimeout(
            () => reject(new Error("original Noise socket did not close")),
            10000,
          );
        }),
      ]).finally(() => clearTimeout(closeDeadline));
      assert.equal(close.error, undefined);
      proof.originalSocketCloseCode = close.code;
      await sent;
      proof.originalResponse = response;
      assert.ok(response?.error, "original Noise request must disconnect after Host crash");
      const ensureRequestId = randomUUID();
      proof.successorEnsure = {
        requestId: ensureRequestId,
        projectId: project.projectId,
        hostId: fixture.client.hostId,
        generation: fixture.client.generation,
      };
      await writeFile(path, JSON.stringify(proof, null, 2), { mode: 0o600 });
      const ensured = await fixture.client.ensureProject(
        ensureRequestId,
        project.projectId,
        launchInputs,
        {},
      );
      assert.equal(ensured.project.state, "ready");
      assert.notEqual(ensured.service.generation, project.service.generation);
      proof.successor = ensured.service;
      const core = await connect(ensured.service.endpoint, ensured.service.authFile);
      t.after(() => core.close());
      await until(async () => (await remote.refresh()).connected, "successor Relay connected");
      const successor = await phone(t, remote, project.alias, device.identity);
      const recovered = await successor.rpc("command.read", { commandId }, undefined, {
        projectId: project.alias,
      });
      assert.equal(recovered.result.admissionState, "accepted", JSON.stringify(recovered));
      assert.equal(recovered.result.operationId, pending.operationId);
      assert.equal(recovered.result.threadId, threadId);
      const context2 = {
        projectId: project.alias,
        gatewayGeneration: successor.active.gatewayGeneration,
        grantRevision: successor.active.grantRevision,
        serviceGeneration: ensured.service.generation,
      };
      const before = (await core.call("thread/list", { limit: 100 })).data
        .map((row) => row.id)
        .sort();
      assert.deepEqual(before, [threadId]);
      const duplicate = await successor.rpc("session.create", {}, commandId, context2);
      assert.equal(duplicate.result.admissionState, "accepted");
      assert.equal(duplicate.result.operationId, pending.operationId);
      assert.equal(duplicate.result.threadId, threadId);
      assert.deepEqual(
        (await core.call("thread/list", { limit: 100 })).data.map((row) => row.id).sort(),
        before,
      );
      const effect = randomUUID();
      const sentLater = await successor.rpc(
        "session.send",
        { threadId, expectedConfigRevision: 1, text: `RC05_EFFECT:${effect}` },
        randomUUID(),
        context2,
      );
      assert.equal(sentLater.result.admissionState, "accepted");
      let terminal;
      await until(async () => {
        const state = await core.call("thread/read", { threadId, includeTurns: true });
        terminal = state.thread.turns.find((row) => row.id === sentLater.result.turnId);
        return terminal && terminal.status !== "inProgress";
      }, "later ordinary turn completed");
      assert.equal(terminal.status, "completed");
      const tools = terminal.items.filter((row) => row.tool === "run_command");
      assert.equal(tools.length, 1);
      assert.equal(tools[0].execution.backend, "runtime");
      assert.equal(tools[0].execution.outcome, "succeeded");
      assert.equal(await readFile(join(project.workspace, "effects", effect), "utf8"), "x");
      Object.assign(proof, {
        recovered: recovered.result,
        duplicate: duplicate.result,
        laterTurn: terminal,
        runtimeEffect: "x",
        passed: true,
      });
    } catch (error) {
      proof.error = errorDetails(error);
      proof.response = response ?? null;
      failure = error;
    } finally {
      const cleanupErrors = [];
      try {
        watcher?.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      let detached = false;
      try {
        await debuggerBarrier?.cleanup();
        detached = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (stopped && detached) {
        try {
          await fixture.resumeOwnedHost(identity.pid);
          stopped = false;
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length) {
        proof.cleanupError = cleanupErrors.map(errorDetails);
        failure = failure
          ? new AggregateError([failure, ...cleanupErrors], "T18 and cleanup failed")
          : new AggregateError(cleanupErrors, "T18 cleanup failed");
      }
    }
    if (failure) throw failure;
  });
}
