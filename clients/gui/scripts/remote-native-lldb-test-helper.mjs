import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function errorDetails(error) {
  return {
    message: String(error?.stack ?? error),
    ...(Array.isArray(error?.errors) ? { errors: error.errors.map(errorDetails) } : {}),
  };
}

export async function lldbBarrier(pid, fixture) {
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
