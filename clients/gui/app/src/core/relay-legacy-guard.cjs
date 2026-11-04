// @ts-check
"use strict";
const { lstat, mkdir, realpath } = require("node:fs/promises");
const { isAbsolute, join } = require("node:path");

/** @param {import('electron').App} app @param {string} coreHome */
async function holdLegacyRelayGuard(app, coreHome) {
  if (!isAbsolute(coreHome)) throw new Error("Legacy Core home must be absolute");
  const home = await realpath(coreHome);
  const lockHome = join(home, ".service-user-data");
  await mkdir(lockHome, { recursive: true, mode: 0o700 });
  const stat = await lstat(lockHome);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (await realpath(lockHome)) !== lockHome
  )
    throw new Error("Invalid legacy Desktop lock directory");
  app.setPath("userData", lockHome);
  if (!app.requestSingleInstanceLock()) throw new Error("Legacy Desktop is running");
  if (process.platform === "darwin") app.setActivationPolicy("prohibited");
  process.stdin.once("end", () => app.exit(0));
  process.stdin.once("error", () => app.exit(1));
  process.stdin.resume();
  process.stdout.write(JSON.stringify({ kind: "ready", coreHome: home, pid: process.pid }) + "\n");
}

module.exports = { holdLegacyRelayGuard };
