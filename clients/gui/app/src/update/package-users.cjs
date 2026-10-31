// @ts-check
"use strict";
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { realpath } = require("node:fs/promises");
const { join } = require("node:path");
const { serviceName } = require("../core/desktop-executables.cjs");
const execute = promisify(execFile);

/** @param {string} stdout */
function processes(stdout) {
  return stdout.split("\n").flatMap((line) => {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/.exec(line);
    return match
      ? [
          {
            pid: Number(match[1]),
            parent: Number(match[2]),
            uid: Number(match[3]),
            started: match[4],
            executable: match[5],
          },
        ]
      : [];
  });
}
/** @param {{pid:number,parent:number,uid:number,started:string,executable:string}} child @param {string} database */
async function ownsReporter(child, database) {
  if (child.uid !== process.getuid?.()) return false;
  const options = { maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } };
  try {
    const detail = processes(
      (
        await execute(
          "/bin/ps",
          ["-ww", "-p", String(child.pid), "-o", "pid=,ppid=,uid=,lstart=,args="],
          options,
        )
      ).stdout,
    )[0];
    if (
      !detail ||
      detail.pid !== child.pid ||
      detail.uid !== child.uid ||
      detail.started !== child.started ||
      detail.parent !== child.parent
    )
      return false;
    const command = detail.executable;
    // ps 不提供无损 argv；引号、转义或重复参数不能作为归属证明。
    if (/["'\\\r\n]/.test(command)) return false;
    const markers = [...command.matchAll(/(?:^|\s)--database=/g)];
    if (markers.length !== 1) return false;
    const marker = markers[0];
    const value = command
      .slice(marker.index + marker[0].length)
      .split(/\s--[A-Za-z][\w-]*(?:=|\s|$)/, 1)[0];
    if (!value || (await realpath(value).catch(() => null)) !== database) return false;
    const after = processes(
      (
        await execute(
          "/bin/ps",
          ["-ww", "-p", String(child.pid), "-o", "pid=,ppid=,uid=,lstart=,comm="],
          options,
        )
      ).stdout,
    )[0];
    return (
      !!after &&
      after.pid === child.pid &&
      after.uid === child.uid &&
      after.started === child.started &&
      after.parent === child.parent &&
      after.executable === child.executable
    );
  } catch {
    return false;
  }
}

/** @param {{packaged?:boolean,executable?:string,profile?:string,home?:string}} [options] */
async function assertPackageUsersReleased({
  packaged,
  executable = process.execPath,
  profile,
  home,
} = {}) {
  if (!packaged || process.platform !== "darwin") return;
  const actual = await realpath(executable);
  const boundary = actual.lastIndexOf(".app/Contents/");
  if (boundary < 0) throw new Error("无法核对当前安装包来源");
  const bundle = actual.slice(0, boundary + 4);
  const { stdout } = await execute("/bin/ps", ["-ww", "-axo", "pid=,ppid=,uid=,lstart=,comm="], {
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  const running = processes(stdout);
  if (running.length !== stdout.split("\n").filter((line) => line.trim()).length)
    throw Object.assign(new Error("无法完整核对运行程序信息，请稍后重试安装。"), {
      code: "LIFECYCLE_BLOCKED",
    });
  const current = new Set([process.pid]);
  for (;;) {
    const before = current.size;
    for (const child of running) if (current.has(child.parent)) current.add(child.pid);
    if (current.size === before) break;
  }
  const paths = new Map();
  for (const child of running)
    if (!current.has(child.pid) && child.executable.startsWith("/") && !paths.has(child.executable))
      paths.set(
        child.executable,
        realpath(child.executable).catch(() => null),
      );
  await Promise.all([...paths].map(async ([path, actual]) => paths.set(path, await actual)));
  const unknown = running.filter(
    (child) =>
      !current.has(child.pid) &&
      child.executable.startsWith(bundle + "/") &&
      paths.get(child.executable) === null,
  );
  if (unknown.length)
    throw Object.assign(
      new Error(
        "无法核对部分运行程序的安装来源，请先退出这些程序再重试安装。进程 " +
          unknown.map((child) => child.pid).join("、"),
      ),
      { code: "LIFECYCLE_BLOCKED" },
    );
  const reporters = new Map();
  /** @type {Array<[string, string|undefined]>} */
  const locations = [
    [
      "Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler",
      profile && join(profile, "diagnostics/main-crashes"),
    ],
    [
      "Contents/Frameworks/" +
        serviceName +
        ".app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler",
      home && join(home, "diagnostics/desktop-crashes"),
    ],
  ];
  for (const [relative, directory] of locations) {
    if (!directory || /["'\\\r\n]| --/.test(directory)) continue;
    const [path, database] = await Promise.all([
      realpath(join(bundle, relative)).catch(() => null),
      realpath(directory).catch(() => null),
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
    throw Object.assign(
      new Error(
        "这份安装包仍被其他应用会话或独立 CLI 使用。请从其原配置目录安全退出后重试安装。进程 " +
          blockers.map((child) => child.pid).join("、"),
      ),
      { code: "LIFECYCLE_BLOCKED" },
    );
}
module.exports = { assertPackageUsersReleased };
