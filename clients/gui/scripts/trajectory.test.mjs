import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(new URL("../app/package.json", import.meta.url));
const { TrajectoryExport } = require("../app/src/core/trajectory.cjs");
const { validateCommand } = require("@areal/workbench/desktop-contract");
const status = {
  enabled: true,
  state: "degraded",
  endpoint: "https://collector.example.test/ingest",
  configPath: "/isolated/config with spaces.toml",
  spool_dir: "/isolated/spool",
  worker_running: false,
  queue: {
    pending: 1,
    uploading: 0,
    failed: 1,
    uploaded: 3,
    evicted: 2,
    bytes: 128,
    max_bytes: 1024,
    dropped_memory: 1,
    dropped_oversize: 0,
  },
  last_error: "authentication_failed",
  last_success_at: 1000,
  records: [
    {
      id: "batch-1",
      status: "failed",
      created_at: 900,
      uploaded_at: null,
      attempts: 2,
      next_attempt_at: 2000,
      bytes: 128,
      error: "authentication_failed",
    },
  ],
  limits: { max_retries: 5, upload_interval_ms: 1000, max_memory_bytes: 4096 },
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "areal-trajectory-gui-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, "core fixture.cjs"),
    response = join(directory, "response.json"),
    calls = join(directory, "calls.json");
  await writeFile(
    binary,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.FIXTURE_CALLS, JSON.stringify({args:process.argv.slice(2), home:process.env.AREAL_HARNESS_HOME}));
const value=fs.readFileSync(process.env.FIXTURE_RESPONSE,'utf8');
if(value==='fail') { process.stderr.write('credential fixture-secret rejected'); process.exit(1); }
process.stdout.write(value);
`,
    { mode: 0o700 },
  );
  await writeFile(response, JSON.stringify(status));
  const exporter = new TrajectoryExport({
    binary,
    config: status.configPath,
    hooks: {
      environment: () => ({
        ...process.env,
        AREAL_HARNESS_HOME: directory,
        FIXTURE_CALLS: calls,
        FIXTURE_RESPONSE: response,
      }),
    },
    providers: { redact: (text) => text.replaceAll("fixture-secret", "[redacted]") },
  });
  return { exporter, response, calls, directory };
}

test("desktop trajectory capability rejects configuration and destination overrides", () => {
  for (const operation of ["status", "retry"])
    validateCommand("trajectory", { operation }, { serviceOnly: true });
  for (const params of [
    {},
    { operation: "sync-config" },
    { operation: "retry", endpoint: "https://untrusted.example" },
    { operation: "status", config: "/other.toml" },
    { operation: "status", projectId: "project" },
  ]) {
    assert.throws(() => validateCommand("trajectory", params), { code: "INVALID_DESKTOP_REQUEST" });
  }
});

test("fixed CLI arguments preserve GUI config and environment; only public fields cross IPC", async (t) => {
  const { exporter, response, calls, directory } = await fixture(t);
  await writeFile(
    response,
    JSON.stringify({
      ...status,
      credential: "must-not-cross-ipc",
      records: [{ ...status.records[0], content: "private trajectory" }],
    }),
  );
  assert.deepEqual(await exporter.command({ operation: "status" }), status);
  assert.deepEqual(JSON.parse(await readFile(calls, "utf8")), {
    args: ["trajectory", "status", "--config", status.configPath],
    home: directory,
  });
  assert.deepEqual(await exporter.command({ operation: "retry" }), status);
  assert.equal(JSON.parse(await readFile(calls, "utf8")).args[1], "retry");
  await assert.rejects(exporter.command({ operation: "status", config: "/other.toml" }), {
    code: "INVALID_DESKTOP_REQUEST",
  });
});

test("invalid CLI responses fail explicitly and stderr uses credential redaction", async (t) => {
  const { exporter, response } = await fixture(t);
  for (const value of [
    "not-json",
    JSON.stringify({ ...status, queue: { ...status.queue, failed: -1 } }),
    JSON.stringify({ ...status, records: [{ ...status.records[0], status: "unknown" }] }),
  ]) {
    await writeFile(response, value);
    await assert.rejects(exporter.command({ operation: "status" }), /无效的数据飞轮状态/);
  }
  await writeFile(response, "fail");
  await assert.rejects(
    exporter.command({ operation: "retry" }),
    (error) => error.message.includes("[redacted]") && !error.message.includes("fixture-secret"),
  );
});

test("optional execution metadata is projected without changing legacy records", async (t) => {
  const { exporter, response } = await fixture(t);
  const metadata = {
    turn_id: "turn-42",
    event_name: "areal.turn.completed",
    model_name: "fixture-model",
    harness_version: "0.1.4",
    execution_duration_ms: 0,
    occurred_at: 800,
  };
  const enriched = { ...status, records: [{ ...status.records[0], ...metadata }] };
  await writeFile(
    response,
    JSON.stringify({
      ...enriched,
      records: [{ ...enriched.records[0], internal_trace: "private" }],
    }),
  );
  assert.deepEqual(await exporter.command({ operation: "status" }), enriched);
  const missing = {
    ...status,
    records: [{ ...status.records[0], occurred_at: null, model_name: null }],
  };
  await writeFile(response, JSON.stringify(missing));
  assert.deepEqual(await exporter.command({ operation: "status" }), missing);
  for (const invalid of [
    { model_name: 5 },
    { occurred_at: "800" },
    { execution_duration_ms: -1 },
  ]) {
    await writeFile(
      response,
      JSON.stringify({ ...status, records: [{ ...status.records[0], ...invalid }] }),
    );
    await assert.rejects(exporter.command({ operation: "status" }), /无效的数据飞轮状态/);
  }
});
