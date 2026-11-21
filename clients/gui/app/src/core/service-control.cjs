// @ts-check
"use strict";
const { hostReference } = require("./host-lifecycle.cjs");
const { isDeepStrictEqual } = require("node:util");
const { KINDS, isLifecycleReceipt } = require("@areal/workbench/desktop-contract/shared");
/** @typedef {import('@areal/workbench/desktop-contract/shared').LifecycleKind} Kind */
/** @typedef {import('@areal/workbench/desktop-contract/shared').LifecycleMode} Mode */
/** @typedef {{projectId:string,serviceId:string|null,generation:string|null,phase?:import('@areal/workbench/desktop-contract/shared').TargetPhase,error?:unknown}} ReferenceTarget */
/** @typedef {{pid:number,identity:string}} DesktopIdentity */
/** @typedef {{requestId:string,desktopGeneration:string,kind:Kind,mode:Mode,targets:ReferenceTarget[],desktop:DesktopIdentity,threadId?:string,turnId?:string,logicalProjectId?:string}} LifecycleReference */
/** @typedef {import('@areal/workbench/desktop-contract/shared').LifecycleReceipt} LifecycleResponse */

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is string} */
function uuid(value) {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
  );
}
/** @param {unknown} value @returns {value is Kind} */
function kind(value) {
  return KINDS.some((kind) => kind === value);
}
/** @param {unknown} value @returns {value is ReferenceTarget} */
function referenceTarget(value) {
  return (
    record(value) &&
    typeof value.projectId === "string" &&
    (value.serviceId === null || typeof value.serviceId === "string") &&
    (value.generation === null || typeof value.generation === "string") &&
    (value.phase === undefined ||
      [
        "notAttempted",
        "acceptedPending",
        "blocked",
        "admissionUnconfirmed",
        "settlementIncomplete",
        "completed",
      ].some((phase) => value.phase === phase))
  );
}
/** @param {unknown} value @returns {value is LifecycleReference} */
function reference(value) {
  return (
    record(value) &&
    uuid(value.requestId) &&
    uuid(value.desktopGeneration) &&
    kind(value.kind) &&
    (value.mode === "ifIdle" || value.mode === "cancel") &&
    Array.isArray(value.targets) &&
    value.targets.every(referenceTarget) &&
    record(value.desktop) &&
    typeof value.desktop.pid === "number" &&
    Number.isSafeInteger(value.desktop.pid) &&
    value.desktop.pid > 1 &&
    typeof value.desktop.identity === "string" &&
    ["threadId", "turnId", "logicalProjectId"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    ) &&
    (value.kind !== "interruptTurn" ||
      (typeof value.threadId === "string" && typeof value.turnId === "string"))
  );
}
/** @param {unknown} value @returns {(LifecycleReference|import("./host-lifecycle.cjs").HostReference)[]} */
function readReferences(value) {
  if (!Array.isArray(value) || !value.every((item) => reference(item) || hostReference(item)))
    throw Object.assign(new Error("后台操作引用损坏，请保留记录并检查原后台"), {
      code: "LIFECYCLE_REFERENCE_INVALID",
    });
  return value;
}
/** @param {LifecycleReference} reference @param {unknown} value @returns {value is LifecycleResponse} */
function lifecycleResponse(reference, value) {
  return (
    isLifecycleReceipt(value) &&
    value.requestId === reference.requestId &&
    value.desktopGeneration === reference.desktopGeneration &&
    value.kind === reference.kind &&
    value.mode === reference.mode &&
    isDeepStrictEqual(
      value.targets
        .map(({ projectId, serviceId, generation }) => ({ projectId, serviceId, generation }))
        .sort((a, b) => a.projectId.localeCompare(b.projectId)),
      reference.targets,
    ) &&
    (reference.kind !== "interruptTurn" ||
      (value.threadId === reference.threadId && value.turnId === reference.turnId))
  );
}
/** @param {LifecycleReference} reference @param {unknown} value @returns {LifecycleResponse} */
function readLifecycleResponse(reference, value) {
  if (!lifecycleResponse(reference, value))
    throw Object.assign(new Error("后台回执与原操作身份不一致"), {
      code: "LIFECYCLE_RECEIPT_INVALID",
      submissionUnknown: true,
    });
  return value;
}

const { lstat, mkdir, open, rename, rm } = require("node:fs/promises");
const { constants } = require("node:fs");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { HostClient } = require("@areal/client/node");
const { hostUpdateReceipt } = require("@areal/workbench/desktop-contract/desktop-control");
const { commandSemantics, desktopError } = require("@areal/workbench/desktop-contract");
const { projectHostReceipt } = require("./host-lifecycle.cjs");
/** @typedef {InstanceType<typeof import('./service-client.cjs').SharedCoreBackend>} Backend */
/** @typedef {import('./service-control.cjs').LifecycleReference} Reference */
/** @typedef {import('./service-control.cjs').LifecycleResponse} Receipt */
/** @param {unknown} kind */
const desktopKind = (kind) => kind === "stopDesktop" || kind === "updateDesktop";
const originalDesktopMessage =
  "旧停止记录缺少可核查的操作身份。请在原版本检查并结束后台，再打开当前版本。";
/** @param {Pick<import("./service-control.cjs").LifecycleResponse,"phase"|"targets"> & {desktopExit?:unknown}} operation */
const needsOriginalCheck = (operation) =>
  operation.phase === "admissionUnconfirmed" ||
  (operation.phase === "acceptedPending" && operation.desktopExit === "requested") ||
  operation.targets.some((target) =>
    ["notAttempted", "acceptedPending", "admissionUnconfirmed"].includes(target.phase),
  );
/** @param {string} phase */
const lifecycleMessage = (phase) =>
  /** @type {Record<string,string>} */ ({
    acceptedPending: "请求已受理，后台仍在完成退出和清理。",
    blocked: "后台明确拒绝了此次操作，原任务仍可继续使用。",
    admissionUnconfirmed: "原请求是否受理尚未确认，请检查原请求；不会自动重发。",
    settlementIncomplete: "请求已受理，部分资源尚未完成清理。",
    partial: "部分后台已完成，仍有目标需要检查。",
    completed: "后台操作已完成。",
  })[phase];

/** @this {Backend} */
function lifecycleProjection() {
  /** @type {Map<string,Receipt|Reference>} */
  const visible = new Map(this.lifecycleReceipts);
  for (const [requestId, reference] of this.lifecycleReferences) visible.set(requestId, reference);
  /** @type {import('@areal/workbench/desktop-contract/shared').LifecycleViewOperation[]} */
  const operations = [...visible.values()].map((reference) => {
    const receipt = this.lifecycleReceipts.get(reference.requestId);
    return {
      requestId: reference.requestId,
      kind: reference.kind,
      phase: receipt?.phase ?? "admissionUnconfirmed",
      targets: (receipt?.targets ?? reference.targets).map((target) => ({
        projectId: reference.logicalProjectId ?? target.projectId,
        phase: target.phase ?? "admissionUnconfirmed",
        ...(target.error
          ? {
              message:
                typeof target.error === "string"
                  ? target.error
                  : desktopError(target.error).message,
            }
          : {}),
      })),
      ...(reference.threadId ? { threadId: reference.threadId, turnId: reference.turnId } : {}),
      ...(receipt?.desktopExit ? { desktopExit: receipt.desktopExit } : {}),
      message:
        receipt?.message ??
        (receipt?.desktopError ? desktopError(receipt.desktopError).message : undefined) ??
        lifecycleMessage(receipt?.phase ?? "admissionUnconfirmed"),
    };
  });
  for (const reference of this.hostReferences.values())
    operations.push(projectHostReceipt(reference, this.hostReceipts.get(reference.requestId)));
  const latest = operations.at(-1);
  const legacy =
    this.unidentifiedStop || (this.status.stopReport && this.status.lifecycle?.version !== 2);
  return {
    supported: this.status.lifecycle?.version === 2,
    operations,
    ...(legacy
      ? {
          recovery: {
            canRecover: false,
            projects: [],
            message: originalDesktopMessage,
          },
        }
      : {}),
    ...((latest ?? legacy)
      ? (latest ?? {
          phase: "admissionUnconfirmed",
          targets: [],
          message: originalDesktopMessage,
        })
      : {}),
    ...(this.lifecycleError ? { error: this.lifecycleError, message: this.lifecycleError } : {}),
  };
}

/** @this {Backend} */
async function persistReferences() {
  const write = async () => {
    if (this.unidentifiedStop)
      throw Object.assign(new Error(originalDesktopMessage), { code: "LIFECYCLE_INCOMPLETE" });
    await mkdir(this.app.getPath("userData"), { recursive: true, mode: 0o700 });
    if (!this.lifecycleReferences.size && !this.hostReferences.size && !this.hostUpdateReference) {
      await rm(this.controlPath, { force: true });
      return;
    }
    const temporary = `${this.controlPath}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(
          JSON.stringify({
            version: 3,
            home: this.home,
            references: [...this.lifecycleReferences.values(), ...this.hostReferences.values()],
            hostUpdate: this.hostUpdateReference,
          }),
        );
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.controlPath);
      if (process.platform !== "win32") {
        const directory = await open(this.app.getPath("userData"), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  };
  const pending = (this.referenceWrite ?? Promise.resolve()).catch(() => {}).then(write);
  this.referenceWrite = pending;
  return pending;
}

/** @this {Backend}  @param {Record<string,unknown>|null} control */
function loadReferences(control) {
  this.unidentifiedStop = control?.state === "unconfirmed";
  if (control?.version === 2 || control?.version === 3) {
    if (control.hostUpdate != null) {
      const update = control.hostUpdate;
      if (
        !record(update) ||
        !["requestId", "hostId", "generation", "targetVersion"].every(
          (key) => typeof update[key] === "string",
        ) ||
        !["prepare", "apply"].includes(String(update.action))
      )
        throw new Error("保存的升级请求引用无效，请保留原记录并检查");
      this.hostUpdateReference = /** @type {NonNullable<Backend['hostUpdateReference']>} */ (
        update
      );
    }
    for (const reference of readReferences(control.references)) {
      if (hostReference(reference)) this.hostReferences.set(reference.requestId, reference);
      else this.lifecycleReferences.set(reference.requestId, reference);
    }
    this.controlState = null;
  } else if (control?.state === "unconfirmed") {
    this.controlState = null;
  } else this.controlState = control?.state ?? null;
}

/** @param {string} home @param {Reference} reference */
async function readOfflineDesktopReceipt(home, reference) {
  if (!uuid(reference.requestId)) throw new Error("原后台操作身份无效");
  const directory = join(home, "lifecycle-operations");
  try {
    const owner = process.geteuid?.();
    const dir = await lstat(directory);
    if (!dir.isDirectory() || (owner !== undefined && dir.uid !== owner))
      throw new Error("原后台回执目录不属于当前用户");
    const file = await open(
      join(directory, reference.requestId + ".json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (owner !== undefined && stat.uid !== owner))
        throw new Error("原后台回执不属于当前用户");
      return readLifecycleResponse(reference, JSON.parse(await file.readFile("utf8")));
    } finally {
      await file.close();
    }
  } catch (error) {
    if (desktopError(error).code === "ENOENT") return null;
    throw error;
  }
}

/** @this {Backend}  @param {Reference} reference @param {boolean} [reconcile] @returns {Promise<Receipt>} */
async function readLifecycle(reference, reconcile = true) {
  let receipt;
  const native = this.nativeBrowserEpoch;
  const profile = this.options.guiProfile;
  if (native) {
    const source = this.nativeBrowserSource;
    receipt = await this.nativeBrowserCall("lifecycle.read", {
      sourceId: source,
      operation: reconcile ? "reconcile" : "read",
      requestId: reference.requestId,
      desktopGeneration: reference.desktopGeneration,
    });
    if (this.disposed || this.nativeBrowserEpoch !== native || this.nativeBrowserSource !== source)
      throw Object.assign(new Error("Original native lifecycle source changed"), {
        code: "RESYNC_REQUIRED",
      });
  } else if (profile && this.options.hostHome) {
    const host = new HostClient();
    let connected = false;
    try {
      await host.connect(this.options.hostHome);
      connected = true;
      receipt = await host.request("lifecycle.read", {
        profile,
        operation: reconcile ? "reconcile" : "read",
        requestId: reference.requestId,
        desktopGeneration: reference.desktopGeneration,
      });
    } catch (error) {
      if (connected || !["ENOENT", "ECONNREFUSED"].includes(String(desktopError(error).code)))
        throw error;
      // 只读取原来源的持久回执，离线时不推断未结算目标。
      receipt = await readOfflineDesktopReceipt(this.home, reference);
    } finally {
      host.close();
    }
    if (this.disposed || this.nativeBrowserEpoch || profile !== this.options.guiProfile)
      throw Object.assign(new Error("Original lifecycle source changed"), {
        code: "RESYNC_REQUIRED",
      });
  } else {
    receipt = await readOfflineDesktopReceipt(this.home, reference);
  }
  if (!receipt)
    receipt = {
      version: 1,
      requestId: reference.requestId,
      kind: reference.kind,
      mode: reference.mode,
      desktopGeneration: reference.desktopGeneration,
      desktopExit: "notRequested",
      ...(reference.threadId ? { threadId: reference.threadId, turnId: reference.turnId } : {}),
      phase: "admissionUnconfirmed",
      targets: reference.targets.map((target) => ({
        ...target,
        phase: "admissionUnconfirmed",
      })),
    };
  return this.acceptLifecycleReceipt(reference, receipt);
}

/** @this {Backend}  @param {import('./service-control.cjs').LifecycleReference} reference @param {unknown} value @returns {Promise<Receipt>} */
async function acceptLifecycleReceipt(reference, value) {
  const receipt = readLifecycleResponse(reference, value);
  /** @type {Receipt} */
  let operation =
    desktopKind(reference.kind) && receipt.phase === "completed"
      ? { ...receipt, phase: "acceptedPending" }
      : receipt;
  if (
    desktopKind(reference.kind) &&
    ["acceptedPending", "settlementIncomplete", "completed"].includes(receipt.phase) &&
    receipt.targets.every((target) => target.phase === "completed")
  ) {
    let exited = false;
    try {
      process.kill(reference.desktop.pid, 0);
    } catch (error) {
      if (desktopError(error).code === "ESRCH") exited = true;
      else throw error;
    }
    if (!exited && receipt.desktopExit === "requested") {
      try {
        await require("./service-client.cjs").waitForProcessExit(reference.desktop.pid);
        exited = true;
      } catch (error) {
        operation = {
          ...receipt,
          phase: "acceptedPending",
          message: desktopError(error).message,
        };
      }
    }
    if (exited) {
      operation = { ...receipt, phase: "completed" };
      if (!this.status.connected) {
        this.reconnectBlocked = true;
        this.clearReconnect();
      }
    }
  }
  if (reference.logicalProjectId)
    operation = { ...operation, logicalProjectId: reference.logicalProjectId };
  this.lifecycleReceipts.set(reference.requestId, operation);
  if (
    operation.phase === "blocked" ||
    (operation.phase === "completed" && !desktopKind(reference.kind))
  ) {
    this.lifecycleReferences.delete(reference.requestId);
    await this.persistReferences();
  }
  this.lifecycleError = null;
  this.onChange();
  return operation;
}

/** @this {Backend}  @param {string} name @param {Record<string,unknown>} [request] */
function assertLifecycleScope(name, request = {}) {
  if (
    ["list", "open", "reconcile", "queue"].includes(name) ||
    (name === "manage" && request.operation === "toolAcknowledge") ||
    (name !== "browserClaim" && commandSemantics(name, request).effect === "read")
  )
    return;
  if (this.unidentifiedStop || (this.status.stopReport && this.status.lifecycle?.version !== 2))
    throw Object.assign(new Error("请先检查并恢复原后台，再继续工作。输入和历史已保留。"), {
      code: "LIFECYCLE_INCOMPLETE",
    });
  for (const reference of this.hostReferences.values()) {
    if (this.hostReceipts.get(reference.requestId)?.state === "blocked") continue;
    throw Object.assign(new Error("原 Host 停止操作尚未恢复，请检查原请求或明确重新连接"), {
      code: "LIFECYCLE_INCOMPLETE",
      requestId: reference.requestId,
    });
  }
  for (const reference of this.lifecycleReferences.values()) {
    const operation = this.lifecycleReceipts.get(reference.requestId);
    if (["blocked", "completed"].some((phase) => phase === operation?.phase)) continue;
    if (reference.kind === "interruptTurn" && reference.threadId !== request.threadId) continue;
    const target = (operation?.targets ?? reference.targets).find(
      (target) =>
        target.projectId === request.projectId || reference.logicalProjectId === request.projectId,
    );
    if (target && !["blocked", "completed"].some((phase) => phase === target.phase))
      throw Object.assign(new Error("此任务的原后台操作尚未结算，请检查原请求"), {
        code: "LIFECYCLE_INCOMPLETE",
        requestId: reference.requestId,
      });
  }
}

/** @this {Backend}  @param {import('@areal/workbench/desktop-contract/desktop-control').HostUpdateRequest} request */
async function hostUpdate(request) {
  if (this.hostUpdateInFlight) throw new Error("正在核查原升级请求，请稍后刷新");
  this.hostUpdateInFlight = true;
  const client = new HostClient();
  try {
    if (!this.options.hostHome) throw new Error("Host home 尚未配置");
    await client.connect(this.options.hostHome);
    const empty = {
      supported: false,
      restartPending: false,
      targetVersion: null,
      prepareRequestId: null,
      operation: null,
    };
    if (!client.capabilities.includes("updates")) {
      if (request.operation !== "status") throw new Error("当前 Host 不支持受控升级");
      return empty;
    }
    if (!this.hostUpdateReference) this.loadReferences(await this.readControl());
    if (this.unidentifiedStop && ["prepare", "apply"].includes(request.operation))
      throw Object.assign(new Error(originalDesktopMessage), { code: "LIFECYCLE_INCOMPLETE" });
    const original = this.hostUpdateReference;
    if (original) {
      if (original.hostId !== client.hostId) throw new Error("Host 身份已变化，原升级请求仍需核查");
      const { operation: receipt } = await client.operation(original.requestId);
      if (
        receipt !== null &&
        (!hostUpdateReceipt(receipt) ||
          receipt.requestId !== original.requestId ||
          receipt.hostId !== original.hostId ||
          receipt.generation !== original.generation ||
          receipt.action !== original.action ||
          receipt.targetVersion !== original.targetVersion)
      )
        throw new Error("原升级请求回执与保存的身份不一致");
      if (receipt && ["prepared", "completed", "blocked"].includes(receipt.state)) {
        this.hostUpdateReference = null;
        await this.persistReferences();
      } else {
        if (request.operation !== "status" && request.operation !== "check")
          throw new Error("原升级请求结果待核查，请检查原请求");
        return {
          supported: true,
          restartPending: true,
          targetVersion: original.targetVersion,
          prepareRequestId: original.action === "prepare" ? original.requestId : null,
          operation: this.publicHostUpdate(
            receipt ?? {
              version: 1,
              ...original,
              state: "admissionUnknown",
              message: "原请求结果未知；只核查原编号，不自动重新提交。",
            },
          ),
        };
      }
    }
    if (request.operation === "prepare" || request.operation === "apply") {
      this.hostUpdateReference = {
        requestId: request.requestId,
        hostId: client.hostId,
        generation: client.generation,
        action: request.operation,
        targetVersion: request.targetVersion,
      };
      await this.persistReferences();
      try {
        const receipt = await client.request("host.update", {
          requestId: request.requestId,
          expectedGeneration: client.generation,
          action: request.operation,
          targetVersion: request.targetVersion,
          ...(request.operation === "apply" ? { strategy: "ifIdle" } : {}),
        });
        this.publicHostUpdate(receipt);
        if (
          receipt.requestId !== request.requestId ||
          receipt.hostId !== client.hostId ||
          receipt.generation !== client.generation ||
          receipt.action !== request.operation ||
          receipt.targetVersion !== request.targetVersion
        )
          throw new Error("升级回执与原请求不一致，请核查原编号");
        if (["prepared", "completed", "blocked"].includes(receipt.state)) {
          this.hostUpdateReference = null;
          await this.persistReferences();
        }
      } catch (error) {
        if (
          [
            "invalidUpdateTarget",
            "updateUnavailable",
            "invalidRequest",
            "generationMismatch",
            "stopInProgress",
          ].includes(String(desktopError(error).code))
        ) {
          this.hostUpdateReference = null;
          await this.persistReferences();
        }
        throw error;
      }
    }
    const status = await client.request("host.updateStatus", {});
    return {
      supported: true,
      restartPending: status.restartPending,
      targetVersion: status.targetVersion,
      prepareRequestId: status.prepareRequestId,
      operation: status.operation === null ? null : this.publicHostUpdate(status.operation),
    };
  } finally {
    client.close();
    this.hostUpdateInFlight = false;
  }
}
module.exports = {
  originalDesktopMessage,
  hostUpdate,
  persistReferences,
  loadReferences,
  readLifecycle,
  acceptLifecycleReceipt,
  assertLifecycleScope,
  lifecycleProjection,
  desktopKind,
  needsOriginalCheck,
  readReferences,
  readLifecycleResponse,
};
