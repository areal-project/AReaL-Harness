import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile, appendFile, stat, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const gui = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(join(gui, "app/package.json"));
const modulePath = join(gui, "app/src/core/diagnostics.cjs");
const scratch = await makeTempDir("areal-diagnostics-storage-");
const mainRoot = join(scratch, "diagnostics/main"),
  desktopRoot = join(scratch, "desktop/diagnostics/desktop");
const secret = "PRIVATE_SENTINEL_TOKEN_PROMPT_PATH_91bf";
const child = (root, script = "") => {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `const d=require(${JSON.stringify(modulePath)});const fs=require('node:fs');d.start({role:'main',root:${JSON.stringify(root)},version:'0.1.12-beta.3'});${script}`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
};
const diagnostics = require(modulePath);
for (let i = 0; i < 10; i++)
  child(
    mainRoot,
    `d.record({type:'socket-error',boundary:'desktop-core',projectId:${JSON.stringify(secret)},code:'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH',message:${JSON.stringify(secret)},stack:${JSON.stringify(secret)}});`,
  );
assert.equal(
  (await readdir(mainRoot)).filter((name) => /^[a-f0-9-]{36}$/.test(name)).length,
  8,
  "Retention bounds process runs",
);
diagnostics.start({ role: "desktop", root: desktopRoot, version: "0.1.12-beta.3" });
for (let i = 0; i < 16000; i++)
  diagnostics.record({
    type: "socket-close",
    boundary: "desktop-core",
    projectId: secret,
    coreGeneration: secret,
    connectionGeneration: i,
    closeCode: 1006,
  });
const [run] = (await readdir(desktopRoot)).filter((name) => /^[a-f0-9-]{36}$/.test(name));
const runPath = join(desktopRoot, run);
const files = await readdir(runPath);
assert.ok(files.filter((name) => name.startsWith("events-")).length <= 4);
for (const name of files.filter((name) => name.startsWith("events-")))
  assert.ok((await stat(join(runPath, name))).size <= 256 * 1024);
await appendFile(join(runPath, "events-0.ndjson"), '\n{"incomplete":');
const forged = {
  schemaVersion: 1,
  runId: run,
  seq: 999999,
  at: new Date().toISOString(),
  uptimeMilliseconds: 1,
  type: "socket-error",
  boundary: "desktop-core",
  project: secret,
  code: secret,
  message: secret,
  env: { TOKEN: secret },
};
await appendFile(join(runPath, "events-1.ndjson"), JSON.stringify(forged) + "\n");
const outside = join(scratch, "outside");
await mkdir(outside);
await writeFile(join(outside, "secret"), secret);
await symlink(outside, join(mainRoot, randomUUID()));
const destination = join(scratch, "export.json");
const coreRoot = join(scratch, "core"),
  project = "a".repeat(24);
const modelRoot = join(coreRoot, project, "state/model-requests");
await mkdir(join(modelRoot, "errors"), { recursive: true });
const requestId = randomUUID();
await writeFile(
  join(modelRoot, requestId + ".json"),
  JSON.stringify({
    requestId,
    protocol: "responses",
    transport: "http-sse",
    startedAtUnixMs: 1,
    endpoint: {
      origin: `https://user:${secret}@example.invalid/private?token=${secret}`,
      route: `/private/${secret}`,
    },
    parameters: { model: "gpt-fixture", service_tier: "priority", instructions: secret },
    usageDetails: { serviceTier: "default" },
    httpStatus: 200,
    outcome: "failed",
    streamError: {
      eventType: "error",
      errorType: "api_error",
      messageSummary: "upstream stream request failed",
      message: secret,
      code: secret,
    },
    errorDetailFile: join(modelRoot, "errors", requestId + ".json"),
    error: secret,
  }),
);
await writeFile(join(modelRoot, "errors", requestId + ".json"), secret);
await symlink(join(outside, "secret"), join(modelRoot, randomUUID() + ".json"));
const unfinishedId = randomUUID();
await writeFile(
  join(modelRoot, unfinishedId + ".json"),
  JSON.stringify({
    requestId: unfinishedId,
    outcome: "interrupted_or_unfinished",
    parameters: { service_tier: "priority" },
  }),
);
await diagnostics.exportTo(destination, {
  mainRoot,
  desktopRoot,
  coreRoot,
  instance: {
    packaged: false,
    coreBinary: join(scratch, "areal"),
    coreHome: coreRoot,
    config: join(scratch, "config.toml"),
    explicitConfig: true,
  },
});
let raw = await readFile(destination, "utf8"),
  report = JSON.parse(raw);
assert.equal(report.format, "areal-harness-diagnostics-v1");
assert.equal(report.instance.mode, "source");
assert.equal(report.instance.configSource, "explicit");
assert.match(report.instance.configPathSha256, /^[a-f0-9]{64}$/);
assert.equal(report.modelRequests.length, 2);
const request = report.modelRequests.find((item) => item.requestId === requestId);
const unfinished = report.modelRequests.find((item) => item.requestId === unfinishedId);
assert.equal(unfinished.outcome, "interrupted_or_unfinished");
assert.equal(unfinished.actualServiceTier, undefined);
assert.equal(request.requestedServiceTier, "priority");
assert.equal(request.actualServiceTier, "default");
assert.equal(request.httpStatus, 200);
assert.deepEqual(request.endpoint, {
  origin: "https://example.invalid",
  route: "[redacted]",
});
assert.equal(request.error.type, "api_error");
assert.equal(request.error.summary, "upstream stream request failed");
assert.equal(request.privateDetailAvailable, true);

assert.ok(!raw.includes(secret));
assert.ok(!raw.includes(scratch));
assert.match(raw, /WS_ERR_UNSUPPORTED_MESSAGE_LENGTH/);
assert.ok(report.omissions.rejectedEntries > 0 && report.omissions.invalidLines > 0);
assert.ok(report.runs.some((item) => item.health.rotations > 0));
assert.ok(report.bytesRead <= 16 * 1024 * 1024);
for (let index = 0; index < 140; index++) {
  const id = randomUUID();
  await writeFile(
    join(modelRoot, id + ".json"),
    JSON.stringify({ requestId: id, protocol: "responses" }),
  );
}
await diagnostics.exportTo(destination, { mainRoot, desktopRoot, coreRoot });
const bounded = JSON.parse(await readFile(destination, "utf8"));
assert.equal(bounded.modelRequests.length, 32);
assert.ok(bounded.omissions.truncatedFiles > 0);
assert.ok(bounded.bytesRead <= 16 * 1024 * 1024);
const { WebSocket, WebSocketServer } = require("ws");
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise((resolve) => server.once("listening", resolve));
server.on("connection", (socket) => socket.send("x".repeat(128)));
const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`, { maxPayload: 64 });
await new Promise((resolve) => {
  socket.on("error", (error) =>
    diagnostics.record({ type: "socket-error", boundary: "desktop-core", code: error.code }),
  );
  socket.on("close", (code) => {
    diagnostics.record({ type: "socket-close", boundary: "desktop-core", closeCode: code });
    resolve();
  });
});
await new Promise((resolve) => server.close(resolve));
await diagnostics.exportTo(destination, { mainRoot, desktopRoot });
report = JSON.parse(await readFile(destination, "utf8"));
assert.ok(
  report.runs
    .find((item) => item.header.role === "desktop")
    .events.some((event) => event.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"),
);
for (const code of ["ENOSPC", "EACCES"]) {
  const failureRoot = join(scratch, code, "diagnostics/main");
  child(
    failureRoot,
    `const original=fs.writeSync;fs.writeSync=()=>{throw Object.assign(new Error(${JSON.stringify(secret)}),{code:'${code}'})};d.record({type:'socket-open',boundary:'main-desktop'});fs.writeSync=original;d.exportTo(${JSON.stringify(join(scratch, code + ".json"))},{mainRoot:${JSON.stringify(failureRoot)},desktopRoot:${JSON.stringify(join(scratch, "absent"))}}).catch(()=>process.exitCode=1);`,
  );
  const result = await readFile(join(scratch, code + ".json"), "utf8");
  assert.ok(!result.includes(secret));
  assert.match(result, /write-failed/);
}
const badRoot = join(scratch, "bad/diagnostics/main");
await mkdir(badRoot, { recursive: true });
for (let i = 0; i < 130; i++) await writeFile(join(badRoot, String(i)), "x");
child(badRoot);
assert.equal(
  (await readdir(badRoot)).length,
  130,
  "Over-budget directory does not start another recorder",
);
await diagnostics.exportTo(destination, { mainRoot: badRoot, desktopRoot });
assert.ok(JSON.parse(await readFile(destination, "utf8")).omissions.scanLimit > 0);
const fifoRoot = join(scratch, "fifo/diagnostics/main");
child(
  fifoRoot,
  `
const path=require('node:path'),assert=require('node:assert/strict');
const run=fs.readdirSync(${JSON.stringify(fifoRoot)}).find(name=>/^[a-f0-9-]{36}$/.test(name));
const fifo=path.join(${JSON.stringify(fifoRoot)},run,'events-1.ndjson');
assert.equal(require('node:child_process').spawnSync('mkfifo',[fifo]).status,0);
const reader=fs.openSync(fifo,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK);
for(let i=0;i<4000;i++)d.record({type:'socket-close',boundary:'desktop-core',connectionGeneration:i,closeCode:1006});
assert.equal(fs.readSync(reader,Buffer.alloc(1024),0,1024,null),0,'Rotation must not write events into a FIFO');
fs.closeSync(reader);
assert.equal(JSON.parse(fs.readFileSync(path.join(${JSON.stringify(fifoRoot)},run,'health.json'))).state,'write-failed');
`,
);
console.log(
  "PASS bounded retention, rotation, privacy projection, rejected symlinks and FIFOs, torn writes, write failure isolation, directory budget, real WS size error",
);
console.log("Diagnostics storage evidence:", scratch);
