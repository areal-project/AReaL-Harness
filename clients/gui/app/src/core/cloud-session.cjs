// @ts-check
"use strict";

const {
  turnAdmission,
} = require("../../../packages/workbench/client/desktop-contract/conversation.cjs");
const { readObservationResult } = require("./history-contract.cjs");
/** @typedef {{baseURL?:string,createId?:string,threadRequestId?:string,threadId?:string,sessionId?:string,workspace?:string}} Binding */
/** @typedef {import('@areal/runtime-client/core').CoreClient} CoreClient */
const { modelRecord } = require("@areal/workbench/core-model-contract");
const { randomUUID } = require("node:crypto");

/** 一个桌面会话绑定远端原生 thread，连接方式与运行平台无关。 */
class CloudSession {
  /** @param {{platform:InstanceType<typeof import('./cloud-client.cjs').CloudClient>,binding:Binding,save:(binding:Binding)=>Promise<void>,onNotification?:(method:string,params:unknown)=>void,onSnapshot?:(thread:import('@areal/workbench/core-model-contract').CoreThread)=>void,onClose?:()=>void}} options */
  constructor({
    platform,
    binding,
    save,
    onNotification = () => {},
    onSnapshot = () => {},
    onClose = () => {},
  }) {
    this.platform = platform;
    this.binding = binding;
    this.save = save;
    this.onNotification = onNotification;
    this.onSnapshot = onSnapshot;
    this.onClose = onClose;
    /** @type {CoreClient|null} */
    this.client = null;
    /** @type {Promise<CoreClient>|null} */
    this.connecting = null;
    this.closed = false;
    this.onIdle = () => {};
  }

  /** @param {{signal?:AbortSignal}} [options] @returns {Promise<CoreClient>} */
  connect({ signal } = {}) {
    if (this.closed) return Promise.reject(new Error("Cloud 会话连接已关闭"));
    if (this.client?.ready) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    this.connecting = this.establish(signal).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /** @param {AbortSignal|undefined} signal @returns {Promise<CoreClient>} */
  async establish(signal) {
    const baseURL = this.platform.baseURL.href;
    if (this.binding.baseURL && this.binding.baseURL !== baseURL)
      throw new Error("此会话属于另一个 Cloud 后端，请恢复原后端配置");
    // 先持久化幂等键；网络中断后只能核对同一个创建意图。
    if (!this.binding.createId) {
      this.binding = {
        ...this.binding,
        baseURL,
        createId: randomUUID(),
        threadRequestId: randomUUID(),
      };
      await this.save(this.binding);
    }
    if (this.binding.sessionId?.startsWith("ses_"))
      throw new Error("旧 Arena 会话请使用原客户端打开；新入口使用原生 app-server 工作区");
    /** @type {CoreClient|undefined} */
    let client;
    client = await this.platform.connect({
      onNotification: (method, params) => {
        this.onNotification(method, params);
        if (method === "areal/server/draining") {
          client?.close();
          this.onIdle();
        }
      },
      onClose: () => {
        if (this.client === client && !this.closed) this.onClose();
      },
    });
    if (this.closed || signal?.aborted) {
      client.close();
      throw new Error("Cloud 连接已取消");
    }
    this.client?.close();
    this.client = client;
    try {
      if (this.closed || signal?.aborted) throw new Error("Cloud 连接已取消");
      if (!this.binding.threadId) {
        if (!client.capabilities?.methods?.includes("areal/thread/start"))
          throw new Error("远端不支持幂等会话创建，请升级 AReaL app-server");
        const catalog = await client.request(
          "areal/profile/list",
          {},
          {
            decode: (value) => {
              if (!modelRecord(value) || !Array.isArray(value.data))
                throw new Error("Cloud Profile 列表无效");
              return {
                data: value.data.map((/** @type {unknown} */ item) => {
                  if (
                    !modelRecord(item) ||
                    typeof item.id !== "string" ||
                    typeof item.revision !== "string"
                  )
                    throw new Error("Cloud Profile 引用无效");
                  return { id: item.id, revision: item.revision };
                }),
              };
            },
          },
        );
        const profiles = catalog.data ?? [];
        if (profiles.length > 1)
          throw new Error("远端存在多个 Agent Profile，请在服务端配置唯一默认运行包");
        const profile = profiles[0];
        const result = await client.request(
          "areal/thread/start",
          {
            requestId: this.binding.threadRequestId,
            ...(profile ? { agentProfile: { id: profile.id, revision: profile.revision } } : {}),
          },
          { decode: readObservationResult },
        );
        if (!result.thread?.id) throw new Error("Cloud 未返回 Thread ID");
        this.binding = { ...this.binding, threadId: result.thread.id };
        await this.save(this.binding);
      }
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  /** @param {{signal?:AbortSignal}} [options] */
  async read({ signal } = {}) {
    const client = await this.connect({ signal });
    // 读取和订阅权威历史；重连不重放任何 turn/start。
    // 在响应分派栈安装快照，避免覆盖同批到达的后续通知。
    const options = {
      decode: readObservationResult,
      onResult: (/** @type {import("./history-contract.cjs").ObservationResult} */ result) =>
        this.onSnapshot(result.thread),
    };
    if (client.capabilities?.methods?.includes("areal/thread/observe")) {
      return client.request("areal/thread/observe", { threadId: this.binding.threadId }, options);
    }
    // 旧 Core 只读恢复，不通过 thread/resume 接管已有桌面工具宿主。
    return client.request(
      "thread/read",
      { threadId: this.binding.threadId, includeTurns: true },
      options,
    );
  }

  /** @param {import("./media.cjs").MessageInput[]} input @param {{signal?:AbortSignal}} [options] */
  async query(input, { signal } = {}) {
    if (!Array.isArray(input) || !input.length) throw new Error("请输入消息或添加附件");
    const client = await this.connect({ signal });
    await this.read({ signal });
    // 标准 turn/start 只接受 threadId/input；未知提交不得通过重试制造重复执行。
    return client.request(
      "turn/start",
      {
        threadId: this.binding.threadId,
        input,
      },
      {
        decode: (result) => {
          if (!turnAdmission(result)) throw new Error("Cloud 未返回有效的轮次受理回执");
          return result;
        },
      },
    );
  }

  close() {
    this.closed = true;
    this.client?.close();
    // 关闭窗口只断开客户端；不停止云端 Session 或删除 UPFS。
  }
}

module.exports = { CloudSession };
