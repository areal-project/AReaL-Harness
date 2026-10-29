// @ts-check
"use strict";

const { modelRecord } = require("@areal/workbench/core-model-contract");
const {
  validateRequest,
} = require("../../../packages/workbench/client/desktop-contract/cloud.cjs");
const { createProjectState } = require("./project-state.cjs");
/** @typedef {import('./cloud-session.cjs').Binding} Binding */
/** @typedef {{id:string,projectId:string,title:string,createdAt:number,updatedAt?:number,binding:Binding}} CloudRecord */
/** @typedef {{model:import('@areal/workbench/core-model').CoreTaskModel,session:InstanceType<typeof CloudSession>,error:string|null,submitting:boolean}} LiveCloud */
/** @typedef {import('../../../packages/workbench/client/desktop-contract/cloud.cjs').SessionRequest} SessionRequest */
/** @typedef {{home:string,saved:import('./project-index.cjs').SavedProject[],cloud:InstanceType<typeof import('./cloud-settings.cjs').CloudSettings>,save:(name:string,value:unknown)=>Promise<unknown>,onChange:()=>void,snapshot:()=>{projects:unknown[]},library:{command:(request:import("../../../packages/workbench/client/desktop-contract/library-media.cjs").LibraryRequest)=>Promise<unknown>},textInput:(text:string)=>Array<{type:string,text:string}>}} CloudHost */
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { mediaCommand, messageInput } = require("./media.cjs");
const { CloudSession } = require("./cloud-session.cjs");
const { CloudClient } = require("./cloud-client.cjs");

/** 本地只保存远端身份和导航摘要；消息从远端 Core 读取。 */
class CloudConversations {
  /** @param {CloudHost} backend */
  constructor(backend) {
    this.backend = backend;
    /** @type {CloudRecord[]} */
    this.records = [];
    /** @type {Map<string,LiveCloud>} */
    this.live = new Map();
    /** @type {Map<string,Promise<{threadId:string,sessionId:string}>>} */
    this.creating = new Map();
  }
  async init() {
    try {
      this.records = JSON.parse(
        await readFile(join(this.backend.home, "cloud-sessions.json"), "utf8"),
      );
    } catch (error) {
      if (!modelRecord(error) || error.code !== "ENOENT") throw error;
    }
    if (!Array.isArray(this.records)) throw new Error("Cloud 会话索引无效");
  }
  async save() {
    await this.backend.save("cloud-sessions.json", structuredClone(this.records));
    this.backend.onChange();
  }
  /** @param {string|undefined} projectId @param {string|undefined} threadId */
  owns(projectId, threadId) {
    return this.records.some(
      (record) => record.projectId === projectId && record.binding.threadId === threadId,
    );
  }
  /** @param {string} name @param {Record<string,unknown>} request */
  routes(name, request) {
    // Cloud 绑定属于逻辑项目，不经过本地 worktree 的执行归属解析。
    return (
      name === "cloudSession" ||
      this.owns(
        typeof request.projectId === "string" ? request.projectId : undefined,
        typeof request.threadId === "string" ? request.threadId : undefined,
      )
    );
  }
  /** @param {string} name @param {Record<string,unknown>} request */
  async route(name, request) {
    if (name === "media") return this.media(request);
    if (name === "open") return this.command({ ...request, operation: "open" });
    // 阅读标记是本地导航元数据，不向云端执行环境发送命令。
    if (name === "library" && request.operation === "readThread")
      return this.backend.library.command(
        require("../../../packages/workbench/client/desktop-contract/library-media.cjs").readLibraryRequest(
          request,
        ),
      );
    throw new Error("此操作尚不支持 Cloud 会话");
  }
  /** @param {string} projectId @param {import('@areal/workbench/core-model-contract').CoreModelState|null} local */
  mergeSnapshot(projectId, local) {
    const cloud = this.projection(projectId);
    return cloud.summaries.length
      ? {
          ...(local ?? { connected: false, error: null, interactions: {}, queues: {} }),
          threads: { ...local?.threads, ...cloud.threads },
        }
      : local;
  }
  /** @param {string} projectId */
  projection(projectId) {
    /** @type {Record<string,import('@areal/workbench/core-model-contract').CoreThread>} */
    const threads = {};
    /** @type {import('@areal/workbench/core-model-contract').CoreThread[]} */
    const summaries = [];
    for (const record of this.records.filter(
      (value) => value.projectId === projectId && value.binding.threadId,
    )) {
      const live = this.live.get(record.id);
      const cloud = {
        sessionId: record.id,
        connected: live?.session.client?.ready === true,
        error: live?.error ?? null,
      };
      const id = record.binding.threadId;
      if (!id) continue;
      const summary = {
        id,
        name: record.title,
        preview: record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt ?? record.createdAt,
        cloud,
      };
      summaries.push(summary);
      const thread = live?.model.state.threads[id];
      threads[id] = {
        ...(thread ?? { ...summary, turns: [], status: { type: "idle" } }),
        cloud,
      };
    }
    return { threads, summaries };
  }
  /** @param {CloudRecord} record @returns {Promise<LiveCloud>} */
  async context(record) {
    const service = await this.backend.cloud.client();
    let platform = record.binding.workspace ? service.forWorkspace(record.id) : service;
    if (!record.binding.workspace && record.binding.baseURL !== service.baseURL.href) {
      const bound = new URL(record.binding.baseURL ?? "");
      const suffix = bound.pathname.slice(service.baseURL.pathname.length).replace(/\/$/, "");
      if (
        bound.origin === service.baseURL.origin &&
        bound.pathname.startsWith(service.baseURL.pathname) &&
        /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(suffix)
      )
        platform = new CloudClient({ baseURL: bound.href, token: service.token });
    }
    if (record.binding.baseURL !== platform.baseURL.href)
      throw new Error("此会话属于另一个 Cloud 后端，请恢复原后端配置");
    const existing = this.live.get(record.id);
    if (existing) {
      const live = existing;
      live.session.platform = platform;
      return live;
    }
    const { CoreTaskModel } = await import("@areal/workbench/core-model");
    // 异步模块加载期间可能有另一个读取先建立连接。
    const raced = this.live.get(record.id);
    if (raced) return raced;
    const model = new CoreTaskModel();
    /** @type {LiveCloud} */
    const live = {
      model,
      error: null,
      submitting: false,
      session: new CloudSession({
        platform,
        binding: record.binding,
        save: async (binding) => {
          record.binding = binding;
          await this.save();
        },
        onSnapshot: (thread) => model.replace(thread),
        onNotification: (method, params) => {
          model.event(method, params);
          if (method === "turn/completed") {
            record.updatedAt = Math.floor(Date.now() / 1000);
            void this.save().catch((error) => {
              live.error = error instanceof Error ? error.message : String(error);
              this.backend.onChange();
            });
          }
        },
        onClose: () => {
          model.connection(false);
          this.backend.onChange();
        },
      }),
    };
    model.subscribe(() => this.backend.onChange());
    live.session.onIdle = () => {
      model.connection(false);
      this.backend.onChange();
    };
    this.live.set(record.id, live);
    return live;
  }
  /** @param {CloudRecord} record @param {boolean} wake */
  async open(record, wake = false) {
    const live = await this.context(record);
    if (!wake && record.binding.threadId && !live.session.client?.ready) return live;
    try {
      await live.session.read();
      live.model.connection(true);
      live.error = null;
      this.backend.onChange();
      return live;
    } catch (error) {
      live.error = error instanceof Error ? error.message : String(error);
      this.backend.onChange();
      throw error;
    }
  }
  /** @param {Extract<SessionRequest,{operation:"create"}>} request @returns {Promise<{threadId:string,sessionId:string}>} */
  create(request) {
    const id = request.requestId;
    if (!this.backend.saved.some((project) => project.id === request.projectId))
      throw new Error("请先选择项目");
    if (typeof id !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id))
      throw new Error("Cloud 创建请求标识无效");
    const pending = this.creating.get(id);
    if (pending) return pending;
    const task = (async () => {
      let record = this.records.find((value) => value.id === id);
      if (record && record.projectId !== request.projectId)
        throw new Error("Cloud 创建请求归属不匹配");
      if (!record) {
        const service = await this.backend.cloud.client();
        const platform = service.forWorkspace(id);
        record = {
          id,
          projectId: request.projectId,
          title: "Cloud",
          createdAt: Math.floor(Date.now() / 1000),
          binding: {
            baseURL: platform.baseURL.href,
            workspace: id,
            createId: id,
            threadRequestId: id,
          },
        };
        this.records.push(record);
        await this.save();
      }
      await this.open(record, true);
      if (!record.binding.threadId) throw new Error("Cloud 未返回 Thread ID");
      return { threadId: record.binding.threadId, sessionId: record.id };
    })().finally(() => this.creating.delete(id));
    this.creating.set(id, task);
    return task;
  }
  /** @param {Record<string,unknown>} request */
  async media(request) {
    const record = this.records.find(
      (value) =>
        value.projectId === request.projectId && value.binding.threadId === request.threadId,
    );
    if (!record) throw new Error("未知 Cloud 会话");
    const live = await this.open(record, true);
    const platform = live.session.platform;
    if (request.operation === "upload" && !live.session.client?.capabilities?.features?.blobUpload)
      throw new Error("远端尚不支持附件上传，请升级运行包");
    return mediaCommand(
      {
        ...createProjectState({ id: record.projectId, root: "" }, live.model),
        client: live.session.client,
        endpoint: platform.baseURL.href,
        token: platform.token,
      },
      request,
      {
        submit: (project, method, params) => {
          if (!project.client) throw new Error("Cloud 连接不可用");
          return project.client.request(method, params);
        },
      },
    );
  }
  /** @param {unknown} value */
  async command(value) {
    validateRequest("cloudSession", value);
    const request = /** @type {SessionRequest} */ (value);
    if (request.operation === "create") return this.create(request);
    const record = this.records.find(
      (value) =>
        value.projectId === request.projectId && value.binding.threadId === request.threadId,
    );
    if (!record) throw new Error("未知 Cloud 会话");
    if (request.operation === "open" || request.operation === "reconnect") {
      await this.open(record, request.operation === "reconnect");
      return this.backend.snapshot();
    }
    const live = await this.context(record);
    if (request.operation === "send") {
      if (live.submitting) throw new Error("请等待当前 Cloud 查询完成");
      live.submitting = true;
      try {
        await this.open(record, true);
        if (
          live.model.state.threads[request.threadId]?.turns?.some(
            (turn) => turn.status === "inProgress",
          )
        )
          throw new Error("请等待当前 Cloud 查询完成");
        const result = await live.session.query(messageInput(this.backend, request));
        if (record.title === "Cloud") {
          record.title = `Cloud · ${(request.text?.trim() || request.attachments?.[0]?.name || "附件").slice(0, 60)}`;
          await this.save();
        }
        return result;
      } finally {
        live.submitting = false;
      }
    }
    if (request.operation === "stop") {
      const client = await live.session.connect();
      return client.request("turn/interrupt", {
        threadId: request.threadId,
        turnId: request.turnId,
      });
    }
    throw new Error("不支持的 Cloud 会话操作");
  }
  close() {
    for (const live of this.live.values()) live.session.close();
  }
}

module.exports = { CloudConversations };
