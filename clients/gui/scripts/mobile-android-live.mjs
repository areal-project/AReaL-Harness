import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const exec = promisify(execFile);
const { values } = parseArgs({ options: { target: { type: "string" } } });
const serial = values.target ?? process.env.AREAL_ANDROID_SERIAL;
assert.ok(
  serial?.startsWith("emulator-"),
  "Select an isolated emulator with --target emulator-<port>",
);
const origin = "http://127.0.0.1:5174";
const html = await (await fetch(origin)).text();
assert.ok(
  html.includes(fileURLToPath(new URL("../renderer/src/mobile.ts", import.meta.url))),
  "Run mobile:dev in this worktree first",
);
await exec("pnpm", ["--dir", "clients/gui", "mobile:android:sync"], {
  cwd: root,
  maxBuffer: 32 * 1024 * 1024,
});
const configPath = new URL(
  "../../../clients/mobile/android/app/src/main/assets/capacitor.config.json",
  import.meta.url,
);
const manifestPath = new URL(
  "../../../clients/mobile/android/app/src/main/AndroidManifest.xml",
  import.meta.url,
);
const config = await readFile(configPath, "utf8");
const manifest = await readFile(manifestPath, "utf8");
const child = spawn(
  "pnpm",
  [
    "--dir",
    "clients/gui",
    "--filter",
    "@areal/mobile",
    "exec",
    "cap",
    "run",
    "android",
    "--no-sync",
    "--target",
    serial,
    "--live-reload",
    "--host",
    "127.0.0.1",
    "--port",
    "5174",
    "--forwardPorts",
    "5174:5174",
  ],
  { cwd: root, stdio: "inherit" },
);
const interrupt = () => child.kill("SIGINT");
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
try {
  process.exitCode = await new Promise((done, fail) => {
    child.once("error", fail);
    child.once("exit", (code) => done(code ?? 1));
  });
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  await writeFile(configPath, config);
  await writeFile(manifestPath, manifest);
  await exec(
    process.env.AREAL_ANDROID_ADB ?? "adb",
    ["-s", serial, "reverse", "--remove", "tcp:5174"],
    { cwd: root },
  ).catch(() => {});
}
