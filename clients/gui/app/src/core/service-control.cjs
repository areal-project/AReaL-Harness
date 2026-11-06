// @ts-check
"use strict";
const { hostReference } = require("./host-lifecycle.cjs");
const { isDeepStrictEqual } = require("node:util");
const { KINDS, isLifecycleReceipt } = require("@areal/workbench/desktop-contract/shared");
/** @typedef {import('@areal/workbench-service/desktop/core/lifecycle-operations.cjs').LifecycleKind} Kind */
/** @typedef {import('@areal/workbench-service/desktop/core/lifecycle-operations.cjs').LifecycleMode} Mode */
/** @typedef {import('@areal/workbench-service/desktop/core/lifecycle-operations.cjs').TargetPhase} TargetPhase */
/** @typedef {{projectId:string,serviceId:string|null,generation:string|null,phase?:import('@areal/workbench/desktop-contract/shared').TargetPhase,error?:unknown}} ReferenceTarget */
/** @typedef {{pid:number,identity:string}} DesktopIdentity */
/** @typedef {{requestId:string,desktopGeneration:string,kind:Kind,mode:Mode,targets:ReferenceTarget[],desktop:DesktopIdentity,threadId?:string,turnId?:string,logicalProjectId?:string}} LifecycleReference */
/** @typedef {{projectId:string,serviceId:string,generation:string,phase:TargetPhase,error?:unknown,[key:string]:unknown}} ResponseTarget */
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
    isDeepStrictEqual(require("./lifecycle.cjs").targets(value.targets), reference.targets) &&
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

const { mkdir, open, rename, rm } = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { PROTOCOL } = require("@areal/workbench-service/desktop/core/service-protocol.cjs");
/** @typedef {import('./lifecycle.cjs').RecoveryObservation} Observation */
const { HostClient } = require("@areal/client/node");
const { hostUpdateReceipt } = require("@areal/workbench/desktop-contract/desktop-control");
const { desktopError } = require("@areal/workbench/desktop-contract");
const { projectHostReceipt } = require("./host-lifecycle.cjs");
/** @typedef {InstanceType<typeof import('./service-client.cjs').SharedCoreBackend>} Backend */
/** @typedef {import('./service-control.cjs').LifecycleReference} Reference */
/** @typedef {import('./service-control.cjs').LifecycleResponse} Receipt */
/** @typedef {{kind:import('@areal/workbench-service/desktop/core/lifecycle-operations.cjs').LifecycleKind,mode?:import('@areal/workbench-service/desktop/core/lifecycle-operations.cjs').LifecycleMode,observed?:Observation,projectId?:string,threadId?:string,turnId?:string,requestId?:string,migration?:unknown}} LifecycleOptions */
/** @typedef {{stopped:boolean,operation:Receipt,kind?:string}} LifecycleResult */
/** @param {unknown} kind */
const desktopKind = (kind) => kind === "stopDesktop" || kind === "updateDesktop";
/** @param {Pick<import("./service-control.cjs").LifecycleResponse,"phase"|"targets"> & {desktopExit?:unknown}} operation */
const needsOriginalCheck = (operation) =>
  operation.phase === "admissionUnconfirmed" ||
  (operation.phase === "acceptedPending" && operation.desktopExit === "requested") ||
  operation.targets.some((target) =>
    ["notAttempted", "acceptedPending", "admissionUnconfirmed"].includes(target.phase),
  );
const notAdmittedCodes = new Set([
  "LIFECYCLE_ADMISSION_FAILED",
  "LIFECYCLE_UNSUPPORTED",
  "LIFECYCLE_INVALID_REQUEST",
  "LIFECYCLE_REQUEST_CONFLICT",
  "CONFIRMATION_STALE",
  "LIFECYCLE_BLOCKED",
  "LIFECYCLE_INCOMPLETE",
]);
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
    this.legacyControl || (this.status.stopReport && this.status.lifecycle?.version !== 2);
  return {
    supported: this.status.lifecycle?.version === 2,
    operations,
    ...(this.foreignOwner
      ? {
          recovery: {
            canRecover: true,
            projects: [],
            message: "原后台属于旧应用会话。请检查并安全迁移。",
          },
        }
      : {}),
    ...(legacy
      ? {
          recovery: this.legacyRecoveryView ?? {
            canRecover: false,
            projects: [],
            message: "请检查原后台状态，再恢复工作。",
          },
        }
      : {}),
    ...((latest ?? legacy)
      ? (latest ?? {
          phase: "admissionUnconfirmed",
          targets: [],
          message: "旧停止记录缺少操作身份，已恢复观察连接。请检查原后台状态；不会重发旧操作。",
        })
      : {}),
    ...(this.lifecycleError ? { error: this.lifecycleError, message: this.lifecycleError } : {}),
  };
}

/** @this {Backend} */
async function persistReferences() {
  const write = async () => {
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
    this.legacyControl = control;
    this.controlState = null;
  } else this.controlState = control?.state ?? null;
}

/** @this {Backend}  @param {Reference} reference @param {boolean} [reconcile] @returns {Promise<Receipt>} */
async function readLifecycle(reference, reconcile = true) {
  let receipt;
  if (this.status.connected && this.status.lifecycle?.version === 2) {
    try {
      receipt = await this.requireConnection().request(
        reconcile ? "lifecycleReconcile" : "lifecycleRead",
        { protocol: PROTOCOL, requestId: reference.requestId },
      );
    } catch (error) {
      if (
        desktopError(error).code !== "DISCONNECTED" &&
        desktopError(error).code !== "LIFECYCLE_UNSUPPORTED"
      )
        throw error;
    }
  }
  if (!receipt) {
    const {
      readLifecycleReceipt,
      reconcileLifecycleReceipt,
    } = require("@areal/workbench-service/desktop/core/lifecycle-operations.cjs");
    const identity = {
      requestId: reference.requestId,
      desktopGeneration: reference.desktopGeneration,
    };
    receipt =
      this.options.binary && this.options.harnessHome
        ? await reconcileLifecycleReceipt(this.home, {
            ...identity,
            binary: this.options.binary,
            harnessHome: this.options.harnessHome,
          })
        : await readLifecycleReceipt(this.home, identity);
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
      targets: reference.targets.map((target) => ({ ...target, phase: "admissionUnconfirmed" })),
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
    const local =
      this.metadata?.local === true &&
      reference.desktop.pid === process.pid &&
      this.mainDesktop?.adapter.lifecycle?.generation === reference.desktopGeneration;
    if (local && receipt.desktopExit === "requested") {
      await this.mainDesktop?.close();
      exited = this.mainDesktop?.closed === true;
    } else {
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
    }
    if (exited) {
      operation = { ...receipt, phase: "completed" };
      this.exitConfirmation =
        this.metadata?.desktopGeneration === reference.desktopGeneration
          ? this.metadata
          : reference.desktop;
      if (
        this.metadata?.desktopGeneration === reference.desktopGeneration ||
        !this.status.connected
      ) {
        this.reconnectBlocked = true;
        this.clearReconnect();
      }
      // 完整停止回执和进程退出共同证明旧终端已清理，不能依赖连接是否先断开。
      if (this.metadata?.desktopGeneration === reference.desktopGeneration) {
        this.guiTerminals.clear();
        if (this.status.connected) {
          const connection = this.connection;
          this.stoppedConnection = connection;
          this.disconnected();
          this.connection = null;
          connection?.close();
        }
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
  if (this.foreignOwner)
    throw Object.assign(new Error("原后台属于旧应用会话，请先检查并安全迁移"), {
      code: "APPLICATION_OWNER_MISMATCH",
    });
  if (
    ["list", "open", "reconcile", "queue"].includes(name) ||
    require("./lifecycle.cjs").isRecoveryCommand(name, request)
  )
    return;
  if (
    (this.legacyControl?.legacyRecovery || this.status.stopReport) &&
    this.status.lifecycle?.version !== 2
  )
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

/** @this {Backend}  @param {LifecycleOptions} options @returns {Promise<LifecycleResult>} */
async function requestLifecycle(options) {
  const {
    kind,
    mode = "ifIdle",
    observed,
    projectId,
    threadId,
    turnId,
    requestId = randomUUID(),
    migration,
  } = options;
  this.assertApplicationWrite(migration);
  if (!this.status.connected) throw new Error("后台尚未连接，请先重新连接后台");
  const originalReference = this.lifecycleReferences.get(requestId);
  const previous = originalReference ?? this.lifecycleReceipts.get(requestId);
  if (previous) {
    if (
      previous.kind !== kind ||
      previous.mode !== mode ||
      previous.threadId !== threadId ||
      previous.turnId !== turnId ||
      (projectId &&
        (previous.logicalProjectId
          ? previous.logicalProjectId !== projectId
          : !previous.targets.some((target) => target.projectId === projectId)))
    )
      throw Object.assign(new Error("原请求身份不能绑定其他操作或轮次"), {
        code: "LIFECYCLE_REQUEST_CONFLICT",
      });
    const operation = originalReference
      ? await this.readLifecycle(originalReference)
      : this.lifecycleReceipts.get(requestId);
    if (!operation) throw new Error("原生命周期回执已移除，请重新核查");
    return { stopped: operation.phase === "completed", operation };
  }
  if (desktopKind(kind)) {
    for (const reference of this.lifecycleReferences.values()) {
      if (!desktopKind(reference.kind)) continue;
      const operation = await this.readLifecycle(reference);
      if (needsOriginalCheck(operation)) return { stopped: false, operation };
    }
  }
  const { DesktopLifecycle } = require("./lifecycle.cjs");
  const intent = await new DesktopLifecycle({
    connection: this.requireConnection(),
    metadata: this.metadata,
    home: this.home,
    forUpdate: desktopKind(kind),
    purpose: kind === "stopDesktop" && observed?.purpose === "quit" ? "quit" : "manage",
  }).prepare({ kind, mode, observed, projectId, threadId, turnId });
  if (!this.metadata) throw new Error("后台连接元数据不可用");
  /** @type {Reference} */
  const reference = {
    requestId,
    kind,
    mode,
    desktopGeneration: intent.expectedDesktopGeneration,
    targets: intent.expectedTargets,
    desktop: { pid: this.metadata.pid, identity: this.metadata.identity },
    ...(kind === "interruptTurn" ? { threadId, turnId, logicalProjectId: projectId } : {}),
  };
  this.lifecycleReferences.set(requestId, reference);
  try {
    await this.persistReferences();
  } catch (error) {
    this.lifecycleReferences.delete(requestId);
    throw error;
  }
  this.lifecycleError = null;
  this.onChange();
  let operation;
  try {
    const receipt = await this.requireConnection().request(
      "lifecycleRequest",
      { protocol: PROTOCOL, requestId, ...intent },
      true,
    );
    if (!receipt) throw Object.assign(new Error("后台操作回执缺失"), { submissionUnknown: true });
    operation = await this.acceptLifecycleReceipt(reference, receipt);
  } catch (error) {
    if (
      !desktopError(error).submissionUnknown &&
      [...notAdmittedCodes].some((code) => code === desktopError(error).code)
    ) {
      this.lifecycleReferences.delete(requestId);
      await this.persistReferences();
      throw error;
    }
    operation = await this.readLifecycle(reference);
  }
  return {
    stopped: operation.phase === "completed",
    operation,
    ...(desktopKind(kind) && operation.phase === "completed" ? { kind: "exited" } : {}),
  };
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
      this.assertApplicationWrite();
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
  hostUpdate,
  persistReferences,
  loadReferences,
  readLifecycle,
  acceptLifecycleReceipt,
  assertLifecycleScope,
  requestLifecycle,
  lifecycleProjection,
  desktopKind,
  needsOriginalCheck,
  readReferences,
  readLifecycleResponse,
};
