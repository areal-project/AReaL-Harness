"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdtemp, mkdir, realpath, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { createRequire } = require("node:module");

test(
  "legacy Desktop singleton remains held until Host pipe closes",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "areal-relay-guard-"));
    const appDir = join(root, "app");
    const coreHome = join(root, "core");
    await mkdir(appDir);
    await mkdir(coreHome);
    const canonicalHome = await realpath(coreHome);
    const mainPath = resolve(__dirname, "../app/src/main.cjs");
    await writeFile(join(appDir, "package.json"), JSON.stringify({ main: "main.cjs" }));
    await writeFile(
      join(appDir, "main.cjs"),
      `const {app}=require('electron');\nif(process.argv[2]==='--old'){app.setPath('userData',require('node:path').join(process.argv[3],'.service-user-data'));require('node:fs').mkdirSync(app.getPath('userData'),{recursive:true});if(!app.requestSingleInstanceLock())app.exit(1);else{process.stdin.once('end',()=>app.exit(0));process.stdin.resume();process.stdout.write(JSON.stringify({kind:'ready',coreHome:require('node:fs').realpathSync(process.argv[3]),pid:process.pid})+'\\n');}}else require(${JSON.stringify(mainPath)});\n`,
    );
    const electron = createRequire(resolve(__dirname, "../app/package.json"))("electron");
    const children = [];
    t.after(async () => {
      const active = children.filter(
        (child) => child.exitCode === null && child.signalCode === null,
      );
      const exits = active.map((child) => once(child, "exit"));
      for (const child of active) child.kill();
      await Promise.all(exits);
      await rm(root, { recursive: true, force: true });
    });
    const start = (old = false) => {
      const args = old ? ["--old", coreHome] : [`--areal-relay-legacy-guard=${coreHome}`];
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(electron, [appDir, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
      child.stderr.on("data", (bytes) => process.stderr.write(bytes));
      children.push(child);
      return child;
    };
    const readyLine = (child) =>
      Promise.race([
        once(child.stdout, "data").then(([bytes]) => bytes),
        once(child, "exit").then(([code]) => {
          throw new Error(`guard exited before ready: ${code}`);
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("guard ready timed out")), 5000),
        ),
      ]);
    const first = start(true);
    const chunk = await readyLine(first);
    const ready = JSON.parse(String(chunk).trim());
    assert.deepEqual(ready, { kind: "ready", coreHome: canonicalHome, pid: first.pid });
    const second = start();
    let output = "";
    second.stdout.on("data", (bytes) => {
      output += bytes;
    });
    const [code] = await Promise.race([
      once(second, "exit"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("second guard did not exit")), 5000),
      ),
    ]);
    assert.equal(code, 1);
    assert.equal(output, "");
    first.stdin.end();
    assert.equal((await once(first, "exit"))[0], 0);
    const third = start();
    const thirdChunk = await readyLine(third);
    assert.equal(JSON.parse(String(thirdChunk).trim()).coreHome, canonicalHome);
    const fourth = start(true);
    assert.equal((await once(fourth, "exit"))[0], 1);
    third.stdin.end();
    assert.equal((await once(third, "exit"))[0], 0);
  },
);
