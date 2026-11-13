import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
const script = fileURLToPath(import.meta.url);
const { executeCore } = createRequire(import.meta.url)("./support/core-process-fixture.cjs");

if (process.argv.includes("--guard")) {
  let orphaned = false,
    cleaning,
    started,
    configuration,
    descriptor;
  process.on("disconnect", () => {
    orphaned = true;
    if (started) void started.finally(cleanup);
  });
  const cleanup = () =>
    (cleaning ??= (async () => {
      const { binary, env, evidence } = configuration;
      const call = async (args, timeout = 120000) =>
        JSON.parse(
          (await executeCore(binary, ["service", ...args, "--json"], { env, timeout })).stdout,
        );
      const receipts = [],
        errors = [];
      try {
        const records = descriptor ? [descriptor] : await call(["list"]);
        for (const record of records) {
          const requestId = randomUUID(),
            deadline = Date.now() + 60000;
          const result = { serviceId: record.serviceId, generation: record.generation, requestId };
          receipts.push(result);
          const original = [
            "--instance",
            record.serviceId,
            "--expected-generation",
            record.generation,
            "--request-id",
            requestId,
          ];
          const remaining = () => {
            const timeout = deadline - Date.now();
            if (timeout <= 0)
              throw new Error("CLI fixture cleanup did not complete within 60 seconds");
            return timeout;
          };
          try {
            try {
              result.receipt = await call(["stop", ...original, "--cancel"], remaining());
            } catch (error) {
              result.stopError = error.message;
            }
            for (;;) {
              const { operation } = await call(["operation", ...original], remaining());
              result.operation = operation;
              if (
                !operation ||
                operation.serviceId !== record.serviceId ||
                operation.generation !== record.generation ||
                operation.requestId !== requestId ||
                operation.cancel !== true
              ) {
                throw new Error("The original CLI stop receipt is missing or has changed");
              }
              if (operation.state === "completed") break;
              if (operation.state !== "acceptedPending")
                throw new Error(
                  `Original CLI stop is ${operation.state}: ${operation.message ?? ""}`,
                );
              await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining())));
            }
            const pids = [record.hostPid, record.corePid].filter(
              (pid) => Number.isSafeInteger(pid) && pid > 1,
            );
            do {
              result.remainingPids = pids.filter((pid) => {
                try {
                  process.kill(pid, 0);
                  return true;
                } catch (error) {
                  if (error.code === "ESRCH") return false;
                  throw error;
                }
              });
              if (!result.remainingPids.length) break;
              await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining())));
            } while (remaining());
            result.status = await call(["status", "--instance", record.serviceId], remaining());
            result.originalRecord = JSON.parse(
              await readFile(
                join(env.AREAL_HARNESS_SERVICE_HOME, "services", record.serviceId, "service.json"),
                "utf8",
              ),
            );
            for (const settled of [result.status, result.originalRecord]) {
              if (
                settled.serviceId !== record.serviceId ||
                settled.generation !== record.generation ||
                settled.state !== "stopped"
              ) {
                throw new Error("The original CLI service has not confirmed its stopped state");
              }
            }
            result.cleanupConfirmed = true;
          } catch (error) {
            errors.push(`${record.serviceId}: ${error.message}`);
          }
        }
      } catch (error) {
        errors.push(error.message);
      }
      await writeFile(
        evidence,
        JSON.stringify({ passed: errors.length === 0, receipts, errors }, null, 2),
      );
      process.exit(errors.length ? 1 : 0);
    })());
  process.once("message", (value) => {
    configuration = value;
    started = (async () => {
      try {
        descriptor = JSON.parse(
          (
            await executeCore(value.binary, ["service", "ensure", ...value.args, "--json"], {
              env: value.env,
              timeout: 120000,
            })
          ).stdout,
        );
        if (!orphaned && process.connected)
          process.send({ descriptor }, (error) => {
            if (error) {
              orphaned = true;
              void cleanup();
            }
          });
      } catch (error) {
        if (!orphaned && process.connected) process.send({ error: error.message }, () => {});
      }
    })();
    void started.then(() => {
      if (orphaned || !descriptor) return cleanup();
    });
  });
}

export async function persistentServiceFixture(configuration) {
  const child = fork(script, ["--guard"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let closed = false;
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`CLI fixture guard exited ${code ?? signal}`)),
    );
  });
  completion.catch(() => {});
  const descriptor = await new Promise((resolve, reject) => {
    child.once("message", (message) =>
      message.error ? reject(new Error(message.error)) : resolve(message.descriptor),
    );
    child.once("error", reject);
    child.once("exit", () => reject(new Error("CLI fixture guard exited before ensure completed")));
    child.send(configuration);
  });
  const disconnect = () => {
    if (!closed) {
      closed = true;
      if (child.connected) child.disconnect();
    }
  };
  child.unref();
  return {
    descriptor,
    pid: child.pid,
    async close() {
      child.ref();
      disconnect();
      await completion;
    },
  };
}
