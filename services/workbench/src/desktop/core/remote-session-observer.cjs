// @ts-check
"use strict";
const decoder = require("./remote-core-decoder.cjs");
const { failure } = decoder;
/** @typedef {import('@areal/runtime-client/core').CoreClient} Client */
/** @typedef {import('./project-state.cjs').CoreProject} CoreProject */
/** @typedef {CoreProject & {client:Client}} ReadyProject */
/** @typedef {{connectionId:string,peer:string,grantRevision:number,gatewayGeneration:string,alive:()=>boolean,send:(value:unknown)=>void,close:()=>void}} RemoteConnection */
/** @typedef {ReturnType<typeof snapshot> & {models?:Record<string,unknown>[]}} SessionState */
/** @typedef {{authorized:()=>boolean,receive:(method:string,params:unknown)=>void,release:()=>void}} PushWatch */
/** @typedef {{id:string,pushWatches?:Set<PushWatch>,viewers:Set<Viewer>,state:SessionState|null,refreshQueued?:boolean}} ThreadObserver */
/** @typedef {{projectId:string,project:ReadyProject,desktop:Client,endpoint:string,token:string,serviceId:string,generation:string,gatewayGeneration:string,threads:Map<string,ThreadObserver>,pending:number,readers:number,tail:Promise<unknown>,closed:boolean,client?:Client,socket?:import('ws'),ready?:Promise<void>,offDesktop?:()=>void,offModel?:()=>void,offClose?:()=>void,offEvents?:()=>void,failureCode?:string}} ObserverEntry */
/** @typedef {{id:string,connection:RemoteConnection,entry:ObserverEntry,thread:ThreadObserver,publish:(value:SessionPublished)=>void,sequence:number,published:boolean,body?:{id:string,encoded:Buffer,turnId:string,itemId:string,expiresAt:number}|null}} Viewer */
/** @typedef {{snapshot:SessionState,[key:string]:unknown}} SessionPublished */
/** @typedef {{task:import('./remote-core-decoder.cjs').Task,item?:import('./remote-core-decoder.cjs').ChannelItem,complete:boolean}} TaskQuestionRead */
const { randomUUID } = require("node:crypto");
const WebSocket = require("ws");
const {
  modelCatalog,
  snapshot,
  update,
  historyPage,
  constrain,
  publicBody,
} = require("./remote-session-projection.cjs");
const { readTaskQuestion } = require("./remote-task-questions.cjs");
const METHODS = ["session.open", "session.history", "session.body", "subscription.close"];
const LIMITS = Object.freeze({
  observerConnections: 16,
  observerSubscriptions: 16,
  observerPendingRequests: 16,
  sessionItems: 100,
  sessionPreviewBytes: 1024,
  nativeHistoryBytes: 4 * 1024 * 1024,
  sessionBodyPageBytes: 32 * 1024,
});
const READ_METHODS = new Set([
  "areal/thread/observe",
  "thread/read",
  "areal/subscription/remove",
  "areal/interaction/list",
  "areal/task/read",
  "areal/channel/read",
]);

class SessionObservers {
  /** @param {InstanceType<typeof import("./remote.cjs").RemoteControl>} remote */
  constructor(remote) {
    this.remote = remote;
    /** @type {Map<string,ObserverEntry>} */
    this.projects = new Map();
    /** @type {Map<string,Viewer>} */
    this.viewers = new Map();
    this.closed = false;
    // 替换项目登记不一定产生 Thread 通知；周期检查只校验身份，不读取/启动 Core。
    this.timer = setInterval(() => this.sweep(), 1000);
    this.timer.unref?.();
  }
  /** @param {RemoteConnection} connection @param {string} projectId */
  authorize(connection, projectId) {
    const remote = this.remote;
    const grant = remote.config?.deviceGrants?.find(
      (v) => v.devicePeerId === connection.peer && v.status === "active",
    );
    if (
      this.closed ||
      remote.closed ||
      !connection.alive() ||
      connection.gatewayGeneration !== remote.gatewayGeneration
    )
      throw failure("RESYNC_REQUIRED", "连接已变化，请重新连接");
    if (!grant || grant.revision !== connection.grantRevision)
      throw failure("GRANT_CHANGED", "授权已变化，请重新连接");
    if (
      !grant.capabilities.includes("observe") ||
      !grant.projectIds.includes(projectId) ||
      !remote.backend.saved.some((v) => v.id === projectId)
    )
      throw failure("FORBIDDEN", "此项目未获授权");
    const project = remote.backend.projects?.get(projectId);
    if (remote.backend.closing || !decoder.readyProject(project))
      throw failure("CORE_UNAVAILABLE", "项目 Core 当前不可用");
    if (
      !project.client.capabilities?.features?.atomicObserveOwnership ||
      !project.client.capabilities?.features?.atomicObserve ||
      !project.client.capabilities?.features?.subscriptionRemoval
    )
      throw failure("CORE_INCOMPATIBLE", "此 Core 不支持安全观察，请在桌面升级");
    return project;
  }
  /** @param {ObserverEntry} entry */
  current(entry) {
    const project = this.remote.backend.projects?.get(entry.projectId);
    return (
      !this.closed &&
      !entry.closed &&
      !this.remote.closed &&
      !this.remote.backend.closing &&
      this.remote.gatewayGeneration === entry.gatewayGeneration &&
      project === entry.project &&
      project?.client === entry.desktop &&
      project.client?.ready &&
      !project.client.closed &&
      project.model?.state?.connected &&
      !project.resourceInitializing &&
      project.endpoint === entry.endpoint &&
      project.token === entry.token &&
      project.service?.serviceId === entry.serviceId &&
      project.service?.generation === entry.generation
    );
  }
  /** @param {ObserverEntry} entry @param {Viewer} [viewer] */
  check(entry, viewer) {
    if (!this.current(entry)) throw failure("RESYNC_REQUIRED", "项目连接已变化，请重新打开会话");
    if (viewer) {
      if (
        this.viewers.get(viewer.connection.connectionId) !== viewer ||
        !viewer.thread.viewers.has(viewer)
      )
        throw failure("RESYNC_REQUIRED", "详情已关闭");
      if (this.authorize(viewer.connection, entry.projectId) !== entry.project)
        throw failure("RESYNC_REQUIRED", "项目已变化");
    }
  }
  /** @param {ObserverEntry} entry @param {string} threadId */
  scope(entry, threadId) {
    return [entry.projectId, entry.serviceId, entry.generation, threadId];
  }
  /** @param {Viewer} viewer */
  keys(viewer) {
    return {
      connectionId: viewer.connection.connectionId,
      gatewayGeneration: viewer.entry.gatewayGeneration,
      projectId: viewer.entry.projectId,
      serviceGeneration: viewer.entry.generation,
      subscriptionId: viewer.id,
    };
  }
  /** @param {Viewer} viewer @param {boolean} [initial] */
  publish(viewer, initial = false) {
    this.check(viewer.entry, viewer);
    if (!viewer.thread.state) return;
    const state = viewer.thread.state;
    const identity = this.remote.config.identity;
    if (!identity) throw failure("RESYNC_REQUIRED", "Host 身份尚未就绪");
    const result = {
      ...this.keys(viewer),
      sequence: initial ? 0 : ++viewer.sequence,
      snapshot: {
        ...viewer.thread.state,
        permissionCapabilities: {
          supported:
            viewer.entry.project.client?.capabilities?.features?.permissionPresets === true,
          fullAccessAvailable:
            viewer.entry.project.client?.capabilities?.features?.permissionFullAccess === true,
        },
        goalControlAllowed:
          state.goalControlAllowed &&
          Object.values(viewer.entry.project.outcomes ?? {}).some((record) => {
            const remote = record.remote,
              receipt = record.receipt;
            return (
              decoder.record(remote) &&
              decoder.record(remote.target) &&
              decoder.record(receipt) &&
              remote.hostId === this.remote.crypto.identityId(identity) &&
              remote.devicePeerId === viewer.connection.peer &&
              remote.projectId === viewer.entry.projectId &&
              remote.method === "session.control" &&
              remote.target.operation === "goalCreate" &&
              record.admissionState === "accepted" &&
              receipt.goalId === state.goals.goal?.id
            );
          }),
      },
    };
    // secure.send 同步序列化、入有界队列；不把可变投影交给稍后的异步写入。
    try {
      if (initial) {
        viewer.publish(result);
        viewer.published = true;
      } else viewer.connection.send({ event: "session.updated", ...result });
    } catch {
      this.release(viewer.connection.connectionId);
      viewer.connection.close();
      throw failure("RESYNC_REQUIRED", "设备发送缓冲已满，请重新连接");
    }
  }
  /** @param {ObserverEntry} entry @param {string} [code] */
  invalidate(entry, code = "RESYNC_REQUIRED") {
    if (entry.closed) return;
    entry.closed = true;
    if (this.projects.get(entry.projectId) === entry) this.projects.delete(entry.projectId);
    entry.offDesktop?.();
    entry.offModel?.();
    entry.offClose?.();
    entry.offEvents?.();
    const error = failure(
      code,
      code === "RESOURCE_UNAVAILABLE"
        ? "原生历史超过接收上限；请在桌面查看"
        : "观察连接已变化；请重新打开会话",
    );
    for (const thread of entry.threads.values())
      for (const viewer of thread.viewers) {
        if (this.viewers.get(viewer.connection.connectionId) === viewer)
          this.viewers.delete(viewer.connection.connectionId);
        if (!viewer.published) continue;
        try {
          viewer.connection.send({
            event: "session.invalidated",
            ...this.keys(viewer),
            sequence: ++viewer.sequence,
            error: { code: decoder.errorCode(error), message: error.message },
            history: { truncated: true, unavailable: true },
          });
        } catch {
          viewer.connection.close();
        }
      }
    entry.threads.clear();
    entry.client?.close();
    entry.socket?.terminate();
  }
  sweep() {
    for (const entry of this.projects.values()) {
      if (!this.current(entry)) {
        this.invalidate(entry);
        continue;
      }
      for (const thread of entry.threads.values()) {
        for (const watch of thread.pushWatches ?? []) if (!watch.authorized()) watch.release();
        for (const viewer of thread.viewers) {
          if (viewer.body && viewer.body.expiresAt < Date.now()) viewer.body = null;
          try {
            this.check(entry, viewer);
          } catch {
            this.release(viewer.connection.connectionId);
          }
        }
      }
    }
  }
  /** @param {RemoteConnection} connection @param {string} projectId */
  entry(connection, projectId) {
    const project = this.authorize(connection, projectId);
    return this.projectEntry(projectId, project);
  }
  /** @param {string} projectId @param {ReadyProject} project */
  projectEntry(projectId, project) {
    let entry = this.projects.get(projectId);
    if (entry && !this.current(entry)) {
      this.invalidate(entry);
      entry = undefined;
    }
    if (entry) return entry;
    if (this.projects.size >= LIMITS.observerConnections)
      throw failure("LIMIT_EXCEEDED", "观察连接已达到上限");
    const endpoint = project.endpoint,
      token = project.token,
      serviceId = project.service?.serviceId,
      generation = project.service?.generation;
    if (typeof serviceId !== "string" || !generation || !endpoint || !token)
      throw failure("CORE_UNAVAILABLE", "项目服务身份不可用");
    entry = {
      projectId,
      project,
      desktop: project.client,
      endpoint,
      token,
      serviceId,
      generation,
      gatewayGeneration: this.remote.gatewayGeneration,
      threads: new Map(),
      pending: 0,
      readers: 0,
      tail: Promise.resolve(),
      closed: false,
    };
    // 在异步加载/握手前占位；待建立的观察连接同样消耗容量。
    this.projects.set(projectId, entry);
    const created = entry;
    entry.offDesktop = entry.desktop.onClose(() => this.invalidate(created));
    entry.offModel = project.model.subscribe(() => {
      if (!this.current(created)) this.invalidate(created);
    });
    entry.ready = this.connect(entry);
    entry.ready.catch(() => {});
    return entry;
  }
  /** @param {ObserverEntry} entry */
  async connect(entry) {
    try {
      const { CoreClient } = await import("@areal/runtime-client/core");
      this.check(entry);
      // 复用已验证的项目服务身份，但绝不覆盖 Desktop client 或注册工具回调。
      const client = (entry.client = new CoreClient({
        createSocket: () => {
          const socket = (entry.socket = new WebSocket(entry.endpoint, {
            headers: { Authorization: `Bearer ${entry.token}` },
            followRedirects: false,
            maxPayload: LIMITS.nativeHistoryBytes,
          }));
          socket.on("error", (error) => {
            if ("code" in error && error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH")
              entry.failureCode = "RESOURCE_UNAVAILABLE";
          });
          return socket;
        },
      }));
      entry.offEvents = client.onNotification((method, params) =>
        this.event(entry, method, params),
      );
      entry.offClose = client.onClose(() => this.invalidate(entry, entry.failureCode));
      await client.connect();
      this.check(entry);
      if (
        !client.capabilities?.features?.atomicObserveOwnership ||
        !client.capabilities?.features?.atomicObserve ||
        !client.capabilities?.features?.subscriptionRemoval
      )
        throw failure("CORE_INCOMPATIBLE", "此 Core 不支持安全观察");
    } catch (error) {
      this.invalidate(entry, entry.failureCode);
      throw error;
    }
  }
  /** @template T @param {ObserverEntry} entry @param {()=>T|Promise<T>} work */
  enqueue(entry, work) {
    if (entry.pending >= LIMITS.observerPendingRequests)
      return Promise.reject(failure("LIMIT_EXCEEDED", "观察请求队列已满"));
    entry.pending++;
    const result = entry.tail.then(async () => {
      await entry.ready;
      this.check(entry);
      return work();
    });
    entry.tail = result
      .catch(() => {})
      .finally(() => {
        entry.pending--;
      });
    return result;
  }
  /** @param {ObserverEntry} entry @param {string} method @param {Record<string,unknown>} params @param {(result:unknown)=>void} [onResult] */
  async rpc(entry, method, params, onResult) {
    if (!READ_METHODS.has(method)) throw new Error("Remote observer RPC is not read-only");
    this.check(entry);
    const client = entry.client;
    if (!client) throw failure("RESYNC_REQUIRED", "观察连接尚未就绪");
    try {
      return await client.request(method, params, {
        onResult: (result) => {
          this.check(entry);
          onResult?.(result);
        },
      });
    } catch (error) {
      const code = decoder.errorCode(error);
      // 超时未取消服务端观察；关闭专用连接，不能遗忘未知是否创建的订阅。
      if (client.closed || code === "RESPONSE_UNKNOWN" || code === "DISCONNECTED")
        this.invalidate(entry, entry.failureCode);
      throw failure(
        entry.failureCode ??
          (["areal/task/read", "areal/channel/read"].includes(method) &&
          (code === -32004 || code === -32009)
            ? "TARGET_CHANGED"
            : code === -32602
              ? "INVALID_PARAMS"
              : code === "RESYNC_REQUIRED" || code === "CORE_INCOMPATIBLE"
                ? code
                : "CORE_UNAVAILABLE"),
        "会话读取不可用；请重新打开或在桌面查看",
      );
    }
  }
  /** @param {RemoteConnection} connection @param {string} projectId @param {(value:unknown)=>void} publish */
  models(connection, projectId, publish) {
    const project = this.authorize(connection, projectId);
    const client = project.client;
    const generation = project.service?.generation;
    const result = {
      projectId,
      gatewayGeneration: connection.gatewayGeneration,
      grantRevision: connection.grantRevision,
      serviceGeneration: generation,
      models: modelCatalog(this.remote.backend.providers, project),
    };
    if (
      this.authorize(connection, projectId) !== project ||
      project.client !== client ||
      project.service?.generation !== generation
    )
      throw failure("RESYNC_REQUIRED", "项目连接已变化，请重新读取");
    if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024)
      throw failure("LIMIT_EXCEEDED", "模型目录超过读取预算");
    publish(result);
  }
  /** @param {ObserverEntry} entry @param {ThreadObserver} thread @param {import("./remote-core-decoder.cjs").Observation} result */
  baseline(entry, thread, result) {
    this.check(entry);
    if (result.thread?.id !== thread.id) throw failure("RESYNC_REQUIRED", "会话身份不匹配");
    if (!["ordinary", "task"].includes(result.ownership?.kind))
      throw failure("CORE_INCOMPATIBLE", "Core 未返回原子会话归属");
    thread.state = snapshot(result.thread, this.scope(entry, thread.id), result.ownership);
    thread.state.models = modelCatalog(this.remote.backend.providers, entry.project);
    constrain(thread.state, this.scope(entry, thread.id));
  }
  /** @param {ObserverEntry} entry @param {ThreadObserver} thread */
  refresh(entry, thread) {
    if (thread.refreshQueued) return;
    thread.refreshQueued = true;
    void this.enqueue(entry, async () => {
      thread.refreshQueued = false;
      if (!thread.viewers.size || entry.threads.get(thread.id) !== thread) return;
      await this.rpc(entry, "areal/thread/observe", { threadId: thread.id }, (result) => {
        this.baseline(entry, thread, decoder.observation(result));
        for (const viewer of Array.from(thread.viewers)) {
          if (!viewer.published) continue;
          try {
            this.publish(viewer);
          } catch {
            this.release(viewer.connection.connectionId);
          }
        }
      });
    }).catch(() => this.invalidate(entry));
  }
  /** @param {ObserverEntry} entry @param {string} method @param {unknown} params */
  event(entry, method, params) {
    if (!this.current(entry)) {
      this.invalidate(entry);
      return;
    }
    if (!decoder.record(params)) return;
    const threadId =
      params.threadId ??
      (decoder.record(params.interaction) ? params.interaction.threadId : undefined);
    if (typeof threadId !== "string") return;
    const thread = entry.threads.get(threadId);
    for (const watch of thread?.pushWatches ?? []) {
      if (watch.authorized()) watch.receive(method, params);
      else watch.release();
    }
    if (!thread?.state) return;
    if (!decoder.notification(params)) {
      this.invalidate(entry);
      return;
    }
    try {
      // 归属由 Core 的原子观察返回；Task-only 变化由显式刷新重新取样。
      if (
        [
          "turn/started",
          "turn/completed",
          "areal/thread/configured",
          "areal/goal/updated",
          "areal/goal/cleared",
        ].includes(method)
      )
        this.refresh(entry, thread);
      if (!update(thread.state, method, params, this.scope(entry, threadId))) return;
      for (const viewer of Array.from(thread.viewers)) {
        if (!viewer.published) continue;
        try {
          this.publish(viewer);
        } catch {
          this.release(viewer.connection.connectionId);
        }
      }
    } catch {
      this.invalidate(entry);
    }
  }
  /** @param {RemoteConnection} connection @param {string} projectId @param {string} threadId @param {(value:SessionPublished)=>void} publish */
  async open(connection, projectId, threadId, publish) {
    this.authorize(connection, projectId);
    this.release(connection.connectionId);
    const entry = this.entry(connection, projectId);
    let thread = entry.threads.get(threadId);
    if (!thread) {
      const count = [...this.projects.values()].reduce((n, value) => n + value.threads.size, 0);
      if (count >= LIMITS.observerSubscriptions) {
        if (!entry.threads.size) this.invalidate(entry);
        throw failure("LIMIT_EXCEEDED", "观察订阅已达到上限");
      }
      thread = { id: threadId, viewers: new Set(), state: null };
      entry.threads.set(threadId, thread);
    }
    /** @type {Viewer} */
    const viewer = {
      id: randomUUID(),
      connection,
      entry,
      thread,
      publish,
      sequence: 0,
      published: false,
    };
    thread.viewers.add(viewer);
    this.viewers.set(connection.connectionId, viewer);
    try {
      await this.enqueue(entry, async () => {
        this.check(entry, viewer);
        await this.rpc(entry, "areal/thread/observe", { threadId }, (result) => {
          this.check(entry, viewer);
          this.baseline(entry, thread, decoder.observation(result));
          // 同栈建立并发布快照；CoreClient 随后的通知只能发生在此基线之后。
          this.publish(viewer, true);
          for (const other of Array.from(thread.viewers)) {
            if (other === viewer || !other.published) continue;
            try {
              this.publish(other);
            } catch {
              this.release(other.connection.connectionId);
            }
          }
        });
      });
    } catch (error) {
      if (this.viewers.get(connection.connectionId) === viewer)
        this.release(connection.connectionId);
      throw error;
    }
  }
  /** @param {RemoteConnection} connection @param {string} projectId @param {string} threadId */
  async admission(connection, projectId, threadId) {
    // 临时引用复用同一个有界只读连接；不能改动 Desktop 的订阅或工具宿主。
    const temporary = { ...connection, connectionId: randomUUID(), send() {} };
    /** @type {SessionState|undefined} */
    let state;
    try {
      await this.open(temporary, projectId, threadId, (value) => {
        state = value.snapshot;
      });
      this.authorize(connection, projectId);
      if (!state) throw failure("RESYNC_REQUIRED", "观察快照不可用");
      return state;
    } finally {
      this.release(temporary.connectionId);
    }
  }
  /** @template T @param {RemoteConnection} connection @param {string} projectId @param {string} threadId @param {(result:import("./remote-core-decoder.cjs").InteractionList,entry:ObserverEntry)=>T} publish */
  async interactions(connection, projectId, threadId, publish) {
    const project = this.authorize(connection, projectId);
    if (!project.client.capabilities?.methods?.includes("areal/interaction/list"))
      throw failure("CORE_INCOMPATIBLE", "Core 不支持交互读取");
    const entry = this.entry(connection, projectId);
    entry.readers++;
    try {
      return await this.enqueue(entry, async () => {
        this.authorize(connection, projectId);
        const result = decoder.interactions(
          await this.rpc(entry, "areal/interaction/list", { threadId }),
        );
        // await 后在同一栈验证身份并发布；临时读取不替换前台 Session viewer。
        this.check(entry);
        if (this.authorize(connection, projectId) !== entry.project)
          throw failure("RESYNC_REQUIRED", "项目已变化");
        if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.nativeHistoryBytes)
          throw failure("RESOURCE_UNAVAILABLE", "原生交互超过读取上限");
        return publish(result, entry);
      });
    } finally {
      entry.readers--;
      if (
        !entry.readers &&
        ![...entry.threads.values()].some((value) => value.viewers.size || value.pushWatches?.size)
      )
        this.invalidate(entry);
    }
  }
  /** @template T @param {RemoteConnection} connection @param {string} projectId @param {{taskId:string,runId?:string,questionId?:string}} params @param {(result:TaskQuestionRead,entry:ObserverEntry)=>T} publish */
  taskQuestion(connection, projectId, params, publish) {
    return readTaskQuestion(this, connection, projectId, params, publish);
  }
  /** @template T @param {RemoteConnection} connection @param {string} projectId @param {string} threadId @param {(thread:import("./remote-core-decoder.cjs").Thread,entry:ObserverEntry,check:()=>void,read:()=>Promise<import("./remote-core-decoder.cjs").Thread>)=>T} work */
  async reviewThread(connection, projectId, threadId, work) {
    const entry = this.entry(connection, projectId);
    entry.readers++;
    try {
      return await this.enqueue(entry, async () => {
        const check = () => {
          this.check(entry);
          if (this.authorize(connection, projectId) !== entry.project)
            throw failure("RESYNC_REQUIRED", "项目已变化");
        };
        const read = async () => {
          check();
          const result = decoder.threadRead(
            await this.rpc(entry, "thread/read", {
              threadId,
              includeTurns: true,
            }),
          );
          check();
          if (
            result.thread?.id !== threadId ||
            Buffer.byteLength(JSON.stringify(result)) > LIMITS.nativeHistoryBytes
          )
            throw failure("RESOURCE_UNAVAILABLE", "原历史不可用或超过读取上限");
          return result.thread;
        };
        const thread = await read();
        check();
        return await work(thread, entry, check, read);
      });
    } finally {
      entry.readers--;
      if (
        !entry.readers &&
        ![...entry.threads.values()].some((value) => value.viewers.size || value.pushWatches?.size)
      )
        this.invalidate(entry);
    }
  }
  /** @param {RemoteConnection} connection @param {string} projectId @param {{threadId:string,cursor?:string,limit?:number}} params @param {(value:unknown)=>unknown} publish */
  async history(connection, projectId, params, publish) {
    const viewer = this.viewers.get(connection.connectionId);
    if (
      !viewer ||
      viewer.entry.projectId !== projectId ||
      viewer.thread.id !== params.threadId ||
      !viewer.published
    )
      throw failure("INVALID_PARAMS", "请先打开此会话");
    const entry = viewer.entry;
    await this.enqueue(entry, async () => {
      this.check(entry, viewer);
      await this.rpc(
        entry,
        "thread/read",
        { threadId: params.threadId, includeTurns: true },
        (raw) => {
          const result = decoder.threadRead(raw);
          this.check(entry, viewer);
          if (result.thread?.id !== params.threadId)
            throw failure("RESYNC_REQUIRED", "会话身份不匹配");
          const page = historyPage(
            result.thread,
            this.scope(entry, params.threadId),
            params.cursor,
            params.limit ?? 100,
          );
          publish({ ...this.keys(viewer), threadId: params.threadId, ...page });
        },
      );
    });
  }
  /** @template T @param {RemoteConnection} connection @param {string} projectId @param {{threadId:string,turnId:string,itemId:string,cursor?:string}} params @param {(value:unknown)=>T} publish */
  async body(connection, projectId, params, publish) {
    const viewer = this.viewers.get(connection.connectionId);
    if (
      !viewer ||
      !viewer.published ||
      viewer.entry.projectId !== projectId ||
      viewer.thread.id !== params.threadId
    )
      throw failure("INVALID_PARAMS", "请先打开此会话");
    const entry = viewer.entry;
    return this.enqueue(entry, async () => {
      this.check(entry, viewer);
      if (params.cursor === undefined) {
        const result = decoder.threadRead(
          await this.rpc(entry, "thread/read", {
            threadId: params.threadId,
            includeTurns: true,
          }),
        );
        this.check(entry, viewer);
        if (result.thread?.id !== params.threadId)
          throw failure("RESYNC_REQUIRED", "会话身份不匹配");
        const item = result.thread.turns
          ?.find((t) => t.id === params.turnId)
          ?.items?.find((i) => i.id === params.itemId);
        const body = item && publicBody(item);
        if (!body) throw failure("FORBIDDEN", "此正文不可读取");
        const encoded = Buffer.from(JSON.stringify(body));
        if (encoded.length > LIMITS.nativeHistoryBytes)
          throw failure("RESOURCE_UNAVAILABLE", "正文超过读取容量");
        // One frozen, bounded body per active subscription. Streaming
        // changes cannot splice together pages from different versions.
        viewer.body = {
          id: randomUUID(),
          encoded,
          turnId: params.turnId,
          itemId: params.itemId,
          expiresAt: Date.now() + 45000,
        };
      }
      const body = viewer.body;
      const [id, rawOffset] = (params.cursor ?? `${body?.id}:0`).split(":");
      const offset = Number(rawOffset);
      if (
        !body ||
        body.expiresAt < Date.now() ||
        body.id !== id ||
        body.turnId !== params.turnId ||
        body.itemId !== params.itemId ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset >= body.encoded.length
      )
        throw failure("RESYNC_REQUIRED", "正文版本已变化，请重新读取");
      const chunk = new TextDecoder().decode(
        body.encoded.subarray(offset, offset + LIMITS.sessionBodyPageBytes),
        { stream: true },
      );
      const next = offset + Buffer.byteLength(chunk);
      this.check(entry, viewer);
      const result = {
        ...this.keys(viewer),
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        body: { version: body.id, offset, totalBytes: body.encoded.length, chunk },
        nextCursor: next < body.encoded.length ? `${body.id}:${next}` : null,
      };
      const value = publish(result);
      if (!result.nextCursor) viewer.body = null;
      return value;
    });
  }
  /** @param {string} connectionId @param {string} [subscriptionId] */
  release(connectionId, subscriptionId) {
    const viewer = this.viewers.get(connectionId);
    if (!viewer || (subscriptionId !== undefined && viewer.id !== subscriptionId)) return false;
    this.viewers.delete(connectionId);
    viewer.body = null;
    const { entry, thread } = viewer;
    thread.viewers.delete(viewer);
    if (!thread.viewers.size) thread.state = null;
    this.releaseUnused(entry, thread);
    return true;
  }
  /** @param {ObserverEntry} entry @param {ThreadObserver} thread */
  releaseUnused(entry, thread) {
    if (entry.closed || thread.viewers.size || thread.pushWatches?.size) return;
    if (
      !entry.readers &&
      ![...entry.threads.values()].some((value) => value.viewers.size || value.pushWatches?.size)
    ) {
      this.invalidate(entry);
      return;
    }
    void this.enqueue(entry, async () => {
      if (
        thread.viewers.size ||
        thread.pushWatches?.size ||
        entry.threads.get(thread.id) !== thread
      )
        return;
      await this.rpc(entry, "areal/subscription/remove", { threadIds: [thread.id] });
      if (
        !thread.viewers.size &&
        !thread.pushWatches?.size &&
        entry.threads.get(thread.id) === thread
      )
        entry.threads.delete(thread.id);
    }).catch(() => this.invalidate(entry));
  }
  /** @param {string} projectId @param {string} threadId @param {()=>boolean} authorized @param {(method:string,params:unknown)=>void} receive */
  watchPush(projectId, threadId, authorized, receive) {
    const project = this.remote.backend.projects.get(projectId);
    if (!authorized() || !decoder.readyProject(project))
      throw failure("FORBIDDEN", "推送观察未获授权");
    const count = [...this.projects.values()].reduce(
      (sum, entry) =>
        sum +
        [...entry.threads.values()].reduce((n, thread) => n + (thread.pushWatches?.size ?? 0), 0),
      0,
    );
    if (count >= LIMITS.observerSubscriptions)
      throw failure("LIMIT_EXCEEDED", "推送观察已达到上限");
    const entry = this.projectEntry(projectId, project);
    let thread = entry.threads.get(threadId);
    if (!thread) {
      const subscriptions = [...this.projects.values()].reduce(
        (sum, value) => sum + value.threads.size,
        0,
      );
      if (subscriptions >= LIMITS.observerSubscriptions) {
        if (!entry.threads.size) this.invalidate(entry);
        throw failure("LIMIT_EXCEEDED", "观察订阅已达到上限");
      }
      thread = { id: threadId, viewers: new Set(), state: null };
      entry.threads.set(threadId, thread);
    }
    const target = thread;
    const watch = {
      authorized,
      receive,
      release: () => {
        target.pushWatches?.delete(watch);
        this.releaseUnused(entry, target);
      },
    };
    (thread.pushWatches ??= new Set()).add(watch);
    void this.enqueue(entry, async () => {
      if (!watch.authorized()) {
        watch.release();
        return;
      }
      await this.rpc(entry, "areal/thread/observe", { threadId }, (raw) => {
        if (watch.authorized()) watch.receive("baseline", decoder.observation(raw));
      });
    }).catch(() => watch.release());
    return {
      release: watch.release,
      alive: () => !entry.closed && target.pushWatches?.has(watch) === true,
    };
  }
  close() {
    if (this.closed) return;
    clearInterval(this.timer);
    for (const entry of this.projects.values()) this.invalidate(entry);
    this.closed = true;
  }
}
module.exports = { SessionObservers, METHODS, LIMITS };
