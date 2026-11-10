// @ts-check
"use strict";
const { modelRecord } = require("@areal/workbench/core-model-contract");
const {
  readTaskDirectoryRow,
  readOwnerInvalidation,
} = require("@areal/workbench/desktop-contract/management-tasks");
/** @typedef {InstanceType<typeof import('./backend.cjs').CoreBackend>} Backend */
/** @typedef {import('./project-state.cjs').CoreProject} Project */
/** @typedef {import('@areal/workbench/desktop-contract/management-tasks').TaskDirectoryRow} Task */
/** @typedef {import('@areal/workbench/desktop-contract/management-tasks').OwnerNoticeFact} Fact */
/** @typedef {import('@areal/runtime-client/core').CoreClient} Client */

/** One rebuildable view per execution owner. It never starts a Core. */
class OwnerTasks {
  /** @param {Backend} backend */
  constructor(backend) {
    this.backend = backend;
    /** @type {Map<string,HostOwnerObservation>} */
    this.observations = new Map();
    /** @type {Map<string,number>} */
    this.revisions = new Map();
    /** @type {Set<(frame:{projectId:string,connectionId:string,connectionGeneration:number,method:string,params:unknown})=>void>} */
    this.hostEvents = new Set();
  }
  /** @param {unknown} frame */
  hostEvent(frame) {
    if (
      !modelRecord(frame) ||
      typeof frame.projectId !== "string" ||
      typeof frame.connectionId !== "string" ||
      !Number.isSafeInteger(frame.connectionGeneration) ||
      typeof frame.connectionGeneration !== "number" ||
      typeof frame.method !== "string"
    )
      return;
    const event = {
      projectId: frame.projectId,
      connectionId: frame.connectionId,
      connectionGeneration: frame.connectionGeneration,
      method: frame.method,
      params: frame.params,
    };
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
  /** @param {Project} project @param {Client} client @param {(facts:Fact[])=>void} facts @param {(rows:Task[],baseline:boolean)=>Promise<void>} rows @param {(error:unknown)=>void} report */
  attach(project, client, facts, rows, report) {
    this.observations.get(project.id)?.stop();
    const observation = new HostOwnerObservation(this, project, client, facts, rows, report);
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
    this.owner = owner;
    this.project = project;
    this.client = client;
    this.onFacts = facts;
    this.onRows = rows;
    this.report = report;
    this.stopped = false;
    this.ready = false;
    this.baseline = true;
    this.readAt = 0;
    this.generation = "";
    this.sequence = 0;
    this.connectionId = "";
    this.connectionGeneration = 0;
    this.dirty = false;
    /** @type {unknown} */ this.error = null;
    /** @type {Map<string,Task>} */ this.rows = new Map();
    /** @type {Promise<void>|null} */ this.pending = null;
    /** @type {Array<{projectId:string,connectionId:string,connectionGeneration:number,method:string,params:unknown}>} */ this.buffer =
      [];
    /** @param {{projectId:string,connectionId:string,connectionGeneration:number,method:string,params:unknown}} frame */
    const listener = (frame) => {
      if (
        !this.current() ||
        frame.projectId !== project.id ||
        frame.connectionGeneration < this.connectionGeneration
      )
        return;
      this.dirty = true;
      if (frame.method === "host/connectionReady") {
        this.generation = "";
        this.ready = false;
        this.buffer = [];
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
    this.unsubscribe = () => {
      owner.hostEvents.delete(listener);
    };
  }
  current() {
    return !this.stopped && this.owner.backend.currentConnection(this.project, this.client);
  }
  /** @param {{connectionId:string,connectionGeneration:number,method:string,params:unknown}} frame */
  accept(frame) {
    if (
      frame.connectionId !== this.connectionId ||
      frame.connectionGeneration !== this.connectionGeneration
    )
      return;
    if (frame.method === "areal/owner/resetRequired") {
      this.generation = "";
      this.ready = false;
      return;
    }
    try {
      const invalidation = readOwnerInvalidation(frame.params);
      if (
        invalidation.generation !== this.generation ||
        invalidation.sequence > this.sequence + 1
      ) {
        this.generation = "";
        this.ready = false;
        return;
      }
      if (invalidation.sequence <= this.sequence) return;
      this.sequence = invalidation.sequence;
      this.onFacts(invalidation.facts);
    } catch (error) {
      this.error = error;
      this.ready = false;
      this.report(error);
    }
  }
  start() {
    if (this.pending) return this.pending;
    this.pending = Promise.resolve()
      .then(async () => {
        const host = this.owner.backend.hostCall;
        if (!host || !this.current()) return;
        this.dirty = false;
        const value = await host("tasks.observe", { projectId: this.project.id });
        if (!this.current()) return;
        if (
          !modelRecord(value) ||
          !Array.isArray(value.data) ||
          value.data.length > 1024 ||
          typeof value.generation !== "string" ||
          typeof value.connectionId !== "string" ||
          typeof value.sequence !== "number" ||
          !Number.isSafeInteger(value.sequence) ||
          typeof value.connectionGeneration !== "number" ||
          !Number.isSafeInteger(value.connectionGeneration)
        )
          throw new Error("Host 任务目录投影无效");
        const data = value.data.map(readTaskDirectoryRow);
        const same =
          this.connectionId === value.connectionId && this.generation === value.generation;
        this.generation = value.generation;
        this.sequence = same ? Math.max(this.sequence, value.sequence) : value.sequence;
        this.connectionId = value.connectionId;
        this.connectionGeneration = value.connectionGeneration;
        this.rows = new Map(data.map((row) => [row.id, row]));
        this.ready = true;
        this.readAt = Date.now();
        this.error = null;
        const buffered = this.buffer;
        this.buffer = [];
        for (const frame of buffered) this.accept(frame);
        await this.onRows(data, this.baseline);
        this.owner.changed(this.project.id);
        this.baseline = false;
      })
      .catch((error) => {
        this.error = error;
        this.ready = false;
        this.report(error);
      })
      .finally(() => {
        this.pending = null;
        if (this.current() && this.dirty) void this.start();
      });
    return this.pending;
  }
  stop() {
    this.stopped = true;
    this.ready = false;
    this.unsubscribe();
  }
}

/** @param {Backend} backend @param {Record<string,unknown>} rawRequest */
async function taskCatalog(backend, rawRequest) {
  return backend.hostCall("tasks.read", rawRequest);
}
module.exports = { taskCatalog, OwnerTasks };
