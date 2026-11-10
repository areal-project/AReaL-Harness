// @ts-check
"use strict";

const { readFile, mkdir, open, rename, rm } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const {
  inspectOriginalService,
  serviceRequest,
} = require("@areal/workbench-service/desktop/core/local-service.cjs");
const { coreLifecycle, desktopBlockers, blockerMessage, describe } = require("./lifecycle.cjs");
const { desktopError } = require("@areal/workbench/desktop-contract");
const { readServicePacket } = require("@areal/workbench-service/desktop/core/service-state.cjs");
const {
  readRecoveryService,
  readResourceStatus,
} = require("@areal/workbench-service/desktop/core/resource-observation.cjs");
const { record } = require("@areal/workbench-service/desktop/core/service-transport-contract.cjs");
/** @typedef {InstanceType<typeof import('./service-client.cjs').SharedCoreBackend>} Backend */
/** @typedef {{pid:number,identity:string,endpoint:string}} DesktopSource */
/** @typedef {{projectId:string,serviceId:string,generation:string,root:string}} LegacyTarget */
/** @typedef {LegacyTarget & {recoveryPhase:'checked'|'requested'|'clean'}} RecoveryTarget */
/** @typedef {{version:1,id:string,source:DesktopSource,registry:string,targets:RecoveryTarget[],phase:'checking'|'retiring'|'restarting',originalStopReport?:unknown,replacementIdentity?:string}} RecoveryJournal */
/** @param {string} message */
const fail = (message) => Object.assign(new Error(message), { code: "LIFECYCLE_INCOMPLETE" });
/** @param {unknown} a @param {unknown} b */
const sameDesktop = (a, b) =>
  record(a) &&
  record(b) &&
  a.pid === b.pid &&
  a.identity === b.identity &&
  a.endpoint === b.endpoint;
/** @param {number} pid */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (desktopError(e).code === "ESRCH") return false;
    throw e;
  }
};
/** @param {unknown} value @returns {value is string} */
const hexId = (value) => typeof value === "string" && /^[a-f0-9]{24}$/.test(value);
/** @param {unknown} value @returns {value is string} */
const uuid = (value) => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);

/** @param {string} path @param {unknown} value */
async function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    if (process.platform !== "win32") {
      const directory = await open(require("node:path").dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
/** @param {Backend} backend @param {string} registry */
function reader(backend, registry) {
  if (!backend.options.binary) throw fail("Core executable unavailable");
  return {
    binary: backend.options.binary,
    home: backend.home,
    providers: { redact: () => "原 Core 检查或停止失败，请保留记录并检查后台日志" },
    hooks: { environment: () => ({ ...process.env, AREAL_HARNESS_SERVICE_HOME: registry }) },
  };
}
/** @param {Backend} backend @param {DesktopSource} source */
async function sourcePacket(backend, source) {
  /** @type {unknown} */
  const metadata = JSON.parse(await readFile(join(backend.home, "service.json"), "utf8"));
  if (
    !record(metadata) ||
    !backend.metadata ||
    !("token" in backend.metadata) ||
    !backend.connection ||
    !sameDesktop(metadata, source) ||
    !sameDesktop(backend.metadata, source) ||
    metadata.token !== backend.metadata.token ||
    !backend.status.connected
  )
    throw fail("原 Desktop 身份已变化或不可连接；不会停止其他后台");
  const packet = readServicePacket(await backend.connection.request("snapshot"), backend.metadata);
  const service = readRecoveryService(packet.service);
  if (
    packet.service.pid !== source.pid ||
    packet.service.lifecycleVersion !== 1 ||
    service.lifecycle?.version === 2
  )
    throw fail("原 Desktop 协议或身份不匹配，恢复记录已保留");
  return { ...packet, service };
}
/** @param {Awaited<ReturnType<typeof sourcePacket>>} packet @returns {LegacyTarget[]} */
function targetsFrom(packet) {
  const report = packet.service.stopReport;
  if (
    !record(report) ||
    report.phase !== "incomplete" ||
    !Array.isArray(report.projects) ||
    !Array.isArray(packet.service.targets)
  )
    throw fail("旧停止目标不完整，无法确认原工作空间范围");
  /** @type {Map<string,LegacyTarget>} */
  const targets = new Map();
  for (const target of [
    ...report.projects,
    ...packet.service.targets.filter((t) => t.serviceId != null),
  ]) {
    if (
      !record(target) ||
      !hexId(target.projectId) ||
      !hexId(target.serviceId) ||
      !uuid(target.generation)
    )
      throw fail("旧停止目标身份不完整");
    const root = packet.snapshot.projects.find((p) => p.id === target.projectId)?.root;
    if (typeof root !== "string" || !require("node:path").isAbsolute(root))
      throw fail("原工作空间登记不可用");
    const value = {
      projectId: target.projectId,
      serviceId: target.serviceId,
      generation: target.generation,
      root,
    };
    if (targets.has(target.projectId) && !isDeepStrictEqual(targets.get(target.projectId), value))
      throw fail("原工作空间出现不同的 Core 代际");
    targets.set(target.projectId, value);
  }
  if (!targets.size) throw fail("没有可核查的原 Core 目标");
  return [...targets.values()].sort((a, b) => a.projectId.localeCompare(b.projectId));
}
/** @param {unknown} journal @param {Backend} backend @returns {RecoveryJournal} */
function validateJournal(journal, backend) {
  if (!recoveryJournal(journal) || journal.registry !== resolve(backend.options.harnessHome ?? ""))
    throw fail("旧后台恢复记录或服务登记目录不匹配，请保留记录并核对");
  return journal;
}
/** @param {unknown} value @returns {value is DesktopSource} */
function desktopSource(value) {
  return (
    record(value) &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 1 &&
    typeof value.identity === "string" &&
    typeof value.endpoint === "string"
  );
}
/** @param {unknown} value @returns {value is RecoveryTarget} */
function recoveryTarget(value) {
  return (
    record(value) &&
    hexId(value.projectId) &&
    hexId(value.serviceId) &&
    uuid(value.generation) &&
    typeof value.root === "string" &&
    require("node:path").isAbsolute(value.root) &&
    ["checked", "requested", "clean"].some((phase) => phase === value.recoveryPhase)
  );
}
/** @param {unknown} value @returns {value is RecoveryJournal} */
function recoveryJournal(value) {
  return (
    record(value) &&
    value.version === 1 &&
    uuid(value.id) &&
    desktopSource(value.source) &&
    typeof value.registry === "string" &&
    Array.isArray(value.targets) &&
    value.targets.length > 0 &&
    value.targets.every(recoveryTarget) &&
    new Set(value.targets.map((target) => target.projectId)).size === value.targets.length &&
    ["checking", "retiring", "restarting"].some((phase) => phase === value.phase) &&
    (value.replacementIdentity === undefined || typeof value.replacementIdentity === "string")
  );
}
/** @param {Backend} backend */
async function inspect(backend) {
  const control = backend.legacyControl;
  let journal = control?.legacyRecovery
    ? validateJournal(control.legacyRecovery, backend)
    : undefined;
  const selected = journal?.source ?? backend.metadata;
  if (!selected || !("endpoint" in selected) || typeof selected.endpoint !== "string")
    throw fail("原外部 Desktop 身份不可用");
  const source = { pid: selected.pid, identity: selected.identity, endpoint: selected.endpoint };
  const projects = [],
    blockers = [];
  let packet;
  const exited = !alive(source.pid);
  // A replacement started before the GUI closed may be attached, but only the
  // journal's exact replacement is accepted. It is never mistaken for the old owner.
  const replacement =
    journal?.phase === "restarting" &&
    exited &&
    backend.status.connected &&
    backend.metadata?.identity === journal.replacementIdentity &&
    backend.status.lifecycle?.version === 2;
  if (!exited) {
    packet = await sourcePacket(backend, source);
    if (control?.pid && control.pid !== source.pid) throw fail("旧停止记录与当前 Desktop 不匹配");
    const currentTargets = targetsFrom(packet);
    if (
      journal &&
      !isDeepStrictEqual(
        currentTargets,
        journal.targets.map(({ recoveryPhase: _recoveryPhase, ...t }) => t),
      )
    )
      throw fail("原工作空间范围或代际已变化，请重新核对；不会停止替代实例");
    const desktop = desktopBlockers(packet.service);
    if (desktop.length) blockers.push(blockerMessage(desktop));
    if (!backend.options.harnessHome) throw fail("原 Core 服务登记目录不可用");
    if (!journal)
      journal = {
        version: 1,
        id: randomUUID(),
        phase: "checking",
        registry: resolve(backend.options.harnessHome),
        source: { pid: source.pid, identity: source.identity, endpoint: source.endpoint },
        originalStopReport: packet.service.stopReport,
        targets: currentTargets.map((t) => ({ ...t, recoveryPhase: "checked" })),
      };
  } else if (!journal) throw fail("缺少原停止目标，不能仅凭旧 PID 消失恢复");
  if (!replacement)
    for (const target of journal.targets) {
      let state = "unknown",
        message;
      try {
        const result = await inspectOriginalService(reader(backend, journal.registry), target);
        if (result.cleanupConfirmed) {
          state = "clean";
          message = "原 Host 已确认清理，实例锁和历史锁已释放";
        } else if (result.status) {
          const status = readResourceStatus(result.status);
          const lifecycle = coreLifecycle(status);
          const unknown = (status.unresolvedTools?.length ?? 0) > 0;
          if (
            target.recoveryPhase !== "requested" &&
            lifecycle.admission === "open" &&
            lifecycle.ifIdle.allowed &&
            lifecycle.settled.allowed
          ) {
            state = "idle";
            message =
              "已核对原实例：准入开放，当前空闲；可以发起新的安全停止" +
              (unknown ? "。历史工具结果仍未知，原记录保留，仍需在原对话核查" : "");
          } else
            message = unknown
              ? "工具执行结果仍未知，请在原对话核查"
              : target.recoveryPhase === "requested"
                ? "本次停止结果仍未确认；只核查原实例，不会重发"
                : `仍有待处理事项：${describe([{ lifecycle }]) || "准入或资源结算尚未确认"}`;
        } else message = "原 Host 尚未确认清理；进程退出或连接断开不足以证明完成";
      } catch (error) {
        message =
          desktopError(error).code === "CONFIRMATION_STALE"
            ? desktopError(error).message
            : "无法核对原 Core；请检查其服务日志后重试";
      }
      projects.push({ projectId: target.projectId, root: target.root, state, message });
      if (!["clean", "idle"].includes(state)) blockers.push(`${target.root}：${message}`);
    }
  if (exited && !replacement && projects.some((p) => p.state !== "clean"))
    blockers.push("原 Desktop 已退出，必须先确认全部原 Host 清理完成");
  const canRecover = blockers.length === 0;
  const view = {
    canRecover,
    projects,
    message: canRecover
      ? "原后台检查通过，可以恢复原工作空间。配置和历史将保留。"
      : `恢复暂被阻止。${blockers.join("；")}`,
  };
  backend.legacyRecoveryView = view;
  backend.onChange();
  return { journal, packet, exited, replacement, view };
}
/** @param {Backend} backend @param {RecoveryJournal} journal */
async function persist(backend, journal) {
  backend.legacyControl = {
    ...backend.legacyControl,
    home: backend.home,
    state: "unconfirmed",
    pid: journal.source.pid,
    legacyRecovery: journal,
  };
  await mkdir(backend.app.getPath("userData"), { recursive: true, mode: 0o700 });
  await save(backend.controlPath, backend.legacyControl);
}
/** @param {Backend} backend @param {import("@areal/workbench-service/desktop/core/resource-recovery.cjs").Notify} notify */
async function recover(backend, notify) {
  const observed = await inspect(backend);
  const detail = observed.view.projects.map((p) => `${p.root}\n${p.message}`).join("\n\n");
  if (!observed.view.canRecover) {
    await notify({
      type: "info",
      message: "后台尚不能恢复",
      detail: observed.view.message + "\n\n" + detail,
      buttons: ["确定"],
    });
    return { recovered: false };
  }
  const answer = await notify({
    type: "question",
    message: "恢复原工作空间的后台？",
    detail:
      "将安全停止已核对为空闲的原 Core，等待清理后退出旧 Desktop，再启动当前版本。模型配置、工作空间和历史保留；不会重发消息或恢复未知执行。\n\n" +
      detail,
    buttons: ["返回", "恢复后台"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (answer.response !== 1) return { recovered: false, canceled: true };
  const fresh = await inspect(backend);
  if (
    !fresh.view.canRecover ||
    !isDeepStrictEqual(observed.journal.source, fresh.journal.source) ||
    !isDeepStrictEqual(observed.view.projects, fresh.view.projects)
  )
    throw fail("确认期间后台状态已变化，请重新检查");
  const journal = fresh.journal;
  await persist(backend, journal);
  backend.reconnectBlocked = true;
  backend.clearReconnect();
  for (const target of journal.targets) {
    if (
      fresh.view.projects.find((p) => p.projectId === target.projectId)?.state === "clean" ||
      fresh.replacement
    )
      continue;
    target.recoveryPhase = "requested";
    await persist(backend, journal);
    // New, explicit ifIdle intent, bound to the observed original generation.
    // Never replay either the old unknown operation or this one after a lost reply.
    try {
      await serviceRequest(reader(backend, journal.registry), [
        "stop",
        "--instance",
        target.serviceId,
        "--expected-generation",
        target.generation,
      ]);
    } catch (error) {
      if (desktopError(error).code === "CORE_BUSY") {
        target.recoveryPhase = "checked";
        await persist(backend, journal);
      }
      throw error;
    }
    const checked = await inspectOriginalService(reader(backend, journal.registry), target);
    if (!checked.cleanupConfirmed) throw fail("原 Host 未确认清理，本次停止记录已保留；不会重发");
    target.recoveryPhase = "clean";
    await persist(backend, journal);
  }
  if (!fresh.exited) {
    const settled = await inspect(backend);
    if (!settled.view.canRecover || settled.view.projects.some((p) => p.state !== "clean"))
      throw fail("尚有未确认的原 Host，不能退出旧 Desktop");
    const packet = await sourcePacket(backend, journal.source);
    if (desktopBlockers(packet.service).length) throw fail("原 Desktop 仍有活动请求，请重新检查");
    // All original Hosts have independently confirmed cleanup. Retire only the
    // authenticated original Desktop manager: never signal a Core/Runtime or a
    // historical PID without a matching private descriptor and live handshake.
    journal.phase = "retiring";
    await persist(backend, journal);
    await sourcePacket(backend, journal.source);
    try {
      process.kill(journal.source.pid, "SIGTERM");
    } catch (e) {
      if (desktopError(e).code !== "ESRCH") throw e;
    }
    const deadline = Date.now() + 3000;
    while (alive(journal.source.pid) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (alive(journal.source.pid)) {
      // Some historical Electron managers prevent normal application quit.
      // Core/Runtime ownership is already settled, but ending the Desktop
      // manager still requires a separate, explicit user decision.
      const answer = await notify({
        type: "warning",
        message: "旧后台未响应退出",
        detail:
          "所有工作空间后台均已确认清理完成。是否结束这个旧界面后台进程并恢复？配置与历史保留，不会结束其他后台或重发任务。",
        buttons: ["返回", "结束旧后台并恢复"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1) return { recovered: false, canceled: true };
      const checked = await inspect(backend);
      if (!checked.view.canRecover || checked.view.projects.some((p) => p.state !== "clean"))
        throw fail("后台状态已变化，不能结束旧界面后台");
      const last = await sourcePacket(backend, journal.source);
      if (desktopBlockers(last.service).length) throw fail("原界面后台又有活动操作，请重新检查");
      process.kill(journal.source.pid, "SIGKILL");
    }
    await require("./service-client.cjs").waitForProcessExit(journal.source.pid);
  }
  // A force-ended legacy manager cannot remove its own private descriptor.
  // Remove only the authenticated original's descriptor, after process exit.
  try {
    const path = join(backend.home, "service.json");
    /** @type {unknown} */
    const current = JSON.parse(await readFile(path, "utf8"));
    if (sameDesktop(current, journal.source)) {
      if (alive(journal.source.pid)) throw fail("原界面后台仍未退出");
      await rm(path);
    } else if (!fresh.replacement) throw fail("后台描述已换代，不能替换其他后台");
  } catch (error) {
    if (desktopError(error).code !== "ENOENT") throw error;
  }
  journal.phase = "restarting";
  if (!backend.options.binary) throw fail("Core executable unavailable");
  journal.replacementIdentity ??= await require("./service-config.cjs").serviceIdentity({
    ...backend.options,
    binary: backend.options.binary,
  });
  await persist(backend, journal);
  backend.connection?.close();
  backend.connection = null;
  backend.status = { connected: false };
  await backend.initialize();
  if (
    backend.metadata?.identity !== journal.replacementIdentity ||
    backend.status.lifecycle?.version !== 2
  )
    throw fail("替代后台身份尚未确认，恢复记录已保留");
  await save(join(backend.app.getPath("userData"), `legacy-recovery-${journal.id}.json`), {
    ...backend.legacyControl,
    recovered: true,
  });
  await rm(backend.controlPath);
  backend.legacyControl = null;
  backend.legacyRecoveryView = null;
  backend.lifecycleError = null;
  backend.controlState = null;
  backend.reconnectBlocked = false;
  backend.backendUpdate = undefined;
  backend.onChange();
  return { recovered: true };
}
module.exports = { inspect, recover };
