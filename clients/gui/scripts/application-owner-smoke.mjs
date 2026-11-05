import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
const { DesktopService } = require("@areal/workbench-service/desktop/core/service-protocol.cjs");
const { SharedCoreBackend } = require("../app/src/core/service-client.cjs");
const { createOwner } = require("@areal/workbench-service/desktop/core/application-owner.cjs");
const { executeCore } = require("@areal/workbench-service/desktop/core/core-process.cjs");
const binary = process.env.AREAL_CORE_BIN;
assert.ok(binary?.startsWith(resolve(gui, "../../.local/dev-bin") + "/"));
const scratch = await makeTempDir("ao-");
console.log("Application owner recovery evidence:", scratch);
const checks = [],
  errors = [],
  observers = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, label) => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(30);
  }
  throw new Error("Timeout: " + label);
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
const profile = join(scratch, "profile"),
  home = join(scratch, "core"),
  registry = join(scratch, "registry"),
  workspace = join(scratch, "workspace");
const config = join(scratch, "config.toml");
await mkdir(workspace);
await writeFile(
  config,
  'schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:1/v1/chat/completions"\n',
);
const applicationOwner = createOwner(profile);
const backend = new CoreBackend({
  binary,
  home,
  harnessHome: registry,
  config,
  applicationOwner,
  userHome: join(scratch, "user"),
});
let service,
  pausedHost,
  resumeGuard,
  passed = false;
const records = async () => {
  const names = await readdir(join(registry, "services")).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return (
    await Promise.all(
      names.map((name) =>
        readFile(join(registry, "services", name, "service.json"), "utf8")
          .then(JSON.parse)
          .catch((error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          }),
      ),
    )
  ).filter(Boolean);
};
try {
  await backend.init();
  const wrapper = join(scratch, "controlled-core.py"),
    fault = join(scratch, "fault.json");
  const resume = join(scratch, "resume-host.py"),
    resumeReady = join(scratch, "resume-ready");
  await writeFile(
    resume,
    'import os,sys,signal,select\nopen(sys.argv[2],"w").close()\nwhile True:\n select.select([4],[],[])\n try: os.read(4,1); break\n except BlockingIOError: pass\ntry: os.kill(int(sys.argv[1]),signal.SIGCONT)\nexcept ProcessLookupError: pass\n',
  );
  await writeFile(
    wrapper,
    `#!/usr/bin/python3
import os,sys,json,subprocess,time,signal
args=sys.argv[1:]
p=subprocess.Popen([${JSON.stringify(binary)}]+args,pass_fds=(4,) if os.environ.get('AREAL_GUI_LIFETIME_FD')=='4' else ())
if args[:2]==['service','ensure']:
  deadline=time.monotonic()+20
  while time.monotonic()<deadline:
    rows=[]
    for line in subprocess.check_output(['/bin/ps','-ww','-axo','pid=,ppid=,args='],text=True).splitlines():
      parts=line.strip().split(None,2)
      if len(parts)==3: rows.append((int(parts[0]),int(parts[1]),parts[2]))
    descendants={p.pid}
    while True:
      before=len(descendants)
      descendants.update(pid for pid,parent,cmd in rows if parent in descendants)
      if len(descendants)==before: break
    hosts=[pid for pid,parent,cmd in rows if pid in descendants and cmd==${JSON.stringify(binary + " service-host")}]
    if hosts:
      host=hosts[0]
      guard=subprocess.Popen([sys.executable,${JSON.stringify(resume)},str(host),${JSON.stringify(resumeReady)}],pass_fds=(4,),stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
      while not os.path.exists(${JSON.stringify(resumeReady)}):
        if guard.poll() is not None: sys.exit('resume guard failed before ready')
        time.sleep(0.005)
      os.kill(host,signal.SIGSTOP); p.kill(); p.wait()
      with open(${JSON.stringify(fault)},'w') as f: json.dump({'hostPid':host,'guardPid':guard.pid,'cliPid':p.pid,'fault':'Host suspended before publication; ensure CLI killed'},f)
      sys.stderr.write('injected ensure response loss before Host publication'); sys.exit(1)
    time.sleep(0.005)
  p.kill(); p.wait(); sys.exit('Host was not observed')
sys.exit(p.wait())
`,
    { mode: 0o755 },
  );
  backend.binary = wrapper;
  await assert.rejects(() => backend.addProject(workspace), /injected ensure response loss/);
  const injection = JSON.parse(await readFile(fault, "utf8"));
  pausedHost = injection.hostPid;
  resumeGuard = injection.guardPid;
  assert.ok(alive(pausedHost));
  assert.ok(alive(resumeGuard));
  assert.deepEqual(await records(), [], "Host has not published a descriptor");
  const pending = [...backend.ownedEngines.values()][0];
  assert.equal(pending.pending, true);
  assert.equal(pending.lifetimes.size, 1);
  backend.binary = binary;
  await assert.rejects(
    () => backend.refreshOwnedEngines(),
    (error) => error.code === "LIFECYCLE_INCOMPLETE",
  );
  assert.equal(pending.pending, true);
  assert.equal([...pending.lifetimes][0].destroyed, false);
  checks.push(
    "lost ensure with a live unpublished Host remains UNKNOWN and prevents a false successful quit",
  );
  if (process.argv.includes("--hold-unpublished")) {
    await writeFile(
      join(scratch, "owner-loss-ready.json"),
      JSON.stringify({ hostPid: pausedHost, guardPid: resumeGuard }),
    );
    await new Promise(() => {});
  }
  process.kill(pausedHost, "SIGCONT");
  const original = await until(
    async () => (await records())[0]?.state === "ready" && (await records())[0],
    "original Host publishes after resume",
  );
  assert.equal(original.hostPid, pausedHost);
  await backend.refreshOwnedEngines();
  assert.equal(
    backend.ownedEngines.get(pending.project.id).service.generation,
    original.generation,
  );
  assert.equal(backend.ownedEngines.get(pending.project.id).pending, false);
  await backend.reconnectProject(pending.project);
  checks.push("refresh recovers the original startup generation without replaying ensure");
  backend.projects.delete(pending.project.id);
  backend.saved = backend.saved.filter((project) => project.id !== pending.project.id);

  service = new DesktopService(backend, "owner-integration", () => {});
  const metadata = await service.listen();
  await writeFile(join(home, "service.json"), JSON.stringify(metadata));
  const observer = async (profilePath) => {
    const value = new SharedCoreBackend({
      app: { getPath: () => profilePath },
      binary,
      home,
      harnessHome: registry,
      applicationOwner: createOwner(profilePath),
    });
    observers.push(value);
    assert.equal(await value.attach(), true);
    assert.ok(value.foreignOwner);
    return value;
  };
  for (const [label, profilePath] of [
    ["same profile", profile],
    ["different profile", join(scratch, "other-profile")],
  ]) {
    const value = await observer(profilePath);
    assert.equal(
      (await value.resources({ operation: "inspect", includeTasks: true }))[0].generation,
      original.generation,
      "ownership survives removal of current project projections",
    );
    assert.equal((await value.serviceStatus()).connected, true);
    for (const write of [
      () => value.resources({ operation: "terminate", projectId: pending.project.id }),
      () => value.remoteControl({ operation: "disable" }),
      () => value.stopService(),
      () => value.command("manage", { operation: "server", projectId: pending.project.id }),
      () =>
        value.command("manage", { operation: "toolAcknowledge", projectId: pending.project.id }),
      () => value.command("create", { projectId: pending.project.id }),
    ])
      await assert.rejects(write, (error) => error.code === "APPLICATION_OWNER_MISMATCH");
    if (label === "different profile")
      await assert.rejects(
        () => value.recoverForeignOwner(async () => ({ response: 1 })),
        (error) => error.code === "APPLICATION_OWNER_MISMATCH",
      );
    else {
      await value.recoverForeignOwner(async () => {
        await assert.rejects(
          () => value.stopService(),
          (error) => error.code === "APPLICATION_OWNER_MISMATCH",
        );
        return { response: 0 };
      });
    }
    assert.equal((await records())[0].generation, original.generation);
    assert.ok(alive(original.hostPid));
    await value.shutdown();
    checks.push(
      `${label} foreign observer permits dedicated inspection and blocks generic reads that can start work, writes, ordinary stop and concurrent migration bypass`,
    );
  }
  await backend.lifecycleOperations.request({
    requestId: require("node:crypto").randomUUID(),
    kind: "stopProject",
    mode: "ifIdle",
    expectedDesktopGeneration: backend.lifecycleOperations.generation,
    expectedTargets: [
      {
        projectId: pending.project.id,
        serviceId: original.serviceId,
        generation: original.generation,
      },
    ],
  });
  await until(
    () => !alive(original.hostPid) && !alive(original.corePid),
    "original Host and Core exit",
  );
  assert.equal((await records())[0].state, "stopped");
  await backend.refreshOwnedEngines();
  assert.equal(backend.ownedEngines.size, 0);
  checks.push(
    "recovered original startup safely stops through its original Host receipt and clears ownership only after cleanup",
  );
  passed = true;
} catch (error) {
  errors.push(error.stack);
} finally {
  if (pausedHost && alive(pausedHost)) {
    try {
      process.kill(pausedHost, "SIGCONT");
    } catch {}
  }
  for (const value of observers) await value.shutdown().catch((error) => errors.push(error.stack));
  service?.close();
  for (const entry of backend.ownedEngines.values())
    for (const lifetime of entry.lifetimes ?? []) lifetime.destroy();
  const known = await records();
  for (const record of known)
    if (record.state !== "stopped")
      await executeCore(
        binary,
        [
          "service",
          "stop",
          "--instance",
          record.serviceId,
          "--expected-generation",
          record.generation,
          "--cancel",
          "--json",
        ],
        { env: backend.hooks.environment(), timeout: 60000 },
      ).catch((error) => errors.push(error.message));
  await backend.disconnect().catch((error) => errors.push(error.stack));
  await until(
    () =>
      (!pausedHost || !alive(pausedHost)) &&
      (!resumeGuard || !alive(resumeGuard)) &&
      known.every((record) => !alive(record.hostPid) && !alive(record.corePid)),
    "owned cleanup",
  ).catch((error) => errors.push(error.stack));
  passed = passed && errors.length === 0;
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        checks,
        errors,
        binary,
        binarySha256: createHash("sha256")
          .update(await readFile(binary))
          .digest("hex"),
        scope:
          "real Node Desktop service / Core / Runtime; controlled SIGSTOP Host + killed ensure CLI; real foreign observer transport",
        diffSha256: createHash("sha256")
          .update(
            execFileSync("git", ["diff", "HEAD"], {
              cwd: resolve(gui, "../.."),
              maxBuffer: 16 * 1024 * 1024,
            }),
          )
          .digest("hex"),
      },
      null,
      2,
    ),
  );
}
assert.ok(passed, errors.join("\n"));
console.log("PASS", checks);
