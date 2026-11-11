"use strict";
// CLI 自动拉起的 Host 用 setsid 脱离测试进程组，测试结束或 Ctrl-C 都碰不到它；
// 这里在测试进程退出时按临时目录里的 host/host.json 逐个 host stop，停不下再 SIGTERM。
const { execFileSync } = require("node:child_process");
const { readFileSync, readdirSync, readlinkSync } = require("node:fs");
const { mkdtemp } = require("node:fs/promises");
const { dirname, join } = require("node:path");

const roots = new Set();

function trackHostHomes(root) {
  if (roots.size === 0) {
    process.once("exit", stopTrackedHosts);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.once(signal, () => {
        stopTrackedHosts();
        // 脚本自己也监听时让它继续收尾；否则按原信号退出，保持默认语义。
        if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
      });
    }
  }
  roots.add(root);
  return root;
}

// 替代 fs/promises 的 mkdtemp：建出的临时目录在测试退出时会被扫一遍。
async function trackedMkdtemp(prefix, options) {
  return trackHostHomes(await mkdtemp(prefix, options));
}

function stopTrackedHosts() {
  for (const root of roots) {
    for (const descriptor of hostDescriptors(root, 4)) stopHost(descriptor);
  }
}

function hostDescriptors(directory, depth) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.name === "host") {
      try {
        found.push({
          path: join(path, "host.json"),
          ...JSON.parse(readFileSync(join(path, "host.json"), "utf8")),
        });
        continue;
      } catch {}
    }
    if (depth > 0) found.push(...hostDescriptors(path, depth - 1));
  }
  return found;
}

function hostExecutable(pid) {
  try {
    const args = execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
    if (!/\shost run(\s|$)/.test(args)) return null;
    if (process.platform === "linux") return readlinkSync(`/proc/${pid}/exe`);
    return execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function stopHost({ path, pid, generation }) {
  const binary = Number.isInteger(pid) ? hostExecutable(pid) : null;
  if (!binary) return;
  const home = dirname(dirname(path));
  try {
    execFileSync(
      binary,
      ["host", "stop", "--cancel", "--json", "--expected-generation", generation],
      {
        env: { ...process.env, AREAL_HARNESS_HOME: home, AREAL_HARNESS_SERVICE_HOME: home },
        stdio: "ignore",
        timeout: 30_000,
      },
    );
  } catch {
    // 停止请求被拒或超时：Host 没有 SIGTERM 处理，直接退出；它拥有的项目服务读到生命期管道 EOF 后自行清理。
    if (hostExecutable(pid) === binary) process.kill(pid, "SIGTERM");
  }
}

module.exports = { trackedMkdtemp };
