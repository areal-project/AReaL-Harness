// @ts-check
"use strict";
const { randomUUID } = require("node:crypto");
const {
  createProjectState,
  submissionKey,
  sameSubmission,
  isAwaitingResponse,
  parsePendingSubmissions,
  parseSubmissionOutcomes,
  isPendingSubmission,
  isRemoteRecord,
} = require("./project-state.cjs");
const { desktopError } = require("@areal/workbench/desktop-contract");
const { managementMethods } = require("./management.cjs");
const { readWorkgroup, readProcesses, submissionError } = require("./submission-results.cjs");
const { readThreadMetadata } = require("./history-contract.cjs");
const { modelRecord, isCoreTask } = require("@areal/workbench/core-model-contract");
const { taskMutationMethods } = require("./tasks.cjs");

/** @typedef {import('./project-state.cjs').CoreProject} Project */
/** @typedef {import('@areal/runtime-client/core').CoreClient} Client */
/** @typedef {import('./project-state.cjs').PendingSubmission} Pending */
/** @typedef {import('./project-state.cjs').SubmissionParams} Params */
/** @typedef {import('./project-state.cjs').SubmissionOutcome} Outcome */
/** @typedef {import('./project-state.cjs').RemotePending} RemotePending */
/** @typedef {import('./project-state.cjs').RemoteRecord} RemoteRecord */
/** @typedef {import('./project-state.cjs').RemoteAssociation} RemoteAssociation */
/** @typedef {import('./receipt-contract.cjs').Receipt} Receipt */
/** @typedef {{version:1,pending:Pending[],outcomes:Record<string,Outcome>}} JournalSnapshot */
/** @typedef {(method:string,params:Params,options?:{timeoutMs?:number})=>Promise<unknown>} CoreRequest */
/** @typedef {{client?:Client|null,generation?:number,deadline?:number,observeOnly?:boolean}} ReconcileOptions */
/** @typedef {Pick<InstanceType<typeof import('./backend.cjs').CoreBackend>,'worktrees'|'lifecycleOperations'|'providers'|'rustDomains'> & {
 * host:Pick<InstanceType<typeof import("@areal/client/node").HostClient>,"journal">,closing:boolean,saved:import('./project-index.cjs').SavedProject[],projects:Map<string,Project>,awaitingResponses:Set<string>,onChange:()=>void,
 * currentConnection:(project:Project,client:Client|null|undefined)=>client is Client,
 * requireConnection:(project:Project,client:Client|null|undefined)=>void,openThread:(project:Project,threadId:string)=>Promise<unknown>,
 * supportsBoundedHistory:(client:Client|null|undefined)=>boolean,readObservation:(project:Project,threadId:string,options:import('./history-state.cjs').ReadOptions)=>Promise<import('./history-contract.cjs').ObservationResult>,
 * refreshConfiguration:(project:Project,threadId:string)=>Promise<unknown>,refreshAfterAdmission:(project:Project,threadId:string|undefined,operation?:import('@areal/runtime-client/core').OperationRef)=>Promise<unknown>
 * }} SubmissionHost */

// Owns pending/outcome writes and original-receipt reconciliation. Missing receipts
// remain UNKNOWN; recovery never resubmits a mutation or creates a new request ID.
const workgroupMutationMethods = new Set([
  "areal/workgroup/start",
  "areal/workgroup/revise",
  "areal/workflow/start",
]);
const reconciliationDelays = [500, 1000, 2000, 4000, 8000];
const {
  isRemoteControl,
  creationTargets,
  processControls,
  operationOf,
  explicitRejection,
  readReceipts,
  matchingReceipt,
  reconcileReceipt,
  receiptStatus,
  receiptResult,
  readReceiptIdentity,
} = require("./receipt-contract.cjs");

class SubmissionRecovery {
  /** @param {SubmissionHost} host */
  constructor(host) {
    this.host = host;
    /** @type {Map<string,Promise<Project>>} */
    this.journalLoads = new Map();
  }

  /** @param {string} id @returns {Promise<Project>} */
  loadProjectJournal(id) {
    this.journalLoads ??= new Map();
    const existing = this.journalLoads.get(id);
    if (existing) return existing;
    const task = (async () => {
      const saved = this.host.saved.find((project) => project.id === id);
      if (!saved) throw new Error("未知项目");
      const { CoreTaskModel } = await import("@areal/workbench/core-model");
      let project = this.host.projects.get(id);
      if (!project) {
        project = createProjectState(saved, new CoreTaskModel());
        this.host.projects.set(id, project);
        const owner = project;
        project.model.subscribe(() => {
          void this.host.worktrees.observeProject(owner).catch(
            /** @param {unknown} error */ (error) => {
              owner.error = error instanceof Error ? error.message : String(error);
              this.host.onChange();
            },
          );
          this.host.onChange();
        });
      }
      await this.refreshProjectJournal(project);
      if (
        this.host.projects.get(id) !== project ||
        !this.host.saved.some((value) => value.id === id)
      )
        throw new Error("项目登记已变化");
      return project;
    })();
    this.journalLoads.set(id, task);
    const clear = () => {
      if (this.journalLoads.get(id) === task) this.journalLoads.delete(id);
    };
    task.then(clear, clear);
    return task;
  }

  /** @param {Project} project @param {import('@areal/client/node').JournalSnapshot} snapshot */
  projectJournal(project, snapshot) {
    const pending = parsePendingSubmissions(snapshot.pending);
    const outcomes = parseSubmissionOutcomes(snapshot.outcomes);
    project.pending = pending;
    project.outcomes = outcomes;
    project.journalLoaded = true;
    this.host.onChange();
  }

  /** @param {Project} project */
  refreshProjectJournal(project) {
    const task = (project.journalWrite ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const { snapshot } = await this.host.host.journal(project.id).read();
        this.projectJournal(project, snapshot);
      });
    project.journalWrite = task;
    return task;
  }

  /** @param {Project} project @param {(snapshot:JournalSnapshot)=>JournalSnapshot} change */
  changeJournal(project, change) {
    const task = (project.journalWrite ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        /** @type {import('@areal/client/node').JournalSnapshot|undefined} */
        let committed;
        await this.host.host.journal(project.id).change((snapshot) => {
          committed = change({
            version: 1,
            pending: parsePendingSubmissions(snapshot.pending),
            outcomes: parseSubmissionOutcomes(snapshot.outcomes),
          });
          return committed;
        });
        if (!committed) throw new Error("Host 未返回已提交日志");
        this.projectJournal(project, committed);
      });
    project.journalWrite = task;
    return task;
  }

  /** @param {Project} project @param {(entries:Pending[],outcomes:Record<string,Outcome>)=>Pending[]} change */
  changePending(project, change) {
    return this.changeJournal(project, (snapshot) => ({
      ...snapshot,
      pending: change(snapshot.pending, snapshot.outcomes),
    }));
  }

  /** @param {Project} project @param {(outcomes:Record<string,Outcome>)=>Record<string,Outcome>} change */
  changeOutcomes(project, change) {
    return this.changeJournal(project, (snapshot) => ({
      ...snapshot,
      outcomes: change(snapshot.outcomes),
    }));
  }

  /** @param {Project} project @param {Pending} entry @param {unknown} input @param {number} [planRevision] */
  async rememberWorkgroupOutcome(project, entry, input, planRevision) {
    const value = readWorkgroup(input);
    const requestId = entry.params.requestId;
    if (!requestId) throw new Error("工作组请求标识缺失");
    planRevision ??= value.record.planRevision;
    await this.changeOutcomes(project, (outcomes) => ({
      ...outcomes,
      [requestId]: {
        accepted: true,
        method: entry.method,
        workgroupId: value.id,
        planRevision,
      },
    }));
  }

  /** @param {Project} project @param {string} requestId */
  async recoverWorkgroupSubmission(project, requestId) {
    await this.refreshProjectJournal(project);
    if (this.host.rustDomains.includes("execution-rust")) {
      const { HostCoreClient } = require("@areal/workbench-service/host-core-client");
      const entry = project.pending.find((item) => item.params.requestId === requestId && workgroupMutationMethods.has(item.method));
      if (entry && project.client instanceof HostCoreClient && !isAwaitingResponse(this.host.awaitingResponses, project.id, entry))
        await project.client.reconcile(entry.method, entry.params);
      await this.refreshProjectJournal(project);
      return project.outcomes[requestId]?.workgroupId ? project.outcomes[requestId] : null;
    }
    const entry = project.pending.find(
      (item) => item.params.requestId === requestId && workgroupMutationMethods.has(item.method),
    );
    if (entry && isAwaitingResponse(this.host.awaitingResponses, project.id, entry)) return null;
    let receipt = project.outcomes?.[requestId];
    if (!receipt?.workgroupId && entry?.method === "areal/workgroup/revise") {
      if (!project.client) throw new Error("Core 连接尚未就绪");
      const value = readWorkgroup(
        await project.client.request("areal/workgroup/read", { id: entry.params.id }),
      );
      const revision = value.record.revisions?.[requestId];
      if (
        revision &&
        entry.params.expectedRevision !== undefined &&
        revision.planRevision === entry.params.expectedRevision + 1
      ) {
        await this.rememberWorkgroupOutcome(project, entry, value, revision.planRevision);
        receipt = project.outcomes[requestId];
      }
    }
    // Creation has no public Core receipt lookup. An absent record is unknown,
    // never a reason to retry a mutation or identify a similar-looking group.
    if (!receipt?.workgroupId || !workgroupMutationMethods.has(receipt.method ?? "")) return null;
    if (entry && !this.host.rustDomains.includes("execution-rust"))
      await this.changePending(project, (pending) =>
        pending.filter((item) => !sameSubmission(project.id, item, entry)),
      );
    return receipt;
  }

  /** @param {Project} project @param {string} threadId @param {string} requestId @param {CoreRequest} [requestCore] */
  async recoverProcessSubmission(
    project,
    threadId,
    requestId,
    requestCore = project.client?.request.bind(project.client),
  ) {
    await this.refreshProjectJournal(project);
    const entry = project.pending.find((item) => item.params.requestId === requestId);
    if (
      entry &&
      (entry.method !== "areal/process/start" ||
        entry.params.threadId !== threadId ||
        isAwaitingResponse(this.host.awaitingResponses, project.id, entry))
    )
      return null;
    const client = project.client;
    if (!client || !requestCore) throw new Error("Core 连接尚未就绪");
    const native = this.host.rustDomains.includes("execution-rust");
    const value = native ? { data: [await this.readReceipt(project, entry ?? { method: "areal/process/start", params: { threadId, requestId } }, client)].filter((receipt) => receipt !== undefined) }
      : readReceipts(await requestCore("areal/request/read", { threadId, requestId }));
    const receipt = native ? value.data[0] : matchingReceipt(
      entry ?? { method: "areal/process/start", params: { threadId, requestId } },
      value.data,
      threadId,
    );
    const result = modelRecord(receipt?.result) ? receipt.result : undefined;
    if (typeof result?.id !== "string") return null;
    if (!project.client) throw new Error("Core 连接尚未就绪");
    const processes = readProcesses(await requestCore("areal/process/list", { threadId }));
    const process = processes.data.find((item) => item.id === result.id);
    // A durable acceptance can precede actual process startup. Only attach once
    // it has a Runtime process, or confirmed cleanup proves it has ended.
    if (!process || (!process.processId && !process.cleanupConfirmed)) return null;
    // process/list includes historical epochs. Core's get validates the live
    // Runtime handle; an old/unavailable handle must not become an attached PTY.
    if (!process.cleanupConfirmed) {
      if (!project.client) throw new Error("Core 连接尚未就绪");
      await requestCore("areal/process/get", { threadId, id: process.id });
    }
    if (entry && !this.host.rustDomains.includes("execution-rust"))
      await this.changePending(project, (pending) =>
        pending.filter((item) => !sameSubmission(project.id, item, entry)),
      );
    if (native && entry) {
      const { HostCoreClient } = require("@areal/workbench-service/host-core-client");
      if (client instanceof HostCoreClient) await client.reconcile(entry.method, entry.params);
      await this.refreshProjectJournal(project);
    }
    return {
      ...result,
      argv: process.argv,
      closed: process.cleanupConfirmed === true,
      controls: process.inputs.length,
    };
  }

  /** @param {Project} project @param {string} parentThreadId @param {string} requestId */
  async recoverAgentSubmission(project, parentThreadId, requestId) {
    await this.refreshProjectJournal(project);
    const entry = project.pending.find(
      (item) => item.params.requestId === requestId && item.method === "areal/agent/spawn",
    );
    if (
      entry &&
      (isAwaitingResponse(this.host.awaitingResponses, project.id, entry) ||
        entry.params.parentThreadId !== parentThreadId)
    )
      return null;
    const receipt = project.outcomes?.[requestId];
    if (
      receipt?.method !== "areal/agent/spawn" ||
      receipt.accepted !== true ||
      receipt.parentThreadId !== parentThreadId ||
      typeof receipt.threadId !== "string" ||
      typeof receipt.turnId !== "string"
    )
      return null;
    if (entry && !this.host.rustDomains.includes("execution-rust"))
      await this.changePending(project, (pending) =>
        pending.filter((item) => !sameSubmission(project.id, item, entry)),
      );
    return receipt;
  }

  /** @param {Pick<Project,"pending"|"outcomes">} project @param {Record<string,unknown>} association @returns {RemoteRecord|undefined} */
  remoteRecord(project, association) {
    /** @param {Pending|Outcome} value @returns {value is RemoteRecord} */
    const matches = (value) =>
      isRemoteRecord(value) &&
      ["hostId", "devicePeerId", "projectId", "commandId"].every(
        (key) => value.remote[key] === association[key],
      );
    const value =
      Object.values(project.outcomes ?? {}).find(matches) ?? project.pending.find(matches);
    return value && isRemoteRecord(value) ? value : undefined;
  }

  /** @param {Project} project @param {Record<string,unknown>} association @param {(entry:RemotePending)=>void} [beforeReceipt] @returns {Promise<Pending|Outcome|null>} */
  async readRemoteRecord(project, association, beforeReceipt) {
    await this.refreshProjectJournal(project);
    const entry = this.remoteRecord(project, association);
    return entry ? this.recoverRemoteSubmission(project, entry, beforeReceipt) : null;
  }

  /** @param {Project} project @param {RemotePending} entry @param {unknown} result @param {unknown} error */
  async rememberRemoteOutcome(project, entry, result, error) {
    const fields = modelRecord(result) ? result : undefined;
    const goal = modelRecord(fields?.goal) ? fields.goal : undefined;
    const thread = modelRecord(fields?.thread) ? fields.thread : undefined;
    const turn = modelRecord(fields?.turn) ? fields.turn : undefined;
    /** @type {unknown[]} */
    const runs = Array.isArray(fields?.runs) ? fields.runs : [];
    const candidate = runs.at(-1);
    const last = modelRecord(candidate) ? candidate : undefined;
    const failure = modelRecord(error) ? error : undefined;
    const taskReply =
      entry.method === "areal/channel/reply" && entry.remote.method === "task.question.reply";
    const taskPause = entry.method === "areal/task/pause" && entry.remote.method === "task.pause";
    let receipt;
    if (entry.method === "areal/turn/enqueue" && !error) {
      if (
        typeof fields?.queueItemId !== "string" ||
        !fields.queueItemId ||
        Buffer.byteLength(fields.queueItemId) > 128
      )
        throw new Error("排队受理结果缺少原生关联");
      receipt = { queueItemId: fields.queueItemId };
    }
    if (entry.method === "areal/goal/create" && !error) {
      if (
        typeof goal?.id !== "string" ||
        !fields ||
        typeof fields.revision !== "number" ||
        !Number.isSafeInteger(fields.revision)
      )
        throw new Error("目标受理结果不完整");
      receipt = { goalId: goal.id, revision: fields.revision };
    }
    if (taskPause && !error) {
      if (
        !fields ||
        fields.id !== entry.params.taskId ||
        fields.paused !== true ||
        last?.id !== entry.params.expectedRunId ||
        typeof fields.revision !== "number" ||
        !Number.isSafeInteger(fields.revision) ||
        entry.params.expectedRevision === undefined ||
        fields.revision !== entry.params.expectedRevision + 1
      )
        throw new Error("Task 暂停受理结果不完整");
      receipt = {
        taskId: fields.id,
        runId: entry.params.expectedRunId,
        revision: fields.revision,
        paused: true,
      };
    }
    if (taskReply && !error) {
      if (
        fields?.accepted !== true ||
        ["messageId", "taskId", "runId"].some((key) => {
          const value = fields[key];
          return typeof value !== "string" || !value || Buffer.byteLength(value) > 128;
        }) ||
        fields.taskId !== entry.params.taskId ||
        fields.runId !== entry.params.runId ||
        typeof fields.channelSequence !== "number" ||
        !Number.isSafeInteger(fields.channelSequence) ||
        fields.channelSequence < 1
      )
        throw new Error("Task 原生受理结果不完整");
      receipt = {
        accepted: true,
        messageId: fields.messageId,
        taskId: fields.taskId,
        runId: fields.runId,
        channelSequence: fields.channelSequence,
      };
    }
    const threadId = taskReply || taskPause ? undefined : (entry.params.threadId ?? thread?.id);
    const turnId =
      taskReply || taskPause
        ? undefined
        : ["turn/interrupt", "areal/interaction/respond"].includes(entry.method)
          ? entry.params.turnId
          : turn?.id;
    if (
      (threadId !== undefined &&
        (typeof threadId !== "string" || Buffer.byteLength(threadId) > 128)) ||
      (turnId !== undefined && (typeof turnId !== "string" || Buffer.byteLength(turnId) > 128))
    )
      throw new Error("原生关联超过预算");
    if (
      !error &&
      !taskReply &&
      !taskPause &&
      (typeof threadId !== "string" ||
        (entry.method === "areal/turn/start" && typeof turnId !== "string"))
    )
      throw new Error("原生受理结果不完整");
    const outcome = {
      operationId: entry.operationId,
      remote: entry.remote,
      method: entry.method,
      accepted: !error,
      admissionState: error ? "rejected" : "accepted",
      ...(receipt ? { receipt } : {}),
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(error
        ? {
            error: {
              code: failure?.code ?? "CORE_UNAVAILABLE",
              ...(typeof (failure?.coreCode ?? failure?.code) === "number"
                ? { coreCode: failure?.coreCode ?? failure?.code }
                : {}),
            },
          }
        : {}),
    };
    if (Buffer.byteLength(JSON.stringify(outcome)) > 4096) throw new Error("受理结果超过预算");
    // 终态先落盘，再移除 pending；并发查询不能覆盖已保存的完整关联。
    await this.changeOutcomes(project, (outcomes) =>
      outcomes[entry.operationId]?.remote
        ? outcomes
        : { ...outcomes, [entry.operationId]: outcome },
    );
    try {
      await this.changePending(project, (pending) =>
        pending.filter((value) => !sameSubmission(project.id, value, entry)),
      );
    } catch {
      /* 已落盘终态优先；遗留 pending 可在下次只读查询时清理。 */
    }
    return project.outcomes[entry.operationId];
  }

  /** @param {Project} project @param {RemoteRecord} entry @param {(entry:RemotePending)=>void} [beforeReceipt] @returns {Promise<Pending|Outcome>} */
  async recoverRemoteSubmission(project, entry, beforeReceipt) {
    await this.refreshProjectJournal(project);
    const known = project.outcomes?.[entry.operationId];
    if (known?.remote) {
      const pendingEntry = project.pending.find((value) => value.operationId === entry.operationId);
      if (pendingEntry) {
        try {
          await this.changePending(project, (pending) =>
            pending.filter((value) => !sameSubmission(project.id, value, pendingEntry)),
          );
        } catch {}
      }
      return known;
    }
    if (
      !isPendingSubmission(entry) ||
      isAwaitingResponse(this.host.awaitingResponses, project.id, entry) ||
      !project.client?.ready ||
      project.client.closed ||
      !project.model?.state?.connected
    )
      return entry;
    if (
      ![
        "areal/thread/start",
        "areal/turn/start",
        "areal/turn/submit",
        "areal/turn/enqueue",
        "areal/thread/configure",
        ...["update", "remove", "reorder", "pause", "resume", "steer"].map(
          (op) => `areal/queue/${op}`,
        ),
        ...["create", "pause", "resume", "clear"].map((op) => `areal/goal/${op}`),
      ].includes(entry.method)
    )
      return entry;
    const client = project.client,
      generation = project.service?.generation;
    try {
      beforeReceipt?.(entry);
      // 精确查询原生键，不打开 Thread、不配置、不重放；离线只返回已有日志。
      const receipt = await this.readReceipt(project, entry, client);
      if (project.client !== client || project.service?.generation !== generation) return entry;
      if (receipt?.accepted === false)
        return await this.rememberRemoteOutcome(project, entry, undefined, {
          ...receipt.error,
          outcome: { kind: "rejected" },
        });
      /** @type {import('./receipt-contract.cjs').ReceiptResponse|null|undefined} */
      const response =
        entry.method === "areal/thread/start" && typeof receipt?.threadId === "string"
          ? { result: { thread: { id: receipt.threadId } } }
          : receipt?.result
            ? { result: receipt.result }
            : receipt?.state === "completed"
              ? receipt.response
              : undefined;
      if (response?.error && !explicitRejection(response.error.data ?? response.error))
        return entry;
      if (response)
        return await this.rememberRemoteOutcome(project, entry, response.result, response.error);
    } catch {
      /* 查询失败或空收据都不能证明未执行。 */
    }
    return project.outcomes?.[entry.operationId] ?? entry;
  }

  /** @param {Project} project @param {string} method @param {Params} parameters @param {RemoteAssociation} remote @param {(entry:RemotePending)=>Promise<unknown>} dispatch */
  async submitRemote(project, method, parameters, remote, dispatch) {
    const operationId = randomUUID();
    // interrupt 无请求键，respond 的 requestId 是交互领域标识；日志 UUID 不得覆盖它们。
    const entry = {
      method,
      operationId,
      createdAt: new Date().toISOString(),
      params: {
        ...structuredClone(parameters),
        ...(["turn/interrupt", "turn/steer", "areal/interaction/respond"].includes(method)
          ? {}
          : { requestId: operationId }),
      },
      remote: structuredClone(remote),
    };
    if (Buffer.byteLength(JSON.stringify(entry)) > 72 * 1024)
      throw Object.assign(new Error("提交记录超过预算"), { code: "LIMIT_EXCEEDED" });
    let original;
    const key = submissionKey(project.id, entry);
    if (key === null) throw new Error("原请求标识缺失");
    this.host.awaitingResponses.add(key);
    try {
      await this.changePending(project, (pending, outcomes) => {
        original = this.remoteRecord({ pending, outcomes }, remote);
        if (original) {
          if (original.remote.semanticDigest !== remote.semanticDigest)
            throw Object.assign(new Error("命令标识已用于不同内容"), { code: "COMMAND_CONFLICT" });
          return pending;
        }
        if (pending.length + Object.keys(outcomes).length >= 4096)
          throw Object.assign(new Error("提交日志容量已满"), { code: "CAPACITY_EXCEEDED" });
        if (
          !["turn/interrupt", "areal/interaction/respond"].includes(method) &&
          parameters.threadId &&
          project.configurationChanges?.has(parameters.threadId ?? "")
        )
          throw Object.assign(new Error("会话配置正在变化"), { code: "TARGET_CHANGED" });
        if (
          !["turn/interrupt", "areal/interaction/respond"].includes(method) &&
          parameters.threadId &&
          pending.some(
            (value) =>
              !isRemoteControl(value) &&
              value.params.threadId === parameters.threadId &&
              !(value.remote && value.operationId && outcomes[value.operationId]?.remote),
          )
        )
          throw Object.assign(new Error("此会话有未结算提交"), {
            code: "SUBMISSION_UNKNOWN",
            submissionUnknown: true,
          });
        return [...pending, entry];
      });
      if (original) return this.recoverRemoteSubmission(project, original);
      let result, error;
      try {
        result = await dispatch(entry);
      } catch (cause) {
        if (modelRecord(cause) && (cause.submissionUnknown || cause.code === -32603)) return entry;
        error = cause;
      }
      try {
        return await this.rememberRemoteOutcome(project, entry, result, error);
      } catch {
        return entry;
      }
    } finally {
      this.host.awaitingResponses.delete(key);
      this.scheduleReconciliation(project);
      this.host.onChange();
    }
  }

  /** @param {Project} project @param {string} method @param {Params} parameters */
  assertConfigurationReady(project, method, parameters) {
    if (method !== "areal/thread/configure" && project.configurationChanges?.has(parameters.threadId ?? ""))
      throw new Error("会话配置正在更新，请稍后再发送任务");
  }

  /** @param {Project} project @param {string} method @param {Params} parameters @param {{requestId?:string,remote?:RemoteAssociation,dispatch?:(entry:RemotePending)=>Promise<unknown>,requestCore?:CoreRequest,submissionClient?:import('@areal/workbench-service/host-core-client').HostCoreClient,preDispatch?:()=>boolean}} [options] */
  async submit(
    project,
    method,
    parameters,
    { requestId, remote, dispatch, requestCore, submissionClient, preDispatch } = {},
  ) {
    const observationError = project.observationErrors?.[parameters.threadId ?? ""];
    if (
      observationError &&
      [
        "areal/turn/start",
        "areal/turn/enqueue",
        "areal/turn/submit",
        "turn/start",
        "turn/steer",
        "areal/queue/resume",
        "areal/queue/steer",
        "areal/goal/create",
        "areal/goal/resume",
      ].includes(method)
    ) {
      throw Object.assign(new Error(observationError.message), {
        code: observationError.code,
        submissionUnknown: false,
      });
    }
    const journal =
      method === "areal/thread/start"
        ? project.client?.capabilities?.features?.threadCreationJournal
        : undefined;
    const boundParameters = journal
      ? { ...parameters, creationAdmission: { ...journal.binding } }
      : parameters;
    if (remote) {
      if (!dispatch) throw new Error("Remote 提交入口缺失");
      return this.submitRemote(project, method, boundParameters, remote, dispatch);
    }
    if (this.host.rustDomains.includes("execution-rust")) {
      this.assertConfigurationReady(project, method, parameters);
      const { HostCoreClient } = require("@areal/workbench-service/host-core-client");
      const client = submissionClient ?? project.client;
      if (!(client instanceof HostCoreClient)) throw new Error("Host Core 投影尚未就绪");
      if (requestId !== undefined && (typeof requestId !== "string" || !/^[0-9a-f-]{36}$/.test(requestId)))
        throw new Error("无效请求标识");
      if (preDispatch && !preDispatch())
        throw Object.assign(new Error("订阅模型同步目标已变化"), { submissionUnknown: false });
      const params = { ...boundParameters, requestId: requestId ?? randomUUID() };
      const entry = { method, params, operation: operationOf(method, params) };
      const key = submissionKey(project.id, entry);
      if (!key || this.host.awaitingResponses.has(key)) throw new Error("请求标识已使用，请核对原提交；不会重复执行。");
      this.host.awaitingResponses.add(key);
      try {
        const result = await client.submit(method, params, requestId !== undefined || ["areal/turn/submit", "areal/agent/spawn"].includes(method));
        await this.refreshProjectJournal(project);
        await this.acceptModelSelection(project, result, entry);
        return result;
      } finally {
        this.host.awaitingResponses.delete(key);
        this.scheduleReconciliation(project);
        this.host.onChange();
      }
    }
    const semantics = project.client?.capabilities?.methodSemantics?.[method];
    if (semantics && semantics.effect !== "mutation") throw new Error("此方法不是业务写入");
    if (
      requestId !== undefined &&
      (typeof requestId !== "string" || !/^[0-9a-f-]{36}$/.test(requestId))
    )
      throw new Error("无效请求标识");
    const params = { ...boundParameters, requestId: requestId ?? randomUUID() };

    const entry = {
      method,
      params,
      operation: operationOf(method, params),
      createdAt: new Date().toISOString(),
    };
    // 活跃请求仅保存在内存；重启后仍在恢复日志中的请求应显示为结果未知。
    const key = submissionKey(project.id, entry);
    if (key === null) throw new Error("原请求标识缺失");
    if (this.host.awaitingResponses.has(key))
      throw new Error("请求标识已使用，请核对原提交；不会重复执行。");
    this.host.awaitingResponses.add(key);
    try {
      // 检查与持久化在同一队列中，两个同时到达的发送不能穿透阻塞。
      await this.changePending(project, (pending, outcomes) => {
        if (
          outcomes[params.requestId] ||
          pending.some((value) => value.params.requestId === params.requestId)
        )
          throw new Error("请求标识已使用，请核对原提交；不会重复执行。");
        this.assertConfigurationReady(project, method, parameters);
        const conflicting = ["areal/thread/fork", "areal/side/start", "areal/side/create"].includes(
          method,
        )
          ? pending.find(
              (value) =>
                value.method === method &&
                value.params.sourceThreadId === parameters.sourceThreadId,
            )
          : pending.find(
              (value) =>
                !isRemoteControl(value) &&
                (parameters.taskId
                  ? value.params.taskId === parameters.taskId
                  : parameters.threadId
                    ? value.params.threadId === parameters.threadId
                    : false) &&
                !(value.remote && value.operationId && outcomes[value.operationId]?.remote),
            );
        if (conflicting) {
          const awaiting = isAwaitingResponse(this.host.awaitingResponses, project.id, conflicting);
          throw Object.assign(
            new Error(
              awaiting
                ? "当前操作正在等待响应，请稍后再试"
                : "上一次提交结果未知，请先查询受理结果",
            ),
            awaiting
              ? {}
              : {
                  submissionUnknown: true,
                  requestId: conflicting.params.requestId,
                  outcome: {
                    kind: "unconfirmed",
                    operation:
                      conflicting.operation ?? operationOf(conflicting.method, conflicting.params),
                  },
                  recovery: { kind: "queryOriginal" },
                },
          );
        }
        return [...pending, entry];
      });
      let result,
        dispatchStarted = false;
      try {
        if (this.host.closing) throw new Error("应用正在退出");
        if (preDispatch && !preDispatch())
          throw Object.assign(new Error("订阅模型同步目标已变化"), { submissionUnknown: false });
        dispatchStarted = true;
        result = await this.requestSubmission(project, method, params, requestCore);
      } catch (cause) {
        const error = submissionError(cause);
        if (!dispatchStarted || explicitRejection(error)) {
          try {
            await this.changePending(project, (pending) =>
              pending.filter((value) => !sameSubmission(project.id, value, entry)),
            );
          } catch {
            throw Object.assign(new Error("原请求结果已知，但恢复日志更新失败；请检查本机存储"), {
              submissionUnknown: true,
              requestId: params.requestId,
              outcome: { kind: "unconfirmed", operation: entry.operation },
              recovery: { kind: "queryOriginal" },
            });
          }
        }
        if (dispatchStarted && !explicitRejection(error))
          Object.assign(error, {
            submissionUnknown: true,
            outcome: error.outcome ?? { kind: "unconfirmed", operation: entry.operation },
            recovery: error.recovery ?? { kind: "queryOriginal" },
          });
        error.requestId = params.requestId;
        throw error;
      }
      try {
        if (workgroupMutationMethods.has(method))
          await this.rememberWorkgroupOutcome(project, entry, result);
        else if (
          requestId !== undefined ||
          ["areal/turn/submit", "areal/agent/spawn"].includes(method)
        )
          await this.rememberOutcome(project, entry, { status: "completed", result });
        await this.changePending(project, (pending) =>
          pending.filter((value) => !sameSubmission(project.id, value, entry)),
        );
      } catch {
        project.refreshErrors ??= {};
        project.refreshErrors[params.requestId] = {
          id: randomUUID(),
          projectId: project.id,
          connectionGeneration: project.connectionGeneration,
          operation: entry.operation,
          message: "Core 已受理，本机恢复记录尚未更新。",
          refreshPending: true,
        };
      }
      await this.acceptModelSelection(project, result, entry);
      return result;
    } finally {
      this.host.awaitingResponses.delete(key);
      this.scheduleReconciliation(project);
      this.host.onChange();
    }
  }

  /** @param {Project} project @param {unknown} result @param {Pending & {params:Params & {requestId:string}}} entry */
  async acceptModelSelection(project, result, entry) {
    try {
      await this.host.providers.acceptModelSelection(
        modelRecord(result) ? result.lastAcceptedModel : undefined,
      );
    } catch (error) {
      project.refreshErrors ??= {};
      project.refreshErrors[entry.params.requestId] ??= {
        id: randomUUID(),
        projectId: project.id,
        scope: "modelSelection",
        connectionGeneration: project.connectionGeneration,
        operation: entry.operation,
        message: this.host.providers.redact(
          error instanceof Error ? error.message : String(error),
        ),
        refreshPending: false,
      };
    }
  }

  /** @param {Project} project @param {Params} params @param {unknown} result @param {unknown} [cause] @param {CoreRequest} [requestCore] */
  async processControlOutcome(
    project,
    params,
    result,
    cause,
    requestCore = project.client?.request.bind(project.client),
  ) {
    let value;
    try {
      if (!requestCore) throw new Error("Core 连接尚未就绪");
      value = readProcesses(await requestCore("areal/process/list", { threadId: params.threadId }));
    } catch {
      throw Object.assign(new Error("无法核对终端执行结果；不会重发输入"), {
        submissionUnknown: true,
      });
    }
    if (!modelRecord(result) || typeof result.operationId !== "string")
      throw Object.assign(new Error("终端操作受理关联未确认；不会重发输入"), {
        submissionUnknown: true,
      });
    const operation = value.data
      .find((p) => p.id === params.id)
      ?.inputs.find((op) => op.operationId === result.operationId);
    if (operation?.outcome === "succeeded") return result;
    if (operation?.outcome === "failed")
      throw Object.assign(cause ?? new Error("终端操作执行失败；请检查进程状态"), {
        executionFailed: true,
      });
    throw Object.assign(new Error("终端操作执行结果未确认；不会重发输入"), {
      submissionUnknown: true,
    });
  }

  /** @param {Project} project @param {string} method @param {Params} params @param {CoreRequest} [requestCore] @returns {Promise<unknown>} */
  async requestSubmission(
    project,
    method,
    params,
    requestCore = project.client?.request.bind(project.client),
  ) {
    const client = project.client;
    if (!client || !requestCore) throw new Error("Core 连接尚未就绪");
    if (method === "areal/blob/release") {
      let current;
      try {
        current = this.host.supportsBoundedHistory(project.client)
          ? await this.host.readObservation(project, params.threadId ?? "", { install: false })
          : await client.request(
              "thread/read",
              { threadId: params.threadId, includeTurns: false },
              { decode: readThreadMetadata },
            );
      } catch (error) {
        throw Object.assign(
          new Error(
            `无法核对附件所属会话：${error instanceof Error ? error.message : String(error)}`,
          ),
          { outcome: { kind: "rejected" } },
        );
      }
      if (current.thread.desktop?.archived)
        throw Object.assign(new Error("归档会话只读，不能释放附件"), {
          outcome: { kind: "rejected" },
        });
    }
    const { requestId, previousItems: _previousItems, ...steer } = params;
    const { threadId: _threadId, ...spawn } = steer;
    if (!project.client) throw new Error("Core 连接尚未就绪");
    const durableSteer = project.client.capabilities?.methods?.includes("areal/plugin/hooks/list");
    try {
      return await requestCore(
        method,
        method === "areal/agent/spawn"
          ? spawn
          : method === "turn/steer"
            ? { ...steer, ...(durableSteer ? { requestId } : {}) }
            : params,
        ["areal/marketplace/addGit", "areal/marketplace/update"].includes(method)
          ? { timeoutMs: 120000 }
          : undefined,
      );
    } catch (cause) {
      const error = submissionError(cause);
      if (explicitRejection(error)) throw error;
      const entry = { method, params, operation: operationOf(method, params) };
      if (workgroupMutationMethods.has(method) || method === "areal/agent/spawn") throw error;
      const client = project.client;
      let receipt;
      try {
        receipt = await this.readReceipt(project, entry, client, 2500, requestCore);
      } catch {}
      if (receipt && receiptStatus(receipt) === "completed") {
        const result = receiptResult(receipt);
        if (processControls.has(method))
          return this.processControlOutcome(project, params, result, error, requestCore);
        if (creationTargets.get(method) === "thread" && (!modelRecord(result) || !result.thread)) {
          const id = receipt.threadId ?? (modelRecord(result) ? result.threadId : undefined);
          if (id) return { thread: { id }, requestId };
        }
        return result;
      }
      if (receipt && receiptStatus(receipt) === "failed") {
        const failure = receipt.error ?? receipt.response?.error;
        if (receipt.accepted === false)
          throw Object.assign(error, {
            message: failure?.message ?? error.message,
            outcome: { kind: "rejected", operation: receipt.operation ?? entry.operation },
            submissionUnknown: false,
          });
        Object.assign(error, {
          message: failure?.message ?? error.message,
          outcome: { kind: "admitted", operation: receipt.operation ?? entry.operation },
        });
      }
      Object.assign(error, {
        requestId,
        submissionUnknown: true,
        outcome: error.outcome ?? { kind: "unconfirmed", operation: entry.operation },
        recovery: error.recovery ?? { kind: "queryOriginal" },
      });
      throw error;
    }
  }

  /** @param {Project} project @param {Pending} entry @param {Client|null|undefined} client @param {number} [timeoutMs] @param {CoreRequest} [requestCore] @returns {Promise<Receipt|undefined>} */
  async readReceipt(
    project,
    entry,
    client,
    timeoutMs = 2500,
    requestCore = client?.request.bind(client),
  ) {
    if (!client || !requestCore) throw new Error("Core 连接尚未就绪");
    const family = client.capabilities?.methodSemantics?.[entry.method]?.receipt;
    const scopedThreadId =
      entry.params.threadId &&
      (family
        ? family === "thread"
        : !managementMethods.has(entry.method) && !taskMutationMethods.has(entry.method))
        ? entry.params.threadId
        : undefined;
    const nativeReconciliation = this.host.rustDomains.includes("execution-rust") &&
      client.capabilities?.features?.submissionReceiptReconciliation === true;
    const response = await requestCore(
      "areal/request/read",
      {
        requestId: entry.params.requestId,
        ...(scopedThreadId ? { threadId: scopedThreadId } : {}),
        ...(entry.method === "areal/thread/start" && entry.params.creationAdmission &&
          client.capabilities?.features?.threadCreationJournal ? { creationAdmission: entry.params.creationAdmission } : {}),
        ...(nativeReconciliation ? { expectedSubmission: { method: entry.method, params: entry.params,
          ...(entry.operation ? { operation: entry.operation } : {}), ...(entry.digest ? { digest: entry.digest } : {}) } } : {}),
      },
      { timeoutMs },
    );
    this.host.requireConnection(project, client);
    if (nativeReconciliation) {
      if (!modelRecord(response) || !Object.hasOwn(response, "matchedReceipt")) throw new Error("Core 回执核查响应无效");
      if (response.matchedReceipt === null) return undefined;
      return readReceipts({ data: [response.matchedReceipt] }).data[0];
    }
    const result = readReceipts(
      response,
    );
    return reconcileReceipt(entry, result, client.capabilities, scopedThreadId);
  }

  /** @param {Project} project @param {string} method @param {Params & {requestId:string}} params */
  async readSubmission(project, method, params) {
    if (this.host.rustDomains.includes("execution-rust")) {
      const { HostCoreClient } = require("@areal/workbench-service/host-core-client");
      const client = project.client;
      if (!(client instanceof HostCoreClient)) throw new Error("Host Core 投影尚未就绪");
      const result = await client.reconcile(method, params);
      await this.refreshProjectJournal(project);
      return result;
    }
    await this.refreshProjectJournal(project);
    const client = project.client,
      generation = project.connectionGeneration;
    const pending = project.pending.find(
      (entry) => entry.method === method && entry.params.requestId === params.requestId,
    );
    if (
      pending &&
      ["threadId", "sourceThreadId", "taskId"].some(
        (key) => params[key] !== undefined && params[key] !== pending.params[key],
      )
    )
      throw new Error("恢复请求与原操作身份不匹配");
    if (pending && isAwaitingResponse(this.host.awaitingResponses, project.id, pending))
      return { confirmed: false, state: "admitted" };
    const known = project.outcomes?.[params.requestId];
    const entry = pending ?? {
      method,
      params,
      ...(known?.method === method && known.operation ? { operation: known.operation } : {}),
    };
    const receipt = await this.readReceipt(project, entry, client);
    const current = () =>
      this.host.currentConnection(project, client) && project.connectionGeneration === generation;
    if (!current()) throw Object.assign(new Error("连接已换代"), { code: "STALE_CONNECTION" });
    const status = receipt && receiptStatus(receipt);
    if (!receipt || !["completed", "failed"].includes(status ?? ""))
      return { confirmed: false, state: status ?? "unconfirmed" };
    if (pending) {
      await this.rememberOutcome(project, entry, receipt, current);
      if (current())
        await this.changePending(project, (entries) =>
          current()
            ? entries.filter((value) => !sameSubmission(project.id, value, pending))
            : entries,
        );
    }
    const failure = receipt.error ?? receipt.response?.error;
    const error = failure ? desktopError(failure) : undefined;
    return {
      confirmed: true,
      accepted: receipt.accepted !== false,
      status,
      operation: receipt.operation ?? entry.operation,
      ...(error ? { error, message: error.message } : { result: receiptResult(receipt) }),
    };
  }

  /** @param {Project} project @param {Pending} entry @param {Receipt} receipt @param {()=>boolean} [current] */
  async rememberOutcome(project, entry, receipt, current = () => true) {
    const result = receiptResult(receipt),
      failure = receipt.error ?? receipt.response?.error;
    const status = receiptStatus(receipt);
    const fields = modelRecord(result) ? result : undefined;
    const thread = modelRecord(fields?.thread) ? fields.thread : undefined;
    const turn = modelRecord(fields?.turn) ? fields.turn : undefined;
    const threadId = readReceiptIdentity(
      entry.method === "areal/agent/spawn"
        ? fields?.threadId
        : (entry.params.threadId ?? receipt.threadId ?? fields?.threadId ?? thread?.id),
    );
    const taskId = readReceiptIdentity(
      entry.params.taskId ??
        receipt.taskId ??
        (taskMutationMethods.has(entry.method) ? fields?.id : undefined),
    );
    const turnId = readReceiptIdentity(fields?.turnId ?? turn?.id);
    /** @type {import('@areal/runtime-client/core').OperationRef} */
    const operation = receipt.operation ?? {
      ...(entry.operation ?? operationOf(entry.method, entry.params)),
      ...(creationTargets.get(entry.method) === "thread" && threadId
        ? { target: { kind: "thread", threadId } }
        : creationTargets.get(entry.method) === "task" && taskId
          ? { target: { kind: "task", taskId } }
          : {}),
    };
    const requestId = entry.params.requestId;
    if (!requestId) throw new Error("原请求标识缺失");
    await this.changeOutcomes(project, (outcomes) => {
      if (!current()) return outcomes;
      return {
        ...outcomes,
        [requestId]: {
          accepted: receipt.accepted !== false,
          ...(receipt.accepted === false ? { admissionState: "notAdmitted" } : {}),
          status,
          operation,
          method: entry.method,
          ...(threadId ? { threadId } : {}),
          ...(taskId ? { taskId } : {}),
          ...(entry.params.sourceThreadId ? { sourceThreadId: entry.params.sourceThreadId } : {}),
          ...(entry.params.parentThreadId ? { parentThreadId: entry.params.parentThreadId } : {}),
          ...(turnId ? { turnId } : {}),
          ...(entry.method === "turn/steer" && entry.params.input
            ? { input: entry.params.input }
            : {}),
          ...(entry.method === "areal/side/close"
            ? { cleanupConfirmed: fields?.cleanupConfirmed === true }
            : {}),
          ...(failure
            ? { message: this.host.providers.redact(failure.message ?? "Core 请求失败") }
            : {}),
          ...([
            "areal/queue/update",
            "areal/queue/pause",
            "areal/queue/resume",
            "areal/queue/remove",
            "areal/queue/reorder",
          ].includes(entry.method) &&
          fields &&
          typeof fields.revision === "number" &&
          Number.isSafeInteger(fields.revision)
            ? { result: { revision: fields.revision } }
            : {}),
        },
      };
    });
    return { result, threadId, taskId, status };
  }

  /** @param {Project} project @param {Client|null|undefined} client @param {number|undefined} generation @returns {client is Client} */
  reconciliationCurrent(project, client, generation) {
    return (
      this.host.currentConnection(project, client) &&
      client.ready &&
      project.connectionGeneration === generation &&
      !this.host.lifecycleOperations?.activeRequestId &&
      !this.host.lifecycleOperations?.activeTargets.has(project.id) &&
      !this.host.lifecycleOperations?.blocking(project.id)
    );
  }

  /** @param {Project} project */
  stopReconciliation(project) {
    clearTimeout(project.reconciliation?.timer ?? undefined);
    project.reconciliation = null;
  }

  /** @param {Project} project */
  scheduleReconciliation(project) {
    const client = project.client,
      generation = project.connectionGeneration;
    if (!project.pending?.length || !this.reconciliationCurrent(project, client, generation))
      return;
    const previous = project.reconciliation;
    if (
      previous &&
      previous.client === client &&
      previous.generation === generation &&
      (previous.timer || previous.running)
    )
      return;
    this.stopReconciliation(project);
    /** @type {import('./project-state.cjs').Reconciliation} */
    const worker = { client, generation, deadline: Date.now() + 30000, attempt: 0, running: false };
    project.reconciliation = worker;
    const current = () =>
      project.reconciliation === worker && this.reconciliationCurrent(project, client, generation);
    const schedule = () => {
      const delay =
        reconciliationDelays[Math.min(worker.attempt++, reconciliationDelays.length - 1)];
      if (!current() || !project.pending.length || Date.now() + delay >= worker.deadline) return;
      worker.timer = setTimeout(async () => {
        worker.timer = null;
        if (!current()) return;
        worker.running = true;
        try {
          await this.reconcile(project, { client, generation, deadline: worker.deadline });
        } catch {
        } finally {
          worker.running = false;
          schedule();
        }
      }, delay);
      worker.timer.unref?.();
    };
    schedule();
  }

  /** @param {Project} project @param {ReconcileOptions} [options] @returns {Promise<void>} */
  reconcile(project, options = {}) {
    const client = options.client ?? project.client,
      generation = options.generation ?? project.connectionGeneration;
    const previous = project.reconciliationRead;
    if (previous && previous.client === client && previous.generation === generation)
      return previous.promise;
    const promise = this.reconcileEntries(project, { ...options, client, generation }).finally(
      () => {
        if (project.reconciliationRead === pass) project.reconciliationRead = null;
      },
    );
    const pass = { client, generation, promise };
    project.reconciliationRead = pass;
    return promise;
  }

  /** @param {Project} project @param {ReconcileOptions} options @returns {Promise<void>} */
  async reconcileEntries(project, { client, generation, deadline = Date.now() + 30000 }) {
    if (this.host.rustDomains.includes("execution-rust")) {
      const { HostCoreClient } = require("@areal/workbench-service/host-core-client");
      if (!(client instanceof HostCoreClient)) return;
      await this.refreshProjectJournal(project);
      for (const entry of [...project.pending]) {
        if (!this.reconciliationCurrent(project, client, generation) || Date.now() >= deadline) break;
        if (!modelRecord(entry) || entry.rustOwner !== true || isAwaitingResponse(this.host.awaitingResponses, project.id, entry)) continue;
        try {
          const result = await client.reconcile(entry.method, entry.params);
          if (!this.reconciliationCurrent(project, client, generation)) break;
          if (result.confirmed === true && entry.params.requestId) {
            delete project.refreshErrors?.[entry.params.requestId];
            await this.refreshProjectJournal(project);
            const outcome = project.outcomes[entry.params.requestId];
            if (outcome?.status === "completed")
              await this.host.refreshAfterAdmission(project, outcome.threadId, outcome.operation ?? entry.operation);
          }
        } catch (error) {
          if (!this.reconciliationCurrent(project, client, generation)) break;
          project.refreshErrors ??= {};
          project.refreshErrors[entry.params.requestId ?? `legacy:${entry.params.threadId}`] = {
            id: randomUUID(), projectId: project.id, connectionGeneration: generation,
            operation: entry.operation, message: this.host.providers.redact(error instanceof Error ? error.message : String(error)),
            refreshPending: true,
          };
          this.host.onChange();
        }
      }
      await this.refreshProjectJournal(project);
      return;
    }
    await this.refreshProjectJournal(project);
    const current = () => this.reconciliationCurrent(project, client, generation);
    for (const entry of Array.from(project.pending)) {
      if (!current() || !client || Date.now() >= deadline) break;
      if (isAwaitingResponse(this.host.awaitingResponses, project.id, entry)) continue;
      try {
        if (isRemoteRecord(entry)) {
          await this.recoverRemoteSubmission(project, entry);
          continue;
        }
        if (workgroupMutationMethods.has(entry.method)) {
          if (!entry.params.requestId) throw new Error("工作组请求标识缺失");
          await this.recoverWorkgroupSubmission(project, entry.params.requestId);
          continue;
        }
        if (entry.method === "areal/agent/spawn") {
          if (!entry.params.parentThreadId || !entry.params.requestId)
            throw new Error("子任务请求关联缺失");
          await this.recoverAgentSubmission(
            project,
            entry.params.parentThreadId,
            entry.params.requestId,
          );
          continue;
        }
        if (
          entry.method === "turn/steer" &&
          !client.capabilities?.methods?.includes("areal/plugin/hooks/list") &&
          !client.capabilities?.features?.operationOutcomes
        ) {
          const threadId = entry.params.threadId,
            previousItems = entry.params.previousItems;
          if (!threadId || !previousItems) throw new Error("原引导提交的会话关联缺失");
          await this.host.openThread(project, threadId);
          if (!current()) break;
          const turn = project.model.state.threads[threadId]?.turns?.find(
            (item) => item.id === entry.params.expectedTurnId,
          );
          /** @param {unknown} input */
          const normalize = (input) => {
            if (!Array.isArray(input) || !input.every(modelRecord))
              throw new Error("原引导提交内容结构无效");
            return input.map((part) =>
              part.type === "text"
                ? { type: "text", text: part.text }
                : { type: part.type, url: part.url },
            );
          };
          const accepted = turn?.items?.some(
            (item) =>
              item.type === "userMessage" &&
              !previousItems.includes(item.id) &&
              JSON.stringify(normalize(item.content)) ===
                JSON.stringify(normalize(entry.params.input)),
          );
          if (accepted && turn) {
            await this.rememberOutcome(
              project,
              entry,
              { status: "completed", result: { turnId: turn.id } },
              current,
            );
            if (current())
              await this.changePending(project, (pending) =>
                current()
                  ? pending.filter((value) => !sameSubmission(project.id, value, entry))
                  : pending,
              );
          }
          continue;
        }
        if (entry.localOnly) {
          if (!entry.params.threadId) throw new Error("配置恢复会话关联缺失");
          await this.host.refreshConfiguration(project, entry.params.threadId);
          continue;
        }
        let receipt = await this.readReceipt(
          project,
          entry,
          client,
          Math.min(2500, Math.max(1, deadline - Date.now())),
        );
        if (
          !current() ||
          isAwaitingResponse(this.host.awaitingResponses, project.id, entry) ||
          !project.pending.some((value) => sameSubmission(project.id, value, entry)) ||
          !receipt
        )
          continue;
        if (!["completed", "failed"].includes(receiptStatus(receipt))) continue;
        if (processControls.has(entry.method) && receiptStatus(receipt) === "completed") {
          try {
            await this.processControlOutcome(project, entry.params, receiptResult(receipt));
          } catch (error) {
            if (!modelRecord(error) || !error.executionFailed) throw error;
            receipt = {
              ...receipt,
              status: "failed",
              error: { message: error instanceof Error ? error.message : String(error) },
            };
          }
        }
        if (!current()) break;
        const outcome = await this.rememberOutcome(project, entry, receipt, current);
        if (!current()) break;
        await this.changePending(project, (pending) =>
          current()
            ? pending.filter((value) => !sameSubmission(project.id, value, entry))
            : pending,
        );
        if (!current()) break;
        if (entry.params.requestId) delete project.refreshErrors?.[entry.params.requestId];
        if (outcome.status === "completed") {
          if (entry.method === "areal/thread/configure" && entry.params.threadId)
            project.configurations[entry.params.threadId] =
              require("./thread-configuration.cjs").readConfigured(outcome.result);
          if (
            taskMutationMethods.has(entry.method) &&
            !["areal/channel/reply", "areal/task/runNow"].includes(entry.method)
          ) {
            if (!isCoreTask(outcome.result)) throw new Error("任务结果结构无效，请刷新任务状态");
            project.model.setTask(outcome.result);
          }
          await this.host.providers
            .acceptModelSelection(
              modelRecord(outcome.result) ? outcome.result.lastAcceptedModel : undefined,
            )
            .catch(() => {});
          void this.host
            .refreshAfterAdmission(project, outcome.threadId, receipt.operation ?? entry.operation)
            .catch(() => {});
        }
      } catch (error) {
        if (!current()) break;
        project.refreshErrors ??= {};
        project.refreshErrors[entry.params.requestId ?? `legacy:${entry.params.threadId}`] = {
          id: randomUUID(),
          projectId: project.id,
          connectionGeneration: generation,
          operation: entry.operation,
          message: this.host.providers.redact(
            error instanceof Error ? error.message : String(error),
          ),
          refreshPending: true,
        };
        this.host.onChange();
      }
    }
  }
}

module.exports = { SubmissionRecovery, operationOf, isRemoteControl };
