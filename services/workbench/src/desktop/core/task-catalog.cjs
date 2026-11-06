// @ts-check
"use strict";
const { modelRecord } = require("@areal/workbench/core-model-contract");
const {
  readTaskDirectoryRow,
  readDirectoryPage,
  readDirectoryRows,
  readAttentionPage,
  readOwnerBarrier,
  readOwnerInvalidation,
  inboxEntry,
} = require("@areal/workbench/desktop-contract/management-tasks");
const catalogContract = require("@areal/workbench/desktop-contract/catalog");
/** @typedef {InstanceType<typeof import('./backend.cjs').CoreBackend>} Backend */
/** @typedef {import('./project-state.cjs').CoreProject} Project */
/** @typedef {import('./project-index.cjs').SavedProject} SavedProject */
/** @typedef {import('@areal/workbench/desktop-contract/catalog').TasksRequest} Request */
/** @typedef {import('@areal/workbench/desktop-contract/management-tasks').TaskDirectoryRow} Task */
/** @typedef {import('@areal/workbench/desktop-contract/management-tasks').OwnerAttention} Attention */
/** @typedef {import('@areal/workbench/desktop-contract/management-tasks').OwnerNoticeFact} Fact */
/** @typedef {import('@areal/workbench/desktop-contract/management-tasks').OwnerInvalidation} Invalidation */
/** @typedef {import('@areal/runtime-client/core').CoreClient} Client */
/** @typedef {{kind:string,reason?:string}} Coverage */
/** @typedef {{data:Task[],hasMore:boolean,coverage:Coverage,readAt:number}} Preview */
/** @typedef {{flights:Map<string,{root:string,limit:number,sourceThreadId?:string,work:Promise<Preview>}>,active:number,queue:Array<()=>void>}} PreviewReads */
/** @type {WeakMap<Backend,PreviewReads>} */
const previews = new WeakMap();
/** @param {Backend} backend @param {SavedProject} saved @param {number} limit @param {string|undefined} sourceThreadId @returns {Promise<Preview>} */
async function previewRead(backend, saved, limit, sourceThreadId) {
  let pending = previews.get(backend);
  if (!pending) {
    pending = { flights: new Map(), active: 0, queue: [] };
    previews.set(backend, pending);
  }
  const existing = pending.flights.get(saved.id);
  if (existing) {
    if (
      existing.limit === limit &&
      existing.sourceThreadId === sourceThreadId &&
      existing.root === saved.root
    )
      return existing.work;
    await existing.work.catch(() => {});
    return previewRead(backend, saved, limit, sourceThreadId);
  }
  const guard = () => {
    if (
      !backend.saved.some(
        (owner) =>
          owner.id === saved.id &&
          owner.root === saved.root &&
          owner.logicalProjectId === saved.logicalProjectId,
      )
    )
      throw new Error("任务所有者已移除");
    backend.lifecycleOperations.assertProject(saved.id);
  };
  const work = (async () => {
    guard();
    if (pending.active >= 2)
      await new Promise((resolve) => pending.queue.push(() => resolve(undefined)));
    else pending.active++;
    try {
      guard();
      if (!backend.hostCall) throw new Error("Host 冷任务目录不可用");
      const value = await backend.hostCall("tasks.preview", {
        projectId: saved.id, limit,
        ...(sourceThreadId === undefined ? {} : { sourceThreadId }),
      });
      guard();
      if (!modelRecord(value) || !Array.isArray(value.data) ||
          typeof value.hasMore !== "boolean" || !modelRecord(value.coverage) ||
          typeof value.coverage.kind !== "string" || typeof value.readAt !== "number")
        throw new Error("Host 任务预览格式无效");
      return { data: value.data.map(readTaskDirectoryRow), hasMore: value.hasMore,
        coverage: { kind: value.coverage.kind,
          ...(typeof value.coverage.reason === "string" ? { reason: value.coverage.reason } : {}) },
        readAt: value.readAt };
    } finally {
      const next = pending.queue.shift();
      if (next) next();
      else pending.active--;
    }
  })();
  pending.flights.set(saved.id, { root: saved.root, limit, sourceThreadId, work });
  try {
    return await work;
  } finally {
    if (pending.flights.get(saved.id)?.work === work) pending.flights.delete(saved.id);
  }
}

/** One rebuildable view per execution owner. It never starts a Core. */
class OwnerTasks {
  /** @param {Backend} backend */
  constructor(backend) {
    this.backend = backend;
    /** @type {Map<string,OwnerObservation|HostOwnerObservation>} */
    this.observations = new Map();
    /** @type {Map<string,Preview & {root:string,logicalProjectId?:string}>} */
    this.published = new Map();
    /** @type {Map<string,number>} */
    this.revisions = new Map();
    /** @type {Set<(frame:{projectId:string,connectionId:string,connectionGeneration:number,method:string,params:unknown})=>void>} */
    this.hostEvents = new Set();
  }
  /** @param {unknown} frame */
  hostEvent(frame) {
    if (!modelRecord(frame) || typeof frame.projectId !== "string" || typeof frame.connectionId !== "string" ||
        !Number.isSafeInteger(frame.connectionGeneration) || typeof frame.connectionGeneration !== "number" ||
        typeof frame.method !== "string") return;
    const event = { projectId: frame.projectId, connectionId: frame.connectionId,
      connectionGeneration: frame.connectionGeneration, method: frame.method, params: frame.params };
    if (event.method === "areal/task/updated") {
      this.backend.projects.get(event.projectId)?.model.event(event.method, event.params);
      return;
    }
    for (const listener of this.hostEvents) listener(event);
  }
  /** 目录版本按项目分开，只在该项目的任务行变化时前进。 @param {string} projectId */
  revision(projectId) {
    return this.revisions.get(projectId) ?? 0;
  }
  /** @param {SavedProject} saved @param {boolean} [refresh] */
  async preview(saved, refresh = false) {
    this.backend.lifecycleOperations.assertProject(saved.id);
    if (
      !this.backend.saved.some(
        (owner) =>
          owner.id === saved.id &&
          owner.root === saved.root &&
          owner.logicalProjectId === saved.logicalProjectId,
      )
    )
      throw new Error("任务所有者已移除");
    const cached = this.published.get(saved.id);
    if (
      cached &&
      cached.root === saved.root &&
      cached.logicalProjectId === saved.logicalProjectId &&
      !refresh
    )
      return cached;
    const result = await previewRead(this.backend, saved, 1024, undefined);
    if (result.coverage.kind === "requiresCore")
      throw new Error(`任务目录需要启动原工作区完成迁移或检查：${result.coverage.reason}`);
    this.published.set(saved.id, {
      ...result,
      root: saved.root,
      logicalProjectId: saved.logicalProjectId,
    });
    return result;
  }
  /** @param {Project} project @param {Client} client @param {(facts:Fact[])=>void} facts @param {(rows:Task[],baseline:boolean)=>Promise<void>} rows @param {(error:unknown)=>void} report */
  attach(project, client, facts, rows, report) {
    this.observations.get(project.id)?.stop();
    const observation = this.backend.rustDomains.includes("tasks-rust") && this.backend.hostCall
      ? new HostOwnerObservation(this, project, client, facts, rows, report)
      : new OwnerObservation(this, project, client, facts, rows, report);
    this.observations.set(project.id, observation);
    return observation;
  }
  /** @param {string} [projectId] 省略时只通知界面，不前进目录版本。 */
  changed(projectId) {
    if (projectId) this.revisions.set(projectId, this.revision(projectId) + 1);
    this.backend.onChange();
  }
  stop() {
    for (const observation of this.observations.values()) observation.stop();
  }
}

// 页面宿主只消费 Host 的目录投影和 Core 通知事实；分页与权威读取归 Rust。
class HostOwnerObservation {
  /** @param {OwnerTasks} owner @param {Project} project @param {Client} client @param {(facts:Fact[])=>void} facts @param {(rows:Task[],baseline:boolean)=>Promise<void>} rows @param {(error:unknown)=>void} report */
  constructor(owner, project, client, facts, rows, report) {
    this.owner = owner; this.project = project; this.client = client;
    this.onFacts = facts; this.onRows = rows; this.report = report;
    this.stopped = false; this.ready = false; this.baseline = true; this.readAt = 0;
    this.generation = ""; this.sequence = 0; this.connectionId = ""; this.connectionGeneration = 0;
    this.dirty = false;
    /** @type {unknown} */ this.error = null;
    /** @type {Map<string,Task>} */ this.rows = new Map();
    /** @type {Promise<void>|null} */ this.pending = null;
    /** @type {Array<{projectId:string,connectionId:string,connectionGeneration:number,method:string,params:unknown}>} */ this.buffer = [];
    /** @param {{projectId:string,connectionId:string,connectionGeneration:number,method:string,params:unknown}} frame */
    const listener = (frame) => {
      if (!this.current() || frame.projectId !== project.id || frame.connectionGeneration < this.connectionGeneration) return;
      this.dirty = true;
      if (frame.method === "host/connectionReady") {
        this.generation = ""; this.ready = false; this.buffer = [];
        void this.start();
        return;
      }
      if (frame.connectionId !== this.connectionId || !this.generation) {
        if (this.buffer.length >= 256) {
          this.ready = false;
          this.report(new Error("OWNER_WATCH_OVERFLOW"));
          this.buffer = [];
        }
        this.buffer.push(frame);
      } else this.accept(frame);
      void this.start();
    };
    owner.hostEvents.add(listener);
    this.unsubscribe = () => { owner.hostEvents.delete(listener); };
  }
  current() { return !this.stopped && this.owner.backend.currentConnection(this.project, this.client); }
  /** @param {{connectionId:string,connectionGeneration:number,method:string,params:unknown}} frame */
  accept(frame) {
    if (frame.connectionId !== this.connectionId || frame.connectionGeneration !== this.connectionGeneration) return;
    if (frame.method === "areal/owner/resetRequired") { this.generation = ""; this.ready = false; return; }
    try {
      const invalidation = readOwnerInvalidation(frame.params);
      if (invalidation.generation !== this.generation || invalidation.sequence > this.sequence + 1) {
        this.generation = ""; this.ready = false; return;
      }
      if (invalidation.sequence <= this.sequence) return;
      this.sequence = invalidation.sequence;
      this.onFacts(invalidation.facts);
    } catch (error) { this.error = error; this.ready = false; this.report(error); }
  }
  start() {
    if (this.pending) return this.pending;
    this.pending = Promise.resolve().then(async () => {
      const host = this.owner.backend.hostCall;
      if (!host || !this.current()) return;
      this.dirty = false;
      const value = await host("tasks.observe", { projectId: this.project.id });
      if (!this.current()) return;
      if (!modelRecord(value) || !Array.isArray(value.data) || value.data.length > 1024 ||
          typeof value.generation !== "string" || typeof value.connectionId !== "string" ||
          typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) ||
          typeof value.connectionGeneration !== "number" || !Number.isSafeInteger(value.connectionGeneration))
        throw new Error("Host 任务目录投影无效");
      const data = value.data.map(readTaskDirectoryRow);
      const same = this.connectionId === value.connectionId && this.generation === value.generation;
      this.generation = value.generation;
      this.sequence = same ? Math.max(this.sequence, value.sequence) : value.sequence;
      this.connectionId = value.connectionId; this.connectionGeneration = value.connectionGeneration;
      this.rows = new Map(data.map((row) => [row.id, row]));
      this.ready = true; this.readAt = Date.now(); this.error = null;
      const buffered = this.buffer; this.buffer = [];
      for (const frame of buffered) this.accept(frame);
      await this.onRows(data, this.baseline);
      this.owner.changed(this.project.id);
      this.baseline = false;
    }).catch((error) => { this.error = error; this.ready = false; this.report(error); })
      .finally(() => { this.pending = null; if (this.current() && this.dirty) void this.start(); });
    return this.pending;
  }
  stop() { this.stopped = true; this.ready = false; this.unsubscribe(); }
}

class OwnerObservation {
  /** @param {OwnerTasks} owner @param {Project} project @param {Client} client @param {(facts:Fact[])=>void} facts @param {(rows:Task[],baseline:boolean)=>Promise<void>} rows @param {(error:unknown)=>void} report */
  constructor(owner, project, client, facts, rows, report) {
    this.owner = owner;
    this.project = project;
    this.client = client;
    this.onFacts = facts;
    this.onRows = rows;
    this.report = report;
    const previous = owner.observations.get(project.id);
    /** @type {Map<string,Task>} */
    this.rows = new Map(
      previous?.project.root === project.root &&
        previous.project.logicalProjectId === project.logicalProjectId
        ? previous.rows
        : undefined,
    );
    /** @type {Map<string,Attention>} */
    this.attention = new Map();
    /** @type {Map<string,number>} */
    this.dirtyTasks = new Map();
    /** @type {Map<string,number>} */
    this.dirtyThreads = new Map();
    /** @type {Invalidation[]} */
    this.buffer = [];
    this.bufferBytes = 0;
    this.generation = "";
    this.sequence = 0;
    this.ready = false;
    this.stopped = false;
    this.resetNeeded = true;
    this.buffering = false;
    this.readAt = 0;
    /** @type {unknown} */
    this.error = null;
    /** @type {Promise<void>|null} */
    this.pending = null;
    /** @type {NodeJS.Timeout|undefined} */
    this.timer = undefined;
    /** @type {NodeJS.Timeout|undefined} */
    this.retryTimer = undefined;
    this.attempt = 0;
    this.unsubscribe = client.onNotification((method, params) => {
      if (!this.current()) return;
      if (method === "areal/owner/resetRequired") {
        if (!modelRecord(params) || (this.generation && params.generation !== this.generation))
          return;
        this.resetNeeded = true;
        this.ready = false;
        void this.refresh();
        return;
      }
      if (method !== "areal/owner/invalidated") return;
      try {
        const invalidation = readOwnerInvalidation(params);
        if (this.buffering || this.resetNeeded || !this.generation) {
          const bytes = Buffer.byteLength(JSON.stringify(invalidation));
          if (this.buffer.length >= 256 || this.bufferBytes + bytes > 1024 * 1024)
            throw new Error("OWNER_WATCH_OVERFLOW");
          this.buffer.push(invalidation);
          this.bufferBytes += bytes;
        } else this.accept(invalidation);
        void this.refresh();
      } catch (error) {
        this.failed(error);
      }
    });
  }
  current() {
    return (
      !this.stopped &&
      this.owner.backend.projects.get(this.project.id) === this.project &&
      this.owner.backend.saved.some(
        (saved) =>
          saved.id === this.project.id &&
          saved.root === this.project.root &&
          saved.logicalProjectId === this.project.logicalProjectId,
      ) &&
      this.owner.backend.currentConnection(this.project, this.client)
    );
  }
  guard() {
    if (!this.current()) throw new Error("任务目录连接已换代");
    if (
      !this.owner.backend.saved.some(
        (saved) => saved.id === this.project.id && saved.root === this.project.root,
      )
    )
      throw new Error("任务所有者已移除");
  }
  /** @param {Invalidation} invalidation */
  accept(invalidation) {
    if (invalidation.generation !== this.generation) {
      this.resetNeeded = true;
      this.ready = false;
      return;
    }
    if (invalidation.sequence <= this.sequence) return;
    if (invalidation.sequence !== this.sequence + 1) {
      this.resetNeeded = true;
      this.ready = false;
      return;
    }
    this.sequence = invalidation.sequence;
    for (const id of invalidation.changedTasks) this.dirtyTasks.set(id, this.sequence);
    for (const id of invalidation.changedThreads) this.dirtyThreads.set(id, this.sequence);
    this.onFacts(invalidation.facts);
  }
  /** @template T @param {string} method @param {Record<string,unknown>} query @param {(value:unknown)=>{generation:string,revision:number,data:T[],nextCursor:string|null}} decode */
  async pages(method, query, decode) {
    /** @type {T[]} */
    const data = [];
    /** @type {string|null} */
    let cursor = null;
    /** @type {number|undefined} */
    let revision;
    const cursors = new Set();
    do {
      /** @type {{generation:string,revision:number,data:T[],nextCursor:string|null}} */
      const page = await this.client.request(
        method,
        { ...query, limit: 100, ...(cursor ? { cursor } : {}) },
        { decode },
      );
      this.guard();
      if (
        page.generation !== this.generation ||
        (revision !== undefined && revision !== page.revision)
      )
        throw new Error("DIRECTORY_CHANGED");
      revision = page.revision;
      data.push(...page.data);
      cursor = page.nextCursor;
      if (cursor && (cursors.has(cursor) || cursors.size >= 1024))
        throw new Error("任务目录分页未前进");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return data;
  }
  async baseline() {
    this.ready = false;
    this.resetNeeded = false;
    this.buffering = true;
    this.buffer = [];
    this.bufferBytes = 0;
    const barrier = await this.client.request(
      "areal/owner/watch",
      {},
      { decode: readOwnerBarrier },
    );
    this.guard();
    if (this.resetNeeded) throw new Error("OWNER_WATCH_RESET_REQUIRED");
    this.generation = barrier.generation;
    this.sequence = barrier.sequence;
    this.dirtyTasks.clear();
    this.dirtyThreads.clear();
    for (const invalidation of this.buffer) this.accept(invalidation);
    this.buffer = [];
    this.bufferBytes = 0;
    this.buffering = false;
    const [rows, attention] = await Promise.all([
      this.pages("areal/task/directory/list", {}, readDirectoryPage),
      this.pages("areal/task/attention/read", {}, readAttentionPage),
    ]);
    this.guard();
    const stagedRows = new Map(rows.map((row) => [row.id, row]));
    const stagedAttention = new Map(attention.map((row) => [row.id, row]));
    await this.drain(stagedRows, stagedAttention, false);
    this.guard();
    if (this.resetNeeded) return;
    this.rows = stagedRows;
    this.attention = stagedAttention;
    this.ready = true;
    this.readAt = Date.now();
    this.error = null;
    this.owner.changed(this.project.id);
    await this.owner.backend.taskWorkspaceOwners.observeTasks(this.project, [
      ...stagedRows.values(),
    ]);
    await this.onRows([...stagedRows.values()], true);
  }
  /** @param {Map<string,Task>} [rows] @param {Map<string,Attention>} [attentionRows] @param {boolean} [publish] */
  async drain(rows = this.rows, attentionRows = this.attention, publish = true) {
    while (
      this.current() &&
      !this.resetNeeded &&
      (this.dirtyTasks.size || this.dirtyThreads.size)
    ) {
      const sequence = this.sequence;
      const taskIds = [...this.dirtyTasks.keys()].slice(0, 4);
      const threadIds = [...this.dirtyThreads.keys()].slice(0, 100);
      const [directory, attention] = await Promise.all([
        taskIds.length
          ? this.client.request(
              "areal/task/directory/read",
              { taskIds },
              { decode: readDirectoryRows },
            )
          : null,
        this.pages("areal/task/attention/read", { taskIds, threadIds }, readAttentionPage),
      ]);
      this.guard();
      if (this.resetNeeded) return;
      if (directory && directory.generation !== this.generation)
        throw new Error("DIRECTORY_CHANGED");
      for (const id of directory?.removed ?? []) rows.delete(id);
      for (const row of directory?.data ?? []) rows.set(row.id, row);
      for (const [id, row] of attentionRows)
        if (
          (row.taskId && taskIds.includes(row.taskId)) ||
          (row.threadId && threadIds.includes(row.threadId))
        )
          attentionRows.delete(id);
      for (const row of attention) attentionRows.set(row.id, row);
      for (const id of taskIds)
        if ((this.dirtyTasks.get(id) ?? Infinity) <= sequence) this.dirtyTasks.delete(id);
      for (const id of threadIds)
        if ((this.dirtyThreads.get(id) ?? Infinity) <= sequence) this.dirtyThreads.delete(id);
      if (publish) {
        this.readAt = Date.now();
        this.error = null;
        // 只有会话变化时不前进目录版本，任务目录不必为运行中的对话重读。
        this.owner.changed(
          directory && (directory.data.length || directory.removed?.length)
            ? this.project.id
            : undefined,
        );
        await this.owner.backend.taskWorkspaceOwners.observeTasks(
          this.project,
          directory?.data ?? [],
        );
        await this.onRows(directory?.data ?? [], false);
      }
    }
  }
  refresh() {
    if (!this.current()) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = Promise.resolve()
      .then(async () => {
        if (this.resetNeeded) await this.baseline();
        await this.drain();
        if (this.resetNeeded) throw new Error("DIRECTORY_CHANGED");
        await this.onRows([], false);
        this.attempt = 0;
        this.expiry();
      })
      .catch((error) => this.failed(error))
      .finally(() => {
        this.pending = null;
        if (
          this.current() &&
          !this.error &&
          (this.resetNeeded || this.dirtyTasks.size || this.dirtyThreads.size)
        )
          void this.refresh();
      });
    return this.pending;
  }
  /** @param {unknown} error */
  failed(error) {
    if (!this.current()) return;
    const changed =
      !this.error ||
      (this.error instanceof Error ? this.error.message : String(this.error)) !==
        (error instanceof Error ? error.message : String(error));
    this.error = error;
    this.ready = false;
    this.resetNeeded = true;
    if (changed) {
      this.report(error);
      this.owner.changed(this.project.id);
    }
    if (!this.retryTimer)
      this.retryTimer = setTimeout(
        () => {
          this.retryTimer = undefined;
          void this.refresh();
        },
        Math.min(250 * 2 ** Math.min(this.attempt++, 7), 30000),
      );
  }
  expiry() {
    clearTimeout(this.timer);
    const pending = [...this.attention.values()].filter(
      (row) => row.expiresAt != null && row.expiresAt * 1000 > Date.now(),
    );
    const expiresAt = Math.min(...pending.map((row) => Number(row.expiresAt) * 1000));
    if (!Number.isFinite(expiresAt)) return;
    this.timer = setTimeout(
      () => {
        for (const row of pending) {
          if (Number(row.expiresAt) * 1000 > Date.now()) continue;
          if (row.taskId) this.dirtyTasks.set(row.taskId, this.sequence);
          if (row.threadId) this.dirtyThreads.set(row.threadId, this.sequence);
        }
        void this.refresh();
      },
      Math.min(2147483647, Math.max(1, expiresAt - Date.now())),
    );
  }
  start() {
    return this.pending ?? (this.error && this.retryTimer ? Promise.resolve() : this.refresh());
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    this.unsubscribe();
    if (!this.client.closed) void this.client.request("areal/owner/unwatch", {}).catch(() => {});
  }
}

/** @param {OwnerObservation} observation @param {number} limit */
async function inboxRows(observation, limit) {
  const attention = [...observation.attention.values()].filter(
    (row) =>
      row.kind === "asyncQuestion" &&
      row.taskId &&
      (row.expiresAt == null || row.expiresAt * 1000 > Date.now()),
  );
  const tasks = [...new Set(attention.map((row) => row.taskId))];
  /** @type {import('@areal/workbench/desktop-contract/management-tasks').InboxEntry[]} */
  const rows = [];
  for (const taskId of tasks) {
    let afterSequence = 0;
    for (;;) {
      const page = await observation.client.request("areal/channel/read", {
        taskId,
        afterSequence,
        limit: 100,
      });
      observation.guard();
      if (!modelRecord(page) || !Array.isArray(page.data)) throw new Error("任务频道结构无效");
      for (const message of page.data) {
        const item = attention.find(
          (row) => modelRecord(message) && row.taskId === taskId && row.questionId === message.id,
        );
        if (!item || !modelRecord(message) || message.status !== "pending") continue;
        const row = { taskId, objective: item.objectivePreview, message };
        if (!inboxEntry(row)) throw new Error("任务收件箱结构无效");
        rows.push(row);
      }
      if (!page.hasMore || rows.length >= limit) break;
      if (typeof page.nextSequence !== "number" || page.nextSequence <= afterSequence)
        throw new Error("任务频道分页未前进");
      afterSequence = page.nextSequence;
    }
    if (rows.length >= limit) break;
  }
  return {
    data: rows.slice(0, limit),
    hasMore: rows.length > limit || tasks.length > new Set(rows.map((row) => row.taskId)).size,
  };
}

/** @param {Backend} backend @param {Record<string,unknown>} rawRequest */
async function taskCatalog(backend, rawRequest) {
  if (backend.rustDomains.includes("tasks-rust") && backend.hostCall)
    return backend.hostCall("tasks.read", rawRequest);
  if (!catalogContract.isRequest("tasks", rawRequest)) throw new Error("无效任务列表请求");
  const request = rawRequest;
  const limit = request.limit ?? 30;
  const requested =
    request.projectId === undefined
      ? null
      : backend.saved.find((saved) => saved.id === request.projectId);
  if (request.projectId !== undefined && !requested) throw new Error("任务所有者不存在");
  const logicalId = requested && (requested.logicalProjectId ?? requested.id);
  const selected = requested
    ? backend.saved.filter((saved) => (saved.logicalProjectId ?? saved.id) === logicalId)
    : backend.saved;
  const results = await Promise.all(
    selected.map(async (saved) => {
      const projectId = saved.logicalProjectId ?? saved.id;
      const logical = backend.saved.find((owner) => owner.id === projectId);
      const scope = {
        projectId,
        ...(saved.logicalProjectId ? { executionProjectId: saved.id } : {}),
        projectName: logical?.projectless
          ? "独立任务"
          : backend.library.value.projects[projectId]?.title ||
            (logical?.root ?? saved.root).split(/[\\/]/).pop(),
        scope: logical?.projectless ? "independent" : "project",
      };
      const candidate = backend.ownerTasks.observations.get(saved.id);
      const observation = candidate instanceof OwnerObservation ? candidate : undefined;
      try {
        if (request.operation !== "preview" && observation?.current()) {
          await observation.start();
          if (!observation.ready) throw observation.error ?? new Error("任务目录正在恢复");
          const value =
            request.operation === "inbox"
              ? await inboxRows(observation, limit)
              : {
                  data: [...observation.rows.values()].filter(
                    (row) =>
                      row.mode === "scheduled" &&
                      (row.deletedAt == null || row.hasUnsettledWork) &&
                      (request.sourceThreadId === undefined ||
                        row.sourceThreadId === request.sourceThreadId),
                  ),
                  hasMore: false,
                };
          return {
            data: value.data.slice(0, limit).map((row) => ({ ...row, ...scope })),
            hasMore: value.hasMore || value.data.length > limit,
            owner: {
              projectId,
              status: "ready",
              source: "live",
              coverage: { kind: "complete" },
              readAt: observation.readAt,
              connectionGeneration: observation.project.connectionGeneration ?? 0,
            },
          };
        }
        if (request.operation === "inbox") throw new Error("当前项目未连接，保留上次收件箱");
        const preview = await backend.ownerTasks.preview(saved, request.operation === "list");
        const data = preview.data.filter(
          (row) =>
            request.sourceThreadId === undefined || row.sourceThreadId === request.sourceThreadId,
        );
        return {
          data: data.slice(0, limit).map((row) => ({ ...row, ...scope })),
          hasMore: preview.hasMore || data.length > limit,
          owner: {
            projectId,
            status: "unobserved",
            source: "published",
            coverage: preview.coverage,
            readAt: preview.readAt,
          },
        };
      } catch (error) {
        const published = backend.ownerTasks.published.get(saved.id);
        const previous =
          observation?.project.root === saved.root &&
          observation.project.logicalProjectId === saved.logicalProjectId &&
          observation.rows.size
            ? [...observation.rows.values()]
            : published?.root === saved.root &&
                published.logicalProjectId === saved.logicalProjectId
              ? published.data
              : [];
        return {
          data:
            request.operation === "inbox"
              ? []
              : previous
                  .filter(
                    (row) =>
                      row.mode === "scheduled" &&
                      (request.sourceThreadId === undefined ||
                        row.sourceThreadId === request.sourceThreadId),
                  )
                  .slice(0, limit)
                  .map((row) => ({ ...row, ...scope })),
          hasMore: false,
          owner: { projectId, status: "error" },
          error: {
            projectId,
            code: "TASK_CATALOG_READ_FAILED",
            message: backend.providers.redact(
              error instanceof Error ? error.message : String(error),
            ),
          },
        };
      }
    }),
  );
  /** @type {Map<string,Record<string,unknown>>} */
  const owners = new Map();
  for (const { owner } of results) {
    const previous = owners.get(owner.projectId);
    if (
      !previous ||
      owner.status === "error" ||
      (previous.status !== "error" && owner.status === "unobserved")
    )
      owners.set(owner.projectId, owner);
  }
  return {
    data: results.flatMap((result) => result.data),
    errors: results.flatMap((result) => (result.error ? [result.error] : [])),
    hasMore: results.some((result) => result.hasMore),
    owners: [...owners.values()],
    ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
    ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
    ...(request.viewEpoch === undefined ? {} : { viewEpoch: request.viewEpoch }),
    ...(request.operation === "preview"
      ? { source: "published", executionState: "unobserved" }
      : {}),
  };
}
module.exports = { taskCatalog, OwnerTasks };
