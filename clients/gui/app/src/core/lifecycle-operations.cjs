// @ts-check
"use strict";

const { randomUUID } = require("node:crypto");
const { mkdir, open, readFile, readdir, rename, rm } = require("node:fs/promises");
const { join, isAbsolute, resolve } = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const {
  lifecycleCapabilities,
  requestStop,
  readStop,
  detachStoppedProject,
  readOriginalTurn,
  readTurnMetadata,
} = require("./local-service.cjs");

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
/** @param {number} ms */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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

/** @param {string} path */
async function syncDirectory(path) {
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

class LifecycleOperations {
  /** @param {Backend} backend */
  constructor(backend) {
    /** @type {Backend} */
    this.backend = backend;
    this.generation = randomUUID();
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

  init() {
    this.ready ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await syncDirectory(this.backend.home);
      for (const name of await readdir(this.directory)) {
        if (!name.endsWith(".json")) continue;
        const record = await readLifecycleReceipt(this.backend.home, {
          requestId: name.slice(0, -5),
        });
        if (record) this.records.set(record.requestId, record);
      }
    })();
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
          [...this.records.values()].flatMap((record) =>
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

  /** @param {LifecycleReceipt} record */
  async store(record) {
    const previous = this.records.get(record.requestId);
    if (previous && isDeepStrictEqual(previous, record)) return;
    const path = join(this.directory, `${record.requestId}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(record));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      await syncDirectory(this.directory);
      this.records.set(record.requestId, structuredClone(record));
      this.backend.onChange?.();
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw failure(
        `后台生命周期回执未能保存：${require("@areal/workbench/desktop-contract").desktopError(error).message}`,
        "LIFECYCLE_RECEIPT_WRITE_FAILED",
        { requestId: record.requestId },
      );
    }
  }

  /** @param {unknown} requestId */
  async read(requestId) {
    if (!uuid(requestId)) throw failure("无效的后台请求身份", "LIFECYCLE_INVALID_REQUEST");
    await this.init();
    return structuredClone(this.records.get(requestId) ?? null);
  }

  /** @param {unknown} input */
  request(input) {
    const request = this.normalize(input);
    const task = this.tail.catch(() => {}).then(() => this.execute(request));
    this.tail = task.catch(() => {});
    return task;
  }

  /** @param {LifecycleRequest} request */
  async execute(request) {
    await this.init();
    const existing = this.records.get(request.requestId);
    if (existing) {
      const original = {
        requestId: existing.requestId,
        kind: existing.kind,
        mode: existing.mode,
        desktopGeneration: existing.desktopGeneration,
        targets: identities(existing.targets),
        ...(existing.kind === "interruptTurn"
          ? { threadId: existing.threadId, turnId: existing.turnId }
          : {}),
      };
      if (!isDeepStrictEqual(request, original))
        throw failure("请求身份已绑定其他生命周期意图", "LIFECYCLE_REQUEST_CONFLICT");
      return structuredClone(existing);
    }
    this.assertNotExiting();
    const current = this.targets();
    if (
      request.desktopGeneration !== this.generation ||
      !isDeepStrictEqual(
        request.targets,
        desktopKind(request.kind)
          ? current
          : current.filter((target) =>
              request.targets.some((expected) => expected.projectId === target.projectId),
            ),
      )
    ) {
      throw failure("后台实例或项目范围已变化，请重新确认", "CONFIRMATION_STALE");
    }
    for (const target of request.targets) {
      const prior = [...this.records.values()].find((record) =>
        record.targets.some(
          (value) =>
            value.projectId === target.projectId &&
            ["admissionUnconfirmed", "acceptedPending"].includes(value.phase),
        ),
      );
      if (prior)
        throw failure("原后台操作受理或退出尚未确认，请先检查原请求", "LIFECYCLE_INCOMPLETE", {
          requestId: prior.requestId,
          lifecycle: prior,
        });
    }
    if (desktopKind(request.kind)) {
      const { desktopBlockers, blockerMessage } = require("./lifecycle.cjs");
      const blockers = desktopBlockers(
        {
          clients: this.service?.clients.size ?? 0,
          activeCommands: Math.max(this.service?.inflight ?? 0, this.backend.activeCommands ?? 0),
          providerUpdating: this.backend.providerUpdating || this.backend.resourcesUpdating,
          starting: this.backend.starting.size,
        },
        request.kind === "updateDesktop",
      );
      if (blockers.length) throw failure(blockerMessage(blockers), "LIFECYCLE_BLOCKED");
      this.activeRequestId = request.requestId;
    }
    /** @type {LifecycleReceipt} */
    const record = {
      version: 1,
      ...request,
      harnessHome: resolve(this.backend.host.home),
      sharedHost: true,
      targets: request.targets.map((target) => ({
        ...target,
        dataDir: this.backend.host.resolve(target.projectId).dataDir,
        requestId: randomUUID(),
        phase: "notAttempted",
      })),
      phase: "acceptedPending",
      desktopExit: "notRequested",
    };
    let admitted = false;
    try {
      for (const target of record.targets) this.activeTargets.add(target.projectId);
      await this.store(record);
      admitted = true;
      for (const target of record.targets) {
        if (record.kind === "interruptTurn") await this.interrupt(record, target);
        else await this.stopTarget(record, target);
        deriveReceipt(record);
        await this.store(record);
      }
      if (
        desktopKind(record.kind) &&
        record.targets.every((target) => target.phase === "completed")
      ) {
        try {
          await this.backend.library?.writes;
          await Promise.all(this.backend.saves?.values() ?? []);
          record.desktopExit = "requested";
        } catch (error) {
          record.desktopError = this.error(error);
        }
      }
      deriveReceipt(record);
      await this.store(record);
      return structuredClone(record);
    } catch (error) {
      if (!admitted)
        throw failure(
          `后台生命周期请求未受理，原后台保持运行：${require("@areal/workbench/desktop-contract").desktopError(error).message}`,
          "LIFECYCLE_ADMISSION_FAILED",
          { requestId: record.requestId, submissionUnknown: false, cause: error },
        );
      if (!object(error)) throw error;
      error.requestId = record.requestId;
      error.submissionUnknown = true;
      throw error;
    } finally {
      for (const target of record.targets) this.activeTargets.delete(target.projectId);
      if (this.activeRequestId === request.requestId) this.activeRequestId = null;
      this.backend.onChange?.();
    }
  }

  /** @param {unknown} error */
  error(error) {
    return receiptError(error, (value) => this.backend.providers.redact(value));
  }

  /** @param {LifecycleIdentity} target */
  currentTarget(target) {
    const project = this.backend.projects.get(target.projectId);
    if (
      project?.service?.serviceId !== target.serviceId ||
      project.service.generation !== target.generation
    )
      throw failure("原 Core 实例或代际已变化", "CONFIRMATION_STALE");
    return project;
  }

  /** @param {LifecycleReceipt} record @param {LifecycleTarget} target @param {unknown} operation */
  applyHost(record, target, operation) {
    applyHostReceipt(record, target, operation);
    if (target.phase === "completed") detachStoppedProject(this.backend, target);
  }

  /** @param {LifecycleReceipt} record @param {LifecycleTarget} target */
  async stopTarget(record, target) {
    try {
      this.currentTarget(target);
      await lifecycleCapabilities(this.backend, target);
      this.currentTarget(target);
    } catch (error) {
      target.phase = "blocked";
      target.error = this.error(error);
      return;
    }
    target.phase = "acceptedPending";
    await this.store(record);
    try {
      this.applyHost(
        record,
        target,
        await requestStop(
          this.backend,
          target,
          record.mode === "cancel",
          record.kind === "stopProject",
        ),
      );
      const deadline = Date.now() + 15000;
      while (target.phase === "acceptedPending" && Date.now() < deadline) {
        await pause(50);
        const operation = await readStop(this.backend, target);
        if (!operation) break;
        this.applyHost(record, target, operation);
      }
    } catch (error) {
      try {
        const operation = await readStop(this.backend, target);
        if (operation) {
          this.applyHost(record, target, operation);
          return;
        }
      } catch {
        /* 原回执不可读时，不得授权重发。 */
      }
      target.phase = "admissionUnconfirmed";
      target.error = this.error(error);
    }
  }

  /** @param {Project} project @param {LifecycleTarget} target @param {unknown} threadId @param {unknown} turnId */
  readLiveTurn(project, target, threadId, turnId) {
    const client = project.client;
    if (
      !client ||
      typeof threadId !== "string" ||
      typeof turnId !== "string" ||
      !threadId ||
      !turnId
    )
      throw failure("原轮次身份或连接不完整", "LIFECYCLE_RECEIPT_INVALID");
    const assertCurrent = () => {
      if (this.currentTarget(target) !== project)
        throw failure("原工作区归属已变化", "CONFIRMATION_STALE");
      /** @type {(project:Project,client:CoreClient|null|undefined)=>void} */
      const requireConnection = this.backend.requireConnection;
      requireConnection.call(this.backend, project, client);
    };
    return readTurnMetadata(client, threadId, turnId, {
      assertCurrent,
      observe: () =>
        this.backend.readObservation(project, threadId, {
          client,
          current: () => {
            assertCurrent();
            return true;
          },
        }),
    });
  }

  /** @param {LifecycleReceipt} record @param {LifecycleTarget} target */
  async interrupt(record, target) {
    /** @type {Project} */
    let project;
    /** @type {CoreClient} */
    let client;
    try {
      project = this.currentTarget(target);
      if (
        !project.client?.ready ||
        !project.client.capabilities?.methods?.includes("turn/interrupt")
      )
        throw failure("当前 Core 不支持精确轮次中断", "LIFECYCLE_UNSUPPORTED");
      client = project.client;
      const turn = await this.readLiveTurn(project, target, record.threadId, record.turnId);
      if (turn?.status !== "inProgress")
        throw failure("原轮次已结束，请刷新聊天状态", "TURN_NOT_ACTIVE");
    } catch (error) {
      target.phase = "blocked";
      target.error = this.error(error);
      return;
    }
    target.phase = "acceptedPending";
    await this.store(record);
    try {
      this.currentTarget(target);
      /** @type {(project:Project,client:CoreClient|null|undefined)=>void} */
      const requireConnection = this.backend.requireConnection;
      requireConnection.call(this.backend, project, client);
      await client.request("turn/interrupt", { threadId: record.threadId, turnId: record.turnId });
      const deadline = Date.now() + 10000;
      do {
        if ((await this.inspectInterrupt(record, target)) === "completed") break;
        await pause(50);
      } while (Date.now() < deadline);
    } catch (error) {
      target.phase = "admissionUnconfirmed";
      target.error = this.error(error);
      await this.inspectInterrupt(record, target).catch(() => {});
    }
  }

  /** @param {LifecycleReceipt} record @param {LifecycleTarget} target */
  async inspectInterrupt(record, target) {
    const project = this.backend.projects.get(target.projectId);
    let turn;
    if (
      project?.client?.ready &&
      project.service?.serviceId === target.serviceId &&
      project.service.generation === target.generation
    ) {
      turn = await this.readLiveTurn(project, target, record.threadId, record.turnId);
    } else {
      if (
        typeof record.threadId !== "string" ||
        typeof record.turnId !== "string" ||
        !record.threadId ||
        !record.turnId
      )
        throw failure("原轮次身份不完整", "LIFECYCLE_RECEIPT_INVALID");
      turn = await readOriginalTurn(this.backend, target, record.threadId, record.turnId);
    }
    applyTurnReceipt(record, target, turn);
    return target.phase;
  }

  /** @param {unknown} requestId */
  reconcile(requestId) {
    const task = this.tail
      .catch(() => {})
      .then(async () => {
        const record = await this.read(requestId);
        if (!record) return null;
        if (!record.sharedHost && this.backend.host) {
          const legacy = await reconcileLifecycleReceipt(this.backend.home, {
            requestId: record.requestId,
            binary: this.backend.binary,
            harnessHome: record.harnessHome,
            redact: (value) => this.backend.providers.redact(value),
          });
          if (legacy) await this.store(legacy);
          return legacy;
        }
        await reconcileReceipt(record, {
          readHost: (target) => readStop(this.backend, target),
          inspectTurn: async (receipt, target) => {
            await this.inspectInterrupt(receipt, target);
          },
          completed: (target) => detachStoppedProject(this.backend, target),
          redact: (value) => this.backend.providers.redact(value),
        });
        await this.store(record);
        return record;
      });
    this.tail = task.catch(() => {});
    return task;
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
