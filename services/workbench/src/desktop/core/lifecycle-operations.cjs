// @ts-check
"use strict";

const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join, isAbsolute } = require("node:path");
const { readStop, detachStoppedProject, readOriginalTurn } = require("./local-service.cjs");

/** @typedef {import('@areal/workbench/desktop-contract/shared').LifecycleKind} LifecycleKind */
/** @typedef {import('@areal/workbench/desktop-contract/shared').LifecycleMode} LifecycleMode */
/** @typedef {import('@areal/workbench/desktop-contract/shared').TargetPhase} TargetPhase */
/** @typedef {import('@areal/workbench/desktop-contract/shared').LifecycleIdentity} LifecycleIdentity */
/** @typedef {import('@areal/workbench/desktop-contract/shared').LifecycleTarget & {requestId:string,dataDir?:string}} LifecycleTarget */
/** @typedef {{requestId:string,kind:LifecycleKind,mode:LifecycleMode,desktopGeneration:string,targets:LifecycleIdentity[],threadId?:string,turnId?:string}} LifecycleRequest */
/** @typedef {import('@areal/workbench/desktop-contract/shared').LifecycleReceipt & {targets:LifecycleTarget[],sharedHost?:boolean}} LifecycleReceipt */
/** @typedef {import('./project-state.cjs').CoreProject} Project */
/** @typedef {import('@areal/runtime-client/core').CoreClient} CoreClient */
/** @typedef {InstanceType<typeof import('./backend.cjs').CoreBackend>} Backend */
/** @typedef {{closed:boolean,clients:Set<unknown>,inflight:number}} LifecycleService */
const { KINDS, isLifecycleReceipt } = require("@areal/workbench/desktop-contract/shared");
const PHASES = new Set([
  "notAttempted",
  "acceptedPending",
  "blocked",
  "admissionUnconfirmed",
  "settlementIncomplete",
  "completed",
]);
/** @param {unknown} value @returns {value is string} */
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
/** @param {unknown} value @returns {value is string} */
const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 256;
/** @param {unknown} kind */
const desktopKind = (kind) => kind === "stopDesktop" || kind === "updateDesktop";
/** @param {LifecycleIdentity[]} targets */
const identities = (targets) =>
  targets
    .map(({ projectId, serviceId, generation }) => ({ projectId, serviceId, generation }))
    .sort((a, b) => a.projectId.localeCompare(b.projectId));
/** @param {string} message @param {string} code @param {Record<string,unknown>} [extra] */
const failure = (message, code, extra = {}) =>
  Object.assign(new Error(message), { code, ...extra });
/** @param {LifecycleTarget} target */
const unresolved = (target) =>
  ["acceptedPending", "admissionUnconfirmed", "settlementIncomplete"].includes(target.phase);

/** @param {LifecycleReceipt} record */
function deriveReceipt(record) {
  const phases = record.targets.map((target) => target.phase);
  if (record.desktopError) record.phase = "settlementIncomplete";
  else if (phases.every((phase) => phase === "completed"))
    record.phase = desktopKind(record.kind) ? "acceptedPending" : "completed";
  else if (new Set(phases).size > 1) record.phase = "partial";
  else record.phase = phases[0] === "notAttempted" ? "acceptedPending" : phases[0];
}

/** @param {unknown} error @param {(message:string)=>string} redact */
function receiptError(error, redact) {
  const details = require("@areal/workbench/desktop-contract").desktopError(error);
  return {
    code:
      typeof details.code === "string" || typeof details.code === "number"
        ? details.code
        : "LIFECYCLE_FAILED",
    message: redact(details.message).slice(0, 2048),
  };
}

/** @param {LifecycleReceipt} record @param {LifecycleTarget} target @param {unknown} operation */
function applyHostReceipt(record, target, operation) {
  if (
    !object(operation) ||
    operation.version !== 1 ||
    operation.requestId !== target.requestId ||
    operation.serviceId !== target.serviceId ||
    operation.generation !== target.generation ||
    operation.cancel !== (record.mode === "cancel") ||
    !hostPhase(operation.state)
  ) {
    throw failure("原 Host 回执身份或状态不匹配", "LIFECYCLE_RECEIPT_INVALID");
  }
  target.hostReceipt = operation;
  target.phase = operation.state === "admissionUnknown" ? "admissionUnconfirmed" : operation.state;
  delete target.error;
}

/** @param {LifecycleReceipt} record @param {LifecycleTarget} target @param {{id:string,status:unknown}|null} turn */
function applyTurnReceipt(record, target, turn) {
  if (!turn) return;
  if (
    turn.id !== record.turnId ||
    !["inProgress", "completed", "failed", "interrupted"].some((status) => status === turn.status)
  )
    throw failure("原轮次回执身份或状态不匹配", "LIFECYCLE_RECEIPT_INVALID");
  if (turn.status !== "inProgress") {
    target.phase = "completed";
    delete target.error;
  }
}

/** @param {LifecycleReceipt} record @param {{readHost:(target:LifecycleTarget)=>Promise<unknown>,inspectTurn:(record:LifecycleReceipt,target:LifecycleTarget)=>Promise<void>,completed?:(target:LifecycleTarget)=>void,redact:(message:string)=>string}} options */
async function reconcileReceipt(record, { readHost, inspectTurn, completed = () => {}, redact }) {
  for (const target of record.targets) {
    if (!unresolved(target)) continue;
    try {
      if (record.kind === "interruptTurn") await inspectTurn(record, target);
      else {
        const operation = await readHost(target);
        if (operation) applyHostReceipt(record, target, operation);
        else target.phase = "admissionUnconfirmed";
      }
      if (target.phase === "completed") completed(target);
    } catch (error) {
      target.error = receiptError(error, redact);
    }
  }
  deriveReceipt(record);
  return record;
}

/** @param {unknown} record @param {string} requestId @returns {LifecycleReceipt} */
function validateReceipt(record, requestId) {
  if (!validReceipt(record, requestId)) {
    throw failure(
      "后台生命周期回执损坏，请检查原记录；不会启动或重发操作",
      "LIFECYCLE_JOURNAL_INVALID",
    );
  }
  return record;
}

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is LifecycleKind} */
function lifecycleKind(value) {
  return KINDS.some((kind) => kind === value);
}
/** @param {unknown} value @returns {value is 'acceptedPending'|'blocked'|'admissionUnknown'|'settlementIncomplete'|'completed'} */
function hostPhase(value) {
  return [
    "acceptedPending",
    "blocked",
    "admissionUnknown",
    "settlementIncomplete",
    "completed",
  ].some((phase) => phase === value);
}
/** @param {unknown} record @param {string} requestId @returns {record is LifecycleReceipt} */
function validReceipt(record, requestId) {
  return (
    isLifecycleReceipt(record) &&
    uuid(record.requestId) &&
    record.requestId === requestId &&
    record.version === 1 &&
    lifecycleKind(record.kind) &&
    uuid(record.desktopGeneration) &&
    (record.mode === "ifIdle" || record.mode === "cancel") &&
    (record.harnessHome === undefined ||
      (typeof record.harnessHome === "string" && isAbsolute(record.harnessHome))) &&
    (record.desktopExit === "notRequested" || record.desktopExit === "requested") &&
    [
      "acceptedPending",
      "blocked",
      "partial",
      "admissionUnconfirmed",
      "settlementIncomplete",
      "completed",
    ].some((phase) => phase === record.phase) &&
    Array.isArray(record.targets) &&
    record.targets.every(
      (target) =>
        object(target) &&
        text(target.projectId) &&
        text(target.serviceId) &&
        text(target.generation) &&
        (!("dataDir" in target) ||
          target.dataDir === undefined ||
          (typeof target.dataDir === "string" && isAbsolute(target.dataDir))) &&
        uuid(target.requestId) &&
        typeof target.phase === "string" &&
        PHASES.has(target.phase),
    ) &&
    (record.kind !== "interruptTurn" || (text(record.threadId) && text(record.turnId)))
  );
}

/** @param {string} home @param {{requestId?:unknown,desktopGeneration?:unknown}} [options] */
async function readLifecycleReceipt(home, { requestId, desktopGeneration } = {}) {
  if (!uuid(requestId) || (desktopGeneration !== undefined && !uuid(desktopGeneration)))
    throw failure("无效的后台请求身份", "LIFECYCLE_INVALID_REQUEST");
  let record;
  try {
    record = validateReceipt(
      JSON.parse(await readFile(join(home, "lifecycle-operations", `${requestId}.json`), "utf8")),
      requestId,
    );
  } catch (error) {
    if (object(error) && error.code === "ENOENT") return null;
    throw error;
  }
  if (desktopGeneration !== undefined && record.desktopGeneration !== desktopGeneration)
    throw failure("原 Desktop 回执代际不匹配", "LIFECYCLE_RECEIPT_INVALID");
  return record;
}

/** @param {string} home @param {{requestId?:unknown,desktopGeneration?:unknown,binary?:string,harnessHome?:string,redact?:(message:string)=>string}} [options] */
async function reconcileLifecycleReceipt(
  home,
  { requestId, desktopGeneration, binary, harnessHome, redact = (value) => value } = {},
) {
  const record = await readLifecycleReceipt(home, { requestId, desktopGeneration });
  if (!record) return null;
  if (!record.targets.some(unresolved)) {
    deriveReceipt(record);
    return record;
  }
  const registry = record.harnessHome ?? harnessHome;
  if (
    typeof binary !== "string" ||
    !isAbsolute(binary) ||
    typeof registry !== "string" ||
    !isAbsolute(registry) ||
    typeof redact !== "function"
  )
    throw failure("离线核查需要原 Core 程序与服务登记目录", "LIFECYCLE_INVALID_REQUEST");
  const reader = {
    binary,
    home,
    ...(record.sharedHost ? { hostRegistry: registry } : {}),
    providers: { redact },
    hooks: { environment: () => ({ ...process.env, AREAL_HARNESS_SERVICE_HOME: registry }) },
  };
  /** @type {import('./project-index.cjs').SavedProject[]|undefined} */
  let saved;
  return reconcileReceipt(record, {
    readHost: (target) => readStop(reader, target),
    redact,
    inspectTurn: async (receipt, target) => {
      if (!saved) {
        /** @type {unknown} */
        const projects = JSON.parse(await readFile(join(home, "projects.json"), "utf8"));
        if (!Array.isArray(projects) || !projects.every(originalProject))
          throw failure("原工作区登记不可用，无法核对轮次", "LIFECYCLE_INCOMPLETE");
        saved = projects;
      }
      if (
        typeof receipt.threadId !== "string" ||
        typeof receipt.turnId !== "string" ||
        !receipt.threadId ||
        !receipt.turnId
      )
        throw failure("原轮次身份不完整", "LIFECYCLE_RECEIPT_INVALID");
      applyTurnReceipt(
        receipt,
        target,
        await readOriginalTurn({ ...reader, saved }, target, receipt.threadId, receipt.turnId),
      );
    },
  });
}

class LifecycleOperations {
  /** @param {Backend} backend */
  constructor(backend) {
    /** @type {Backend} */
    this.backend = backend;
    /** @type {string} */
    this.generation = randomUUID();
    /** @type {Set<string>} */
    this.hostOwnedRequests = new Set();
    this.directory = join(backend.home, "lifecycle-operations");
    /** @type {Map<string,LifecycleReceipt>} */
    this.records = new Map();
    /** @type {Set<string>} */
    this.activeTargets = new Set();
    /** @type {string|null} */
    this.activeRequestId = null;
    /** @type {Promise<unknown>} */
    this.tail = Promise.resolve();
    /** @type {LifecycleService|undefined} */
    this.service = undefined;
    /** @type {Promise<void>|undefined} */
    this.ready = undefined;
  }

  /** @param {unknown} value */
  acceptHostRecord(value) {
    if (value === null) return null;
    if (
      !object(value) ||
      typeof value.requestId !== "string" ||
      !validReceipt(value, value.requestId)
    )
      throw failure("Host 生命周期回执损坏", "LIFECYCLE_RECEIPT_INVALID");
    this.records.set(value.requestId, value);
    if (value.kind !== "interruptTurn")
      for (const target of value.targets)
        if (target.phase === "completed") detachStoppedProject(this.backend, target);
    this.backend.onChange?.();
    return value;
  }
  /** @param {unknown} value */
  async projectHostRecord(value) {
    const record = this.acceptHostRecord(value);
    if (
      !record ||
      record.kind !== "interruptTurn" ||
      record.phase !== "completed" ||
      typeof record.threadId !== "string"
    )
      return record;
    const threadId = record.threadId;
    const target = record.targets[0];
    const project = this.backend.projects.get(target.projectId);
    const client = project?.client;
    const source = this.backend.host.sourceId;
    const current = () =>
      this.generation === record.desktopGeneration &&
      this.backend.host.sourceId === source &&
      this.backend.projects.get(target.projectId) === project &&
      project?.service?.serviceId === target.serviceId &&
      project.service.generation === target.generation &&
      this.backend.currentConnection(project, client);
    if (!client || !project || !current()) return record;
    const displayed = project.model.state.threads[threadId]?.turns?.find(
      (turn) => turn.id === record.turnId,
    );
    if (displayed && ["completed", "failed", "interrupted"].includes(displayed.status ?? ""))
      return record;
    try {
      // 完成证明先刷新原连接投影，再交付回执；Main延迟接收不应阻塞历史读取。
      await this.backend.readObservation(project, threadId, {
        client,
        current,
        timeoutMs: 6000,
      });
    } catch (error) {
      if (current()) this.backend.observations.observationFailure(project, threadId, error);
    }
    return record;
  }
  /** @param {string} operation @param {unknown} [requestId] */
  async hostRead(operation, requestId) {
    if (!this.backend.hostCall) throw failure("Host 生命周期不可用", "LIFECYCLE_UNSUPPORTED");
    return this.backend.hostCall("lifecycle.read", {
      sourceId: this.backend.host.sourceId,
      operation,
      ...(operation === "snapshot" ? { ownerNonce: this.generation } : {}),
      ...(typeof requestId === "string" ? { requestId } : {}),
    });
  }
  init() {
    this.ready ??= this.hostRead("snapshot").then((value) => {
      if (
        !object(value) ||
        typeof value.desktopGeneration !== "string" ||
        !Array.isArray(value.records)
      )
        throw failure("Host 生命周期快照损坏", "LIFECYCLE_RECEIPT_INVALID");
      this.generation = value.desktopGeneration;
      this.hostOwnedRequests = new Set(
        Array.isArray(value.ownedRequestIds)
          ? value.ownedRequestIds.filter((id) => typeof id === "string")
          : [],
      );
      for (const record of value.records) this.acceptHostRecord(record);
    });
    return this.ready;
  }

  /** @param {LifecycleService} service @returns {LifecycleOperations} */
  attach(service) {
    if (this.service && this.service !== service) {
      if (!this.service.closed)
        throw failure("原 Desktop owner 仍在使用，不能替换生命周期代际", "LIFECYCLE_BLOCKED");
      const owner = new LifecycleOperations(this.backend);
      owner.service = service;
      this.backend.lifecycleOperations = owner;
      return owner;
    }
    this.service = service;
    return this;
  }

  async reconcileLoaded() {
    await this.init();
    for (const record of Array.from(this.records.values())) {
      if (
        record.targets.some((target) =>
          ["acceptedPending", "admissionUnconfirmed", "settlementIncomplete"].includes(
            target.phase,
          ),
        )
      )
        await this.reconcile(record.requestId);
    }
  }

  snapshot() {
    return {
      version: 2,
      desktopGeneration: this.generation,
      capabilities: { request: true, read: true, reconcile: true, kinds: [...KINDS] },
      activeRequestId: this.activeRequestId,
      blockedProjectIds: [
        ...new Set(
          [...this.records.values()]
            .filter((record) => this.hostOwnedRequests.has(record.requestId))
            .flatMap((record) =>
              record.targets
                .filter((target) =>
                  ["acceptedPending", "admissionUnconfirmed", "settlementIncomplete"].includes(
                    target.phase,
                  ),
                )
                .map((target) => target.projectId),
            ),
        ),
      ],
    };
  }

  targets() {
    const engines = [...this.backend.projects];
    return identities(
      engines.flatMap(([projectId, project]) =>
        project.service
          ? [
              {
                projectId,
                serviceId: project.service.serviceId,
                generation: project.service.generation,
              },
            ]
          : [],
      ),
    );
  }

  /** @param {string|undefined} projectId @param {string} [_threadId] */
  blocking(projectId, _threadId) {
    for (const record of this.records.values()) {
      if (!this.hostOwnedRequests.has(record.requestId)) continue;
      if (
        record.targets.some(
          (target) =>
            target.projectId === projectId &&
            ["acceptedPending", "admissionUnconfirmed", "settlementIncomplete"].includes(
              target.phase,
            ),
        )
      )
        return record;
    }
    return null;
  }

  exitingReceipt() {
    return [...this.records.values()].find(
      (record) =>
        record.desktopGeneration === this.generation && record.desktopExit === "requested",
    );
  }

  assertNotExiting() {
    const record = this.exitingReceipt();
    if (record)
      throw failure("原 Desktop 已请求退出，请等待原进程结束", "LIFECYCLE_EXIT_REQUESTED", {
        requestId: record.requestId,
        lifecycle: record,
      });
  }

  assertRegistration() {
    this.assertNotExiting();
    if (this.activeRequestId)
      throw failure("正在处理后台生命周期，请稍后打开工作区", "LIFECYCLE_BLOCKED");
  }

  /** @param {string|undefined} projectId @param {string} [threadId] */
  assertProject(projectId, threadId) {
    this.assertNotExiting();
    const record = this.blocking(projectId, threadId);
    if (
      this.activeRequestId ||
      (projectId !== undefined && this.activeTargets.has(projectId)) ||
      record
    )
      throw failure("原后台操作尚未结算，请检查原请求；不会启动或重发", "LIFECYCLE_INCOMPLETE", {
        requestId: record?.requestId,
        lifecycle: record,
      });
  }

  /** @param {string} projectId */
  schedulingSuppressed(projectId) {
    return this.backend.host.scheduling(projectId).suppressed;
  }

  /** @param {string} projectId */
  resumeScheduling(projectId) {
    const write = this.tail
      .catch(() => {})
      .then(async () => {
        this.assertProject(projectId);
        await this.backend.start(projectId, {
          resumeScheduling: true,
        });
      });
    this.tail = write.catch(() => {});
    return write;
  }

  /** @param {unknown} input @returns {LifecycleRequest} */
  normalize(input) {
    if (
      !object(input) ||
      !uuid(input.requestId) ||
      !uuid(input.expectedDesktopGeneration) ||
      !lifecycleKind(input.kind) ||
      (input.mode !== "ifIdle" && input.mode !== "cancel") ||
      !Array.isArray(input.expectedTargets) ||
      !input.expectedTargets.every(validIdentity) ||
      new Set(input.expectedTargets.map((target) => target.projectId)).size !==
        input.expectedTargets.length ||
      (!desktopKind(input.kind) && input.expectedTargets.length !== 1) ||
      (input.kind === "interruptTurn" &&
        (!text(input.threadId) || !text(input.turnId) || input.mode !== "cancel"))
    ) {
      throw failure("无效的后台生命周期请求", "LIFECYCLE_INVALID_REQUEST");
    }
    return {
      requestId: input.requestId,
      kind: input.kind,
      mode: input.mode,
      desktopGeneration: input.expectedDesktopGeneration,
      targets: identities(input.expectedTargets),
      ...(input.kind === "interruptTurn" &&
      typeof input.threadId === "string" &&
      typeof input.turnId === "string"
        ? { threadId: input.threadId, turnId: input.turnId }
        : {}),
    };
  }

  /** @param {unknown} requestId */
  async read(requestId) {
    return this.projectHostRecord(await this.hostRead("read", requestId));
  }

  /** @param {unknown} input */
  request(input) {
    const request = this.normalize(input);
    const task = this.tail
      .catch(() => {})
      .then(async () => {
        this.activeRequestId = desktopKind(request.kind) ? request.requestId : null;
        for (const target of request.targets) this.activeTargets.add(target.projectId);
        try {
          if (!this.backend.hostCall) throw failure("Host 生命周期不可用", "LIFECYCLE_UNSUPPORTED");
          this.hostOwnedRequests.add(request.requestId);
          const receipt = await this.projectHostRecord(
            await this.backend.hostCall("lifecycle.command", {
              sourceId: this.backend.host.sourceId,
              request: {
                requestId: request.requestId,
                kind: request.kind,
                mode: request.mode,
                expectedDesktopGeneration: request.desktopGeneration,
                expectedTargets: request.targets,
                ...(request.threadId ? { threadId: request.threadId } : {}),
                ...(request.turnId ? { turnId: request.turnId } : {}),
              },
            }),
          );
          if (!receipt) throw failure("Host 生命周期请求没有回执", "LIFECYCLE_RECEIPT_INVALID");
          return receipt;
        } finally {
          this.activeRequestId = null;
          for (const target of request.targets) this.activeTargets.delete(target.projectId);
        }
      });
    this.tail = task.catch(() => {});
    return task;
  }

  /** @param {unknown} error */
  error(error) {
    return receiptError(error, (value) => this.backend.providers.redact(value));
  }

  /** @param {unknown} requestId */
  reconcile(requestId) {
    return this.hostRead("reconcile", requestId).then((value) => this.projectHostRecord(value));
  }
}

/** @param {unknown} value @returns {value is LifecycleIdentity} */
function validIdentity(value) {
  return object(value) && text(value.projectId) && text(value.serviceId) && text(value.generation);
}

/** @param {unknown} project @returns {project is {id:string,root:string}} */
function originalProject(project) {
  return (
    object(project) &&
    text(project.id) &&
    typeof project.root === "string" &&
    isAbsolute(project.root)
  );
}

module.exports = { LifecycleOperations, readLifecycleReceipt, reconcileLifecycleReceipt, KINDS };
