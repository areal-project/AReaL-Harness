// @ts-check
"use strict";
const { createHash, randomUUID } = require("node:crypto");
const { createReadStream, constants } = require("node:fs");
const { open, link, unlink, realpath, readdir, readFile, rename } = require("node:fs/promises");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { executeHost } = require("./host-client.cjs");
/** @typedef {{version:1,requestId:string,hostId:string,generation:string,pid:number,targetDigest:string,targetIdentity:string,phase:'stopping'|'starting'|'checking'}} Upgrade */
/** @typedef {{dispatch:string,requestId:string,serviceGeneration:string,receipt?:{state:string,requestId:string,serviceGeneration:string}}} StopTarget */
/** @typedef {{requestId:string,hostId:string,generation:string,strategy:string,state:string,projects:StopTarget[]}} Receipt */
/** @param {unknown} error @param {string} code */
const hasCode = (error, code) => error instanceof Error && "code" in error && error.code === code;

/** @param {string} path */
async function readPrivate(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error("应用交接记录权限无效");
    return JSON.parse(await file.readFile("utf8"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  } finally {
    await file?.close();
  }
}

/** @param {string} binary */
async function digest(binary) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(binary)) hash.update(chunk);
  return hash.digest("hex");
}

/** @param {string} path @param {unknown} value @param {boolean} [replace] */
async function publish(path, value, replace = false) {
  const temporary = `${path}.${randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    if (replace) await rename(temporary, path);
    else await link(temporary, path);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  } finally {
    await unlink(temporary).catch((error) => {
      if (!hasCode(error, "ENOENT")) throw error;
    });
  }
}

/** @param {string} serviceIdentity @param {string[]} roots */
async function desktopBuildIdentity(serviceIdentity, roots) {
  const hash = createHash("sha256").update(serviceIdentity);
  /** @param {string} directory */
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      hash.update(entry.name);
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) hash.update(await readFile(path));
      else throw new Error("应用构建包含不支持的文件");
    }
  }
  for (const root of roots) await visit(root);
  return hash.digest("hex");
}

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasCode(error, "ESRCH")) return false;
    throw error;
  }
}

/** @param {Upgrade} record @param {Receipt} receipt */
function validateReceipt(record, receipt) {
  if (
    receipt?.requestId !== record.requestId ||
    receipt.hostId !== record.hostId ||
    receipt.generation !== record.generation ||
    receipt.strategy !== "cancel" ||
    !Array.isArray(receipt.projects)
  )
    throw new Error("应用交接回执与原操作不一致");
  if (
    receipt.state === "completed" &&
    !receipt.projects.every(
      (item) =>
        item.dispatch === "started" &&
        item.receipt?.state === "completed" &&
        item.receipt.requestId === item.requestId &&
        item.receipt.serviceGeneration === item.serviceGeneration,
    )
  )
    throw new Error("应用交接尚未确认所有项目停止");
  return receipt;
}

/**
 * 桌面单实例持有者在接入业务前调用；同一次交接跨应用重启复用原停止回执。
 * @param {InstanceType<typeof import("./host-client.cjs").HostClient>} client
 * @param {{home:string,binary:string,serviceIdentity:string,buildIdentity:string,closed?:()=>boolean}} options
 */
async function ensureDesktopHost(client, options) {
  const binary = await realpath(options.binary);
  const targetDigest = await digest(binary);
  const environment = {
    ...Object.fromEntries(
      ["HOME", "PATH", "TMPDIR", "LANG"].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]]] : [],
      ),
    ),
    AREAL_HARNESS_HOME: options.home,
    AREAL_HARNESS_SERVICE_HOME: options.home,
  };
  const { stdout } = await executeHost(binary, ["--version"], {
    env: environment,
    timeout: 10000,
  });
  const version = stdout.trim().replace(/^areal /, "");
  const order = (/** @type {string} */ value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(value);
    if (!match) throw new Error("无法确认应用版本");
    return [
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      match[4] ? 0 : 1,
      Number(match[4] ?? 0),
    ];
  };
  const targetOrder = order(version);
  const checkOpen = () => {
    if (options.closed?.()) throw new Error("应用连接已关闭，交接将在下次启动继续");
  };
  const path = join(options.home, "host", "desktop-upgrade.json");
  const activePath = join(options.home, "host", "desktop-build.json");
  /** @type {Upgrade|null} */ let record = await readPrivate(path);
  if (
    record &&
    (record.version !== 1 ||
      !/^[a-f0-9-]{36}$/i.test(record.requestId) ||
      typeof record.hostId !== "string" ||
      typeof record.generation !== "string" ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      !["stopping", "starting", "checking"].includes(record.phase) ||
      typeof record.targetDigest !== "string" ||
      !/^[a-f0-9]{64}$/i.test(record.targetDigest) ||
      typeof record.targetIdentity !== "string" ||
      !record.targetIdentity)
  )
    throw new Error("应用交接记录无效");
  const complete = async () => {
    if (!client.identity || client.hello?.executableDigest !== targetDigest)
      throw new Error("应用启动身份尚未确认");
    await publish(
      activePath,
      {
        generation: client.generation,
        identity: options.buildIdentity,
      },
      true,
    );
    if (record) await unlink(path);
  };

  for (;;) {
    checkOpen();
    if (record) {
      // 读取原回执；没有回执不能改 ID 重发。尚未派发的同 ID 请求由 Host 去重。
      /** @type {Receipt|undefined} */ let receipt;
      try {
        if (!client.socket) await client.connect(options.home);
        if (client.generation === record.generation) {
          receipt = (await client.operation(record.requestId)).operation;
          if (!receipt) receipt = await client.stop(record.requestId, record.generation, "cancel");
        }
      } catch {
        client.close();
      }
      if (!receipt) {
        const result = await executeHost(
          binary,
          ["host", "operation", record.requestId, "--json"],
          {
            env: environment,
            timeout: 10000,
          },
        );
        receipt = JSON.parse(result.stdout).operation;
      }
      if (!receipt) throw new Error("应用交接结果尚未确认，请重新打开应用继续恢复");
      validateReceipt(record, receipt);
      if (["blocked", "partial", "settlementIncomplete"].includes(receipt.state))
        throw new Error("应用交接尚未完成，原交接记录已保留，请重新打开应用继续恢复");
      if (receipt.state !== "completed") {
        await delay(500);
        continue;
      }
      client.close();
      const deadline = Date.now() + 30000;
      while (alive(record.pid)) {
        checkOpen();
        if (Date.now() >= deadline)
          throw new Error("应用正在完成退出，请稍后重新打开；原交接记录已保留");
        await delay(100);
      }
      record.phase = "starting";
      await publish(path, record, true);
      // 新 Host 获得原独占锁后才能发布身份；不删除锁或发现文件。
      checkOpen();
      if (!client.socket) await client.connectOrStart(options.home, binary);
      if (
        record.targetDigest !== targetDigest ||
        record.targetIdentity !== options.buildIdentity ||
        client.hello?.executableDigest !== targetDigest
      ) {
        // 原停止已结算；重装或其他客户端可能改变目标，交回正常身份检查，不能改绑原请求。
        await unlink(path);
        record = null;
        continue;
      }
      record.phase = "checking";
      await publish(path, record, true);
      return complete;
    } else {
      if (!client.socket) await client.connectOrStart(options.home, binary);
    }
    if (!client.hello || !client.identity) throw new Error("无法确认应用后台身份");
    const runningOrder = order(client.hello.executableVersion);
    const different = targetOrder.findIndex((part, i) => part !== runningOrder[i]);
    if (different >= 0 && targetOrder[different] < runningOrder[different])
      throw new Error("已有更新版本正在运行，请打开新版应用");
    const backend = await client.request("backend.status", {});
    const active = await readPrivate(activePath);
    if (
      client.hello.executableDigest === targetDigest &&
      (!backend.owned || backend.service?.identity === options.serviceIdentity) &&
      (!active ||
        active.generation !== client.generation ||
        active.identity === options.buildIdentity)
    )
      return complete;
    if ((await digest(binary)) !== targetDigest)
      throw new Error("应用文件在准备期间发生变化，请重新打开应用");
    record = {
      version: 1,
      requestId: randomUUID(),
      hostId: client.hostId,
      generation: client.generation,
      pid: client.identity.pid,
      targetDigest,
      targetIdentity: options.buildIdentity,
      phase: "stopping",
    };
    await publish(path, record);
    record = await readPrivate(path);
  }
}

module.exports = { ensureDesktopHost, desktopBuildIdentity };
