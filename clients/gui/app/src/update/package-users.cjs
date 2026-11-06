// @ts-check
"use strict";
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { realpath, readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { serviceName } = require("../core/desktop-executables.cjs");
const { desktopError } = require("@areal/workbench/desktop-contract");
const execute = promisify(execFile);
const psOptions = { maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } };
/** @param {string} path */
const canonical = (path) => realpath(path).catch(() => null);
/** @param {string} message */
const blocked = (message) => Object.assign(new Error(message), { code: "LIFECYCLE_BLOCKED" });
/** @param {string[]} args */
const processList = (args) =>
  execute("/bin/ps", ["-ww", ...args], psOptions).then(({ stdout }) => stdout);
/** @param {InstanceType<typeof import('../core/service-client.cjs').SharedCoreBackend>} backend */
async function releaseHostForInstall(backend) {
  if (!backend.options.hostHome) return;
  const { HostClient } = require("@areal/client/node");
  const client = new HostClient();
  try {
    try {
      // 安装只连接已存在的本机 Host，不能为退出操作启动新守护进程。
      await client.connect(backend.options.hostHome);
    } catch (error) {
      if (["ENOENT", "ECONNREFUSED"].includes(String(desktopError(error).code))) return;
      throw error;
    }
    const descriptor = JSON.parse(await readFile(join(client.home, "host/host.json"), "utf8"));
    if (
      descriptor.hostId !== client.hostId ||
      descriptor.generation !== client.generation ||
      !Number.isSafeInteger(descriptor.pid) ||
      descriptor.pid <= 1
    )
      throw new Error("Host 进程身份已变化");
    const activity = await client.activity();
    if (
      !activity.complete ||
      activity.totalActiveTasks !== 0 ||
      !activity.projects.every((project) => project.state === "observed" && project.idleAllowed)
    )
      throw new Error("后台仍有活动工作或状态未知，请等待空闲，或从“停止后台”确认取消后重试安装。");
    // Host 在受理时原子重查空闲；不能把观察之后新出现的工作静默取消。
    const result = await backend.requestHostStop({ strategy: "ifIdle" });
    if (!result.stopped || result.operation.phase !== "completed")
      throw Object.assign(new Error("后台停止尚未完成，请检查后台资源后重试安装。"), {
        code: "LIFECYCLE_INCOMPLETE",
        operation: result.operation,
      });
    // completed 回执先于 Host 自身退出，包占用检查必须等待实际进程释放。
    await require("../core/service-client.cjs").waitForProcessExit(descriptor.pid);
  } catch (error) {
    const failure = desktopError(error);
    if (failure.submissionUnknown || failure.code === "LIFECYCLE_INCOMPLETE") throw error;
    throw blocked("无法安全释放更新所需的后台：" + failure.message);
  } finally {
    client.close();
  }
}
/** @param {Parameters<typeof assertPackageUsersReleased>[0] & {backend:InstanceType<typeof import('../core/service-client.cjs').SharedCoreBackend>}} options */
async function releasePackageForInstall({ backend, ...options }) {
  await releaseHostForInstall(backend);
  await assertPackageUsersReleased({ home: backend.home, ...options });
}
/** @param {string} stdout */
function processes(stdout) {
  return stdout.split("\n").flatMap((line) => {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/.exec(line);
    if (!match) return [];
    const [, pid, parent, uid, started, executable] = match;
    return [{ pid: Number(pid), parent: Number(parent), uid: Number(uid), started, executable }];
  });
}
/** @param {ReturnType<typeof processes>[number]|undefined} a @param {ReturnType<typeof processes>[number]} b */
const sameProcess = (a, b) =>
  !!a && a.pid === b.pid && a.uid === b.uid && a.started === b.started && a.parent === b.parent;
/** @param {{pid:number,parent:number,uid:number,started:string,executable:string}} child @param {string} database */
async function ownsReporter(child, database) {
  if (child.uid !== process.getuid?.()) return false;
  try {
    const detail = processes(
      await processList(["-p", String(child.pid), "-o", "pid=,ppid=,uid=,lstart=,args="]),
    )[0];
    if (!sameProcess(detail, child) || !detail) return false;
    const command = detail.executable;
    // ps 不提供无损 argv；引号、转义或重复参数不能作为归属证明。
    if (/["'\\\r\n]/.test(command)) return false;
    const [marker, ...duplicates] = command.matchAll(/(?:^|\s)--database=/g);
    if (!marker || duplicates.length) return false;
    const value = command
      .slice(marker.index + marker[0].length)
      .split(/\s--[A-Za-z][\w-]*(?:=|\s|$)/, 1)[0];
    if (!value || (await canonical(value)) !== database) return false;
    const after = processes(
      await processList(["-p", String(child.pid), "-o", "pid=,ppid=,uid=,lstart=,comm="]),
    )[0];
    return sameProcess(after, child) && after?.executable === child.executable;
  } catch {
    return false;
  }
}
/** @typedef {{packaged?:boolean,executable?:string,profile?:string,home?:string}} PackageOptions */
/** @param {PackageOptions} [options] */
async function assertPackageUsersReleased(options = {}) {
  const { packaged, executable = process.execPath, profile, home } = options;
  if (!packaged || process.platform !== "darwin") return;
  const actual = await realpath(executable);
  const boundary = actual.lastIndexOf(".app/Contents/");
  if (boundary < 0) throw new Error("无法核对当前安装包来源");
  const bundle = actual.slice(0, boundary + 4);
  const stdout = await processList(["-axo", "pid=,ppid=,uid=,lstart=,comm="]);
  const running = processes(stdout);
  if (running.length !== stdout.split("\n").filter((line) => line.trim()).length)
    throw blocked("无法完整核对运行程序信息，请稍后重试安装。");
  const current = new Set([process.pid]);
  for (;;) {
    const before = current.size;
    for (const child of running) if (current.has(child.parent)) current.add(child.pid);
    if (current.size === before) break;
  }
  const paths = new Map();
  for (const child of running)
    if (!current.has(child.pid) && child.executable.startsWith("/") && !paths.has(child.executable))
      paths.set(child.executable, canonical(child.executable));
  await Promise.all([...paths].map(async ([path, actual]) => paths.set(path, await actual)));
  const unknown = running.filter(
    (child) =>
      !current.has(child.pid) &&
      child.executable.startsWith(bundle + "/") &&
      paths.get(child.executable) === null,
  );
  if (unknown.length)
    throw blocked(
      "无法核对部分运行程序的安装来源，请先退出这些程序再重试安装。进程 " +
        unknown.map((child) => child.pid).join("、"),
    );
  const reporters = new Map();
  const reporter = "Electron Framework.framework/Helpers/chrome_crashpad_handler";
  /** @type {Array<[string, string|undefined]>} */
  const locations = [
    ["", profile && join(profile, "diagnostics/main-crashes")],
    [serviceName + ".app/Contents/Frameworks", home && join(home, "diagnostics/desktop-crashes")],
  ];
  for (const [relative, directory] of locations) {
    if (!directory || /["'\\\r\n]| --/.test(directory)) continue;
    const [path, database] = await Promise.all([
      canonical(join(bundle, "Contents/Frameworks", relative, reporter)),
      canonical(directory),
    ]);
    if (path && database) reporters.set(path, database);
  }
  const blockers = [];
  for (const child of running) {
    const path = paths.get(child.executable);
    if (current.has(child.pid) || !path?.startsWith(bundle + "/")) continue;
    const database = reporters.get(path);
    if (database && (await ownsReporter(child, database))) continue;
    blockers.push(child);
  }
  if (blockers.length)
    throw blocked(
      "这份安装包仍被其他应用会话或独立 CLI 使用。请从其原配置目录安全退出后重试安装。进程 " +
        blockers.map((child) => child.pid).join("、"),
    );
}
module.exports = { assertPackageUsersReleased, releasePackageForInstall };
