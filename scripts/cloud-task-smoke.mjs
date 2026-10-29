// 使用真实 CLI 与隔离 HTTP 后端验证提交、终态、产物及未知提交不重发。
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { spawnNative } from "./native-child.mjs";

const scratch = await mkdtemp("/tmp/areal-cloud-task-");
const binary = resolve(process.env.AREAL_TEST_BIN_DIR ?? "target/debug", "areal");
const token = "local-cloud-task-fixture";
const artifact = Buffer.from("CLOUD_TASK_ARTIFACT_OK\n");
const calls = [],
  jobs = new Map(),
  checks = [];
let submits = 0;
const server = createServer(async (request, response) => {
  assert.equal(request.headers.authorization, `Bearer ${token}`);
  const url = new URL(request.url, "http://fixture");
  calls.push({ method: request.method, path: url.pathname });
  const reply = (value, status = 200) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (request.method === "POST" && url.pathname === "/api/harness-tasks") {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.deepEqual(Object.keys(body), ["prompt"]);
    assert.match(request.headers["idempotency-key"], /^[a-f0-9-]{36}$/);
    submits++;
    const job = `job-${submits}`,
      task = `task-${submits}:env:0`;
    jobs.set(job, { prompt: body.prompt, task, polls: 0 });
    if (body.prompt === "unknown") return request.socket.destroy();
    return reply({ accepted: true, job_id: job, task_id: task }, 202);
  }
  const job = url.pathname.match(/^\/api\/jobs\/(job-\d+)$/);
  if (job) {
    const record = jobs.get(job[1]);
    return reply({ job: { status: record.prompt === "waiting" ? "RUNNING" : "DONE" } });
  }
  const result = url.pathname.match(/^\/api\/tasks\/(task-\d+%3Aenv%3A0)\/result$/);
  if (result) {
    const record = [...jobs.values()].find((value) => value.task === decodeURIComponent(result[1]));
    return reply({ status: record.prompt === "failed" ? "HARNESS_FAILED" : "OK" });
  }
  if (/^\/api\/tasks\/task-\d+%3Aenv%3A0\/artifacts$/.test(url.pathname))
    return reply({ data: [{ name: "proof.txt" }] });
  if (/^\/api\/tasks\/task-\d+%3Aenv%3A0\/artifacts\/proof.txt$/.test(url.pathname)) {
    assert.equal(url.searchParams.get("attempt"), "1");
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    return response.end(artifact);
  }
  reply({ error: "unexpected fixture request" }, 404);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const config = join(scratch, "config.toml"),
  secret = join(scratch, "token");
await writeFile(secret, token, { mode: 0o600 });
await writeFile(
  config,
  `schema_version=1\n[cloud]\nurl="http://127.0.0.1:${server.address().port}/api"\ntoken_file="token"\n`,
);
async function cli(args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("AREAL_") && !/^(all|http|https)_proxy$/i.test(key),
    ),
  );
  const child = spawnNative(binary, ["cloud", "--config", config, ...args], {
    cwd: scratch,
    env: { ...env, HOME: scratch, NO_PROXY: "127.0.0.1,localhost" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (value) => (stdout += value));
  child.stderr.on("data", (value) => (stderr += value));
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const [code, signal] = await once(child, "exit");
  clearTimeout(timer);
  assert.equal(signal, null, stderr);
  assert(!stdout.includes(token) && !stderr.includes(token), "credential is not printed");
  return {
    code,
    stderr,
    rows: stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((value) => JSON.parse(value)),
  };
}
try {
  const first = await cli(["exec", "success", "--request-id", randomUUID()]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.rows.at(-1).result.status, "OK");
  checks.push("exec waits for TaskResult OK after job DONE");
  const detached = await cli(["exec", "waiting", "--no-wait"]);
  assert.equal(detached.code, 0, detached.stderr);
  const receipt = detached.rows[0];
  assert.equal((await cli(["status", receipt.job_id])).rows[0].status, "RUNNING");
  assert.equal((await cli(["result", first.rows[0].task_id])).rows[0].result.status, "OK");
  checks.push("no-wait returns acceptance and status/result remain independently queryable");
  const output = join(scratch, "proof.txt");
  const download = await cli(["artifact", first.rows[0].task_id, "proof.txt", "--output", output]);
  assert.equal(download.code, 0, download.stderr);
  assert.deepEqual(await readFile(output), artifact);
  assert.equal(download.rows[0].sha256, createHash("sha256").update(artifact).digest("hex"));
  assert.notEqual(
    (await cli(["artifact", first.rows[0].task_id, "proof.txt", "--output", output])).code,
    0,
  );
  checks.push("artifact download matches bytes/hash and refuses overwrite");
  assert.notEqual((await cli(["exec", "failed"])).code, 0);
  checks.push("job DONE with HARNESS_FAILED is a CLI failure");
  const timeout = await cli(["exec", "waiting", "--timeout-seconds", "1"]);
  assert.notEqual(timeout.code, 0);
  assert.match(timeout.stderr, /may still run remotely/);
  checks.push("wait timeout preserves the remote-task uncertainty");
  const before = submits;
  assert.notEqual((await cli(["exec", "unknown"])).code, 0);
  assert.equal(submits, before + 1);
  checks.push("disconnect after submission does not replay POST");
  await writeFile(
    join(scratch, "evidence.json"),
    JSON.stringify({ passed: true, fixture: true, binary, checks, calls }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, scratch, checks }));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
