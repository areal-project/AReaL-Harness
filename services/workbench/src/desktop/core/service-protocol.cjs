// @ts-check
"use strict";
const { randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { appendFileSync } = require("node:fs");
const { WebSocketServer } = require("ws");
const { NativeRemote } = require("./native-remote.cjs");
const {
  desktopError,
  validateMcpPageDeclaration,
  validateMcpPageReply,
} = require("@areal/workbench/desktop-contract");
/** @type {typeof import('@areal/workbench/desktop-contract')} */
const desktopContract = require("@areal/workbench/desktop-contract");
const { inspectResources, recoverResource, blocked } = require("./resource-recovery.cjs");
const {
  validToolInput,
  describeCommands,
  discoveryGuidance,
  failure: browserFailure,
  success: browserSuccess,
  unconfirmed: browserUnconfirmed,
} = require("./browser-tool.cjs");
const { validComputerInput } = require("./computer-tool.cjs");
const { ProjectionEncoder } = require("@areal/workbench/state-projection");
const {
  record,
  text,
  integer,
  strings,
  toolRequest,
  discoveryPlan,
  pageRegistration,
  pageToolRequest,
  pageCoordinates,
  queueList,
} = require("./service-transport-contract.cjs");
/** @typedef {Record<string,unknown>} Fields */
/** @typedef {import('@areal/runtime-client/core').CoreClient} CoreClient */
/** @typedef {import('./project-state.cjs').CoreProject} Project */
/** @typedef {import('./service-transport-contract.cjs').ToolRequest} ToolRequest */
/** @typedef {import('./service-transport-contract.cjs').ToolHostInput} ToolHostInput */
/** @typedef {{kind:'packet',packet:ReturnType<InstanceType<typeof DesktopService>['packet']>,header:{method:'state'}|{id:number},full:boolean,bytes:number}} PacketEntry */
/** @typedef {PacketEntry|{kind:'message',value:Fields,bytes:number}} OutboundEntry */
/** @typedef {{queue:OutboundEntry[],bytes:number,active:boolean,state:PacketEntry|null,closed:boolean,timer?:NodeJS.Timeout}} Outbound */
/** @typedef {import('ws') & {outbound?:Outbound,projection?:InstanceType<typeof ProjectionEncoder>|null,notifications?:boolean,activity?:{time:number,windowFocused:boolean,focused:boolean},lastFocused?:number,historyViews?:Map<string,Fields & {viewId:string}>,mcpPageOwnerId?:string}} RemoteServiceSocket */
/** @typedef {Pick<RemoteServiceSocket,'notifications'|'activity'|'lastFocused'|'historyViews'|'mcpPageOwnerId'> & {kind:'main',internal:boolean,closed:boolean,onMessage:(message:Fields)=>void,onClose:()=>void}} MainClient */
/** @typedef {RemoteServiceSocket|MainClient} ServiceSocket */
/** @param {ServiceSocket|null|undefined} client @returns {client is MainClient} */
const mainClient = (client) => !!client && "kind" in client && client.kind === "main";
/** @param {ServiceSocket|null|undefined} client @returns {client is ServiceSocket} */
const connected = (client) =>
  !!client && (mainClient(client) ? !client.closed : client.readyState === 1);
/** @typedef {{pageId:string,pageGeneration:number,controlEpoch:number}} PageClaim */
/** @typedef {{socket:ServiceSocket,hostConnection?:string,coreInstanceId:string,coreGeneration:string,browserHostId:string,hostGeneration:number,pages:Map<string,PageClaim>,revokedPages:Set<string>}} BrowserClaim */
/** @typedef {{turnId?:string,queueItemId?:string}|null} AcceptedEntry */
/** @typedef {{socket:ServiceSocket,hostConnection?:string,project:Project,client:CoreClient|null|undefined,ready:Promise<AcceptedEntry>,resolve:(value:AcceptedEntry)=>void,accepted?:AcceptedEntry}} BrowserEntry */
/** @typedef {{socket:ServiceSocket,timer?:NodeJS.Timeout,hostConnection?:string,resolve:(value:unknown)=>void,reject:(error:unknown)=>void,key?:string,bootstrap?:boolean,discovery?:boolean,coreInstanceId?:string,coreGeneration?:string,tool?:string}} BrowserPending */
/** @typedef {{projectId:string,client:CoreClient,method:string,params:import('./service-transport-contract.cjs').PageCoordinates}} PageNotice */
/** @typedef {{projectId:string,threadId:string,instanceId:string,generation:string|number,ownerId:string,revoked:boolean,retired?:boolean,retireAt?:number}} RetiredPageOwner */
/** @typedef {RetiredPageOwner & {socket:ServiceSocket,project:Project,client:CoreClient,declaration?:string,registration?:import('./service-transport-contract.cjs').PageRegistration,registrationPromise?:Promise<import('./service-transport-contract.cjs').PageRegistration>,pendingNotices?:PageNotice[]}} LivePageOwner */
/** @typedef {RetiredPageOwner & Partial<Omit<LivePageOwner,keyof RetiredPageOwner>>} PageOwner */
/** @typedef {{connection:string,method:string,params:Fields,project:Project,client:CoreClient,current:()=>boolean,key:string,entry:BrowserEntry|null,timer:NodeJS.Timeout}} HostExecution */
/** @typedef {{key:string,plan:import('./service-transport-contract.cjs').DiscoveryPlan,claim:BrowserClaim|undefined,entry:BrowserEntry|null,socket:ServiceSocket,pages:PageClaim[]}} DiscoveryRecord */
const PROTOCOL = "areal.desktop-service.v1";
const COMMAND_CONTRACT = "areal.desktop-commands.v3";
/** @param {unknown} projectId @param {unknown} threadId */
const browserKey = (projectId, threadId) => JSON.stringify([projectId, threadId]);
/** @param {string} name @param {Fields} request */
const computerSetting = (name, request) =>
  name === "library" &&
  request?.operation === "settings" &&
  ["computerControlEnabled", "computerControlProvider", "computerControlExecutable"].some(
    (key) => key === request.key,
  );

/** @param {string} name @param {unknown} params */
function validateCommand(name, params) {
  desktopContract.readCommandInvocation(name, params);
}

// Media is the only binary value in the desktop contract. Keep the existing
// Uint8Array IPC API; use bounded base64 only across the service JSON transport.
/** @param {unknown} value */
function encodeMedia(value) {
  if (!record(value) || value.bytes === undefined) return value;
  if (!(value.bytes instanceof Uint8Array) || value.bytes.length > 16 * 1024 * 1024)
    throw new Error("附件必须为 1 B–16 MiB");
  return { ...value, bytes: Buffer.from(value.bytes).toString("base64") };
}
/** @overload @param {Fields} value @returns {Fields} */
/** @overload @param {unknown} value @returns {unknown} */
/** @param {unknown} value */
function decodeMedia(value) {
  if (!record(value) || value.bytes === undefined) return value;
  if (typeof value.bytes !== "string" || value.bytes.length > 22369624)
    throw new Error("无效附件编码");
  const bytes = Buffer.from(value.bytes, "base64");
  if (bytes.length > 16 * 1024 * 1024 || bytes.toString("base64") !== value.bytes)
    throw new Error("无效附件编码");
  return { ...value, bytes: new Uint8Array(bytes) };
}

// One writer for provider secrets, recovery journals and projections. Core remains
// authoritative for execution. No generic RPC passthrough; credential reveal is an explicit local request.
class DesktopService {
  /** @type {Map<number,{socket:ServiceSocket,timer:NodeJS.Timeout,resolve:(value:string)=>void,reject:(error:Error)=>void}>} */
  encryptionPending = new Map();
  encryptionSequence = 0;
  /** 只向当前原生外壳取安全存储能力；断开后不重放。 @param {'encrypt'|'decrypt'} operation @param {string} value */
  encryptionRequest(operation, value) {
    const socket = this.computerSocket;
    if (this.closed || !connected(socket) || this.encryptionPending.size >= 16)
      return Promise.reject(new Error("系统安全存储外壳不可用"));
    const requestId = ++this.encryptionSequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.encryptionPending.delete(requestId);
        reject(new Error("系统安全存储请求超时"));
      }, 15000);
      this.encryptionPending.set(requestId, { socket, timer, resolve, reject });
      this.send(socket, { method: "encryptionRequest", params: { requestId, operation, value } });
    });
  }
  /** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend @param {string} identity
   * @param {()=>void} [onStop] @param {InstanceType<typeof import('./notifications.cjs').BackgroundNotifications>} [backgroundNotifications]
   * @param {InstanceType<typeof import('./power.cjs').SharedPowerMonitor>} [power] */
  constructor(backend, identity, onStop = () => {}, backgroundNotifications, power) {
    this.backend = backend;
    this.identity = identity;
    this.onStop = onStop;
    this.lifecycle = backend.lifecycleOperations?.attach(this);
    this.backgroundNotifications = backgroundNotifications;
    this.power = power;
    /** @type {unknown} */
    this.pendingNotificationTarget = null;
    this.token = randomBytes(32).toString("hex");
    /** @type {Set<ServiceSocket>} */ this.clients = new Set();
    /** @type {Map<ServiceSocket,Map<string,{client:import('@areal/workbench-service/host-core-client').HostCoreClient,ready:Promise<unknown>,key:string}>>} */
    this.hostTerminals = new Map();
    /** @type {Map<string,PageOwner>} */
    this.mcpPageOwners = new Map();
    backend.onMcpPageToolNotice = (event) => this.mcpPageToolNotice(event);
    backend.onMcpPageToolsDisconnected = (client) =>
      this.revokeMcpPageTools((lease) => lease.client === client);
    /** @type {Map<string,BrowserClaim>} */ this.browserClaims = new Map();
    /** @type {Map<string,{socket:ServiceSocket,pageId:string,cancelled:boolean}>} */ this.browserClaimAttempts =
      new Map();
    /** @type {Map<string,Set<BrowserEntry>>} */ this.browserEntrypoints = new Map();
    /** @type {Map<string,HostExecution>} */ this.hostExecutions = new Map();
    /** @type {Map<string,object>} */ this.hostConnections = new Map();
    /** @type {Map<string,DiscoveryRecord>} */ this.browserDiscoveryPlans = new Map();
    /** @type {Map<number,BrowserPending>} */ this.browserPending = new Map();
    this.nextBrowserId = 0;
    /** @type {Map<number,{socket:ServiceSocket,resolve:(value:unknown)=>void,reject:(error:Error)=>void,timer:NodeJS.Timeout}>} */
    this.terminalPending = new Map();
    this.nextTerminalId = 0;
    this.browserTestTrace = process.env.AREAL_BROWSER_READ_TEST_TRACE;
    backend.browserRead = (request) => this.browserRead(request);
    backend.computerRead = (request) => this.computerRead(request);
    backend.cuaRead = (request) => this.cuaRead(request);
    this.sequence = 0;
    this.inflight = 0;
    /** @type {number|null} */ this.idleSince = Date.now();
    this.closed = false;
    /** @type {InstanceType<typeof NativeRemote>|undefined} */ this.remote = undefined;
    /** @type {ServiceSocket|null|undefined} */ this.computerSocket = undefined;
    backend.desktopToolOwner = () =>
      !this.closed && connected(this.computerSocket) ? this.computerSocket : null;
    /** @type {NodeJS.Timeout|null|undefined} */ this.timer = undefined;
    /** @type {NodeJS.Timeout|undefined} */ this.mcpPageExpiryTimer = undefined;
    /** @type {NodeJS.Timeout|undefined} */ this.activityTimer = undefined;
    /** @type {NodeJS.Timeout|undefined} */ this.flushTimer = undefined;
    /** @type {import('ws').WebSocketServer|undefined} */ this.server = undefined;
    /** @type {Promise<{hostId:string,generation:string}>|undefined} */ this.hostReconnection =
      undefined;
    this.exitRequested = false;
    this.recovering = false;
    backend.onChange = () => this.schedule();
    backend.onNotification = (notice) => this.notify(notice);
    backend.onMcpAppNotification = (event) => {
      if (!record(event)) return;
      const notification = event.notification;
      if (
        this.closed ||
        !["projectId", "threadId", "instanceId"].every((key) => typeof event?.[key] === "string") ||
        !["string", "number"].includes(typeof event.generation) ||
        !record(notification) ||
        notification.jsonrpc !== "2.0" ||
        notification.id !== undefined ||
        ![
          "notifications/resources/updated",
          "notifications/resources/list_changed",
          "notifications/tools/list_changed",
          "ui/notifications/host-context-changed",
          "ui/notifications/closed",
        ].some((method) => method === notification.method)
      )
        return;
      // Only authenticated clients that completed hello are present in this set.
      // Main owns the final app-instance/window match; background events never reveal a pane.
      const params = {
        projectId: event.projectId,
        threadId: event.threadId,
        instanceId: event.instanceId,
        generation: event.generation,
        notification: {
          jsonrpc: "2.0",
          method: notification.method,
          ...(notification.params === undefined ? {} : { params: notification.params }),
        },
      };
      if (notification.method === "ui/notifications/closed") {
        const lease = this.mcpPageOwners.get(JSON.stringify([event.projectId, event.instanceId]));
        if (lease && lease.threadId === event.threadId && lease.generation === event.generation)
          this.retireMcpPageOwner(lease, true);
      }
      for (const socket of this.clients)
        this.send(socket, { method: "mcpAppNotification", params });
    };
  }
  /** @param {string} projectId @param {string} threadId */
  projectForThread(projectId, threadId) {
    const owner = this.backend.worktrees?.executionProjectId(projectId, threadId) ?? projectId;
    return this.backend.projects.get(owner);
  }
  /** @param {ServiceSocket} socket @param {Project} project @param {CoreClient} client @param {Fields} request @param {unknown} response */
  bindMcpPageOwner(socket, project, client, request, response) {
    const instance =
      request.operation === "mcpAppOpenFromResult"
        ? record(response) && response.status === "open" && response.instance
        : response;
    if (!record(instance) || !instance.instanceId) return;
    if (
      typeof instance.instanceId !== "string" ||
      (typeof instance.generation !== "string" && typeof instance.generation !== "number")
    )
      throw new Error("Invalid MCP app identity");
    const projectId = request.logicalProjectId ?? project.logicalProjectId ?? request.projectId;
    if (typeof projectId !== "string" || typeof request.threadId !== "string")
      throw new Error("Invalid MCP app owner");
    const key = JSON.stringify([projectId, instance.instanceId]);
    const previous = this.mcpPageOwners.get(key);
    if (
      this.closed ||
      !this.clients.has(socket) ||
      !connected(socket) ||
      project.client !== client ||
      !client.ready ||
      (previous && (previous.socket !== socket || previous.client !== client || previous.revoked))
    )
      throw new Error("Page tool opening owner lease is stale");
    if (previous) return;
    if (this.mcpPageOwners.size >= 128) throw new Error("Page tool owner capacity reached");
    this.mcpPageOwners.set(key, {
      project,
      client,
      socket,
      ownerId: (socket.mcpPageOwnerId ??= randomUUID()),
      projectId,
      threadId: request.threadId,
      instanceId: instance.instanceId,
      generation: instance.generation,
      revoked: false,
    });
  }
  /** @param {ServiceSocket} socket @param {unknown} params */
  async mcpPageTools(socket, params) {
    if (!pageToolRequest(params)) throw new Error("Invalid page tool operation");
    const fields = ["operation", "projectId", "threadId", "instanceId", "generation"];
    const extra =
      params.operation === "register"
        ? ["declaration"]
        : params.operation === "revoke"
          ? ["registrationId"]
          : [
              "turnId",
              "callId",
              "registrationId",
              "ownerId",
              "schemaDigest",
              ...(params.operation === "resolve" ? ["claimId", "reply"] : []),
            ];
    if (Object.keys(params).some((key) => ![...fields, ...extra].includes(key)))
      throw new Error("Invalid page tool fields");
    const lease = this.mcpPageOwners.get(JSON.stringify([params.projectId, params.instanceId]));
    const current = () =>
      lease &&
      livePageOwner(lease) &&
      this.mcpPageOwners.get(JSON.stringify([params.projectId, params.instanceId])) === lease &&
      lease.socket === socket &&
      lease.client === lease.project.client &&
      lease.client.ready &&
      this.clients.has(socket) &&
      connected(socket) &&
      !this.closed;
    if (
      !lease ||
      !livePageOwner(lease) ||
      !current() ||
      lease.threadId !== params.threadId ||
      lease.generation !== params.generation ||
      (lease.revoked && !["resolve", "revoke"].includes(params.operation))
    )
      throw new Error("Page tool owner lease is stale");
    const binding = {
      threadId: lease.threadId,
      instanceId: lease.instanceId,
      generation: lease.generation,
      ownerId: lease.ownerId,
    };
    if (params.operation === "register") {
      validateMcpPageDeclaration(params.declaration);
      const fingerprint = JSON.stringify(params.declaration);
      if (lease.registrationPromise) {
        if (lease.declaration !== fingerprint) throw new Error("Page tool declaration changed");
        return lease.registrationPromise;
      }
      lease.declaration = fingerprint;
      lease.pendingNotices = [];
      lease.registrationPromise = (async () => {
        const registration = await lease.client.request(
          "areal/mcp/app/tools/register",
          { ...binding, declaration: params.declaration },
          { decode: pageRegistration },
        );
        lease.registration = registration;
        if (!current() || lease.revoked) {
          this.retireMcpPageOwner(lease);
          if (lease.client.ready)
            void lease.client
              .request("areal/mcp/app/tools/revoke", {
                ...binding,
                registrationId: registration.registrationId,
              })
              .then((result) => {
                if (record(result) && result.revoked === true) this.retireMcpPageOwner(lease, true);
              })
              .catch(() => {});
          throw new Error("Page tool owner lease is stale");
        }
        const notices = lease.pendingNotices;
        lease.pendingNotices = undefined;
        for (const notice of notices ?? [])
          if (notice.params.registrationId === registration.registrationId)
            this.mcpPageToolNotice(notice);
        return registration;
      })().catch((error) => {
        this.retireMcpPageOwner(lease);
        throw error;
      });
      return lease.registrationPromise;
    }
    if (!lease.registration || params.registrationId !== lease.registration.registrationId)
      throw new Error("Invalid page tool registration");
    if (params.operation === "revoke") {
      this.retireMcpPageOwner(lease);
      const result = await lease.client.request("areal/mcp/app/tools/revoke", {
        ...binding,
        registrationId: lease.registration.registrationId,
      });
      if (record(result) && result.revoked === true) this.retireMcpPageOwner(lease, true);
      return result;
    }
    if (
      params.ownerId !== lease.ownerId ||
      !lease.registration.tools.some((tool) => tool.schemaDigest === params.schemaDigest) ||
      !text(params.turnId) ||
      !text(params.callId)
    )
      throw new Error("Invalid page tool owner or call");
    const coordinates = {
      threadId: lease.threadId,
      turnId: params.turnId,
      callId: params.callId,
      registrationId: lease.registration.registrationId,
      ownerId: lease.ownerId,
      schemaDigest: params.schemaDigest,
    };
    if (params.operation === "resolve") validateMcpPageReply(params.reply);
    return lease.client.request(`areal/mcp/app/tools/${params.operation}`, {
      ...coordinates,
      ...(params.operation === "resolve"
        ? {
            ...(params.claimId === undefined ? {} : { claimId: params.claimId }),
            reply: params.reply,
          }
        : {}),
    });
  }
  /** @param {{projectId:string,client:CoreClient,method:string,params:unknown}} event */
  mcpPageToolNotice(event) {
    if (
      this.closed ||
      !["areal/mcp/app/tools/pending", "areal/mcp/app/tools/cancelled"].includes(event?.method)
    )
      return;
    const params = event.params;
    const coordinates = [
      "threadId",
      "turnId",
      "callId",
      "registrationId",
      "ownerId",
      "schemaDigest",
    ];
    if (!pageCoordinates(params)) return;
    const candidates = [...this.mcpPageOwners.values()]
      .filter(livePageOwner)
      .filter(
        (lease) =>
          lease.projectId === event.projectId &&
          lease.client === event.client &&
          lease.project?.client === event.client &&
          lease.client?.ready &&
          connected(lease.socket) &&
          this.clients.has(lease.socket) &&
          lease.threadId === params.threadId &&
          lease.ownerId === params.ownerId &&
          !(lease.revoked && event.method.endsWith("/pending")),
      );
    const owner = candidates.find(
      (lease) => lease.registration?.registrationId === params.registrationId,
    );
    if (owner?.registration) {
      if (owner.registration.tools.some((tool) => tool.schemaDigest === params.schemaDigest))
        this.send(owner.socket, {
          method: "mcpPageToolNotice",
          params: {
            projectId: owner.projectId,
            instanceId: owner.instanceId,
            generation: owner.generation,
            method: event.method,
            params,
          },
        });
      return;
    }
    for (const lease of candidates) {
      if (lease.registration || !lease.pendingNotices) continue;
      if (
        lease.pendingNotices.length < 32 &&
        !lease.pendingNotices.some(
          (notice) =>
            notice.method === event.method &&
            coordinates.every((key) => notice.params[key] === params[key]) &&
            notice.params.claimId === params.claimId,
        )
      )
        lease.pendingNotices.push({
          projectId: event.projectId,
          client: event.client,
          method: event.method,
          params: { ...params },
        });
    }
  }

  /** @param {PageOwner} lease @param {boolean} [confirmed] */
  retireMcpPageOwner(lease, confirmed = false) {
    const key = JSON.stringify([lease.projectId, lease.instanceId]);
    const current = this.mcpPageOwners.get(key);
    if (!current || current.ownerId !== lease.ownerId) return;
    if (!current.socket && confirmed) {
      this.mcpPageOwners.delete(key);
      return;
    }
    current.revoked = true;
    current.pendingNotices = undefined;
    current.retired ||= confirmed;
    current.retireAt ??= lease.retireAt ?? Date.now() + 32_000;
    this.sweepMcpPageOwners();
  }
  sweepMcpPageOwners() {
    clearTimeout(this.mcpPageExpiryTimer);
    this.mcpPageExpiryTimer = undefined;
    let next = Infinity;
    for (const [key, lease] of this.mcpPageOwners) {
      if (lease.retireAt === undefined) continue;
      if (lease.retireAt > Date.now()) {
        next = Math.min(next, lease.retireAt);
        continue;
      }
      if (lease.retired) this.mcpPageOwners.delete(key);
      else
        this.mcpPageOwners.set(key, {
          projectId: lease.projectId,
          threadId: lease.threadId,
          instanceId: lease.instanceId,
          generation: lease.generation,
          ownerId: lease.ownerId,
          revoked: true,
        });
    }
    if (next !== Infinity && !this.closed) {
      this.mcpPageExpiryTimer = setTimeout(
        () => this.sweepMcpPageOwners(),
        Math.max(0, next - Date.now()),
      );
      this.mcpPageExpiryTimer.unref?.();
    }
  }
  /** @param {(lease:LivePageOwner)=>boolean} predicate */
  revokeMcpPageTools(predicate) {
    for (const lease of this.mcpPageOwners.values()) {
      if (!livePageOwner(lease) || !predicate(lease)) continue;
      this.retireMcpPageOwner(lease);
      this.send(lease.socket, {
        method: "mcpPageToolsRevoked",
        params: {
          projectId: lease.projectId,
          instanceId: lease.instanceId,
          generation: lease.generation,
        },
      });
      if (lease.registration && lease.client.ready)
        void lease.client
          .request("areal/mcp/app/tools/revoke", {
            threadId: lease.threadId,
            instanceId: lease.instanceId,
            generation: lease.generation,
            registrationId: lease.registration.registrationId,
            ownerId: lease.ownerId,
          })
          .then((result) => {
            if (record(result) && result.revoked === true) this.retireMcpPageOwner(lease, true);
          })
          .catch(() => {});
    }
  }
  packet() {
    return {
      sequence: ++this.sequence,
      snapshot: this.backend.snapshot(),
      service: {
        ...(this.backend.applicationOwner
          ? { applicationOwner: this.backend.applicationOwner }
          : {}),
        connected: true,
        commandContract: COMMAND_CONTRACT,
        selectedThreadObservation: true,
        clients: [...this.clients].filter((client) => !(mainClient(client) && client.internal))
          .length,
        busy: this.backend.hasWork({ includePausedQueues: false }),
        activeCommands: Math.max(this.inflight, this.backend.activeCommands ?? 0),
        providerUpdating: !!this.backend.providerUpdating,
        starting: this.backend.starting.size,
        pid: process.pid,
        ...(this.lifecycle ? { lifecycle: this.lifecycle.snapshot() } : {}),
        targets: this.lifecycle?.targets() ?? [],
        remote: {
          enabled:
            this.remote?.config?.enabled === true || this.remote?.config?.directEnabled === true,
          connections: this.remote?.channels?.size ?? 0,
        },
        browserCore: Object.fromEntries(
          [...this.backend.projects].map(([id, project]) => [
            id,
            project.service?.serviceId ?? null,
          ]),
        ),
        // Authenticated desktop Main uses actual active Core listeners to deny
        // Browser Session requests to control ports. This is not a UI grant.
        browserControlEndpoints: [...this.backend.projects.values()]
          .map((project) => project.endpoint)
          .filter(Boolean),
      },
    };
  }
  /** @param {ServiceSocket} socket @param {Fields} value */
  send(socket, value) {
    if (mainClient(socket)) {
      if (!socket.closed) socket.onMessage(value);
      return;
    }
    this.enqueue(socket, { kind: "message", value, bytes: 0 });
  }
  /** @param {ServiceSocket} socket @param {PacketEntry['packet']} packet @param {PacketEntry['header']} header @param {boolean} [full] */
  sendPacket(socket, packet, header, full = false) {
    if (mainClient(socket)) {
      if (!socket.closed) socket.onMessage({ method: "state", params: packet });
      return;
    }
    this.enqueue(socket, { kind: "packet", packet, header, full, bytes: 0 });
  }
  /** @param {ServiceSocket} socket @param {OutboundEntry} entry */
  enqueue(socket, entry) {
    if (mainClient(socket)) return;
    if (!connected(socket)) return;
    const outbound = (socket.outbound ??= {
      queue: [],
      bytes: 0,
      active: false,
      state: null,
      closed: false,
    });
    if (outbound.closed) return;
    if (outbound.active) {
      if (entry.kind === "packet" && "method" in entry.header) {
        if (outbound.state) outbound.queue.splice(outbound.queue.indexOf(outbound.state), 1);
        outbound.state = entry;
      } else {
        entry.bytes = Buffer.byteLength(JSON.stringify(outboundMessage(entry)));
        if (outbound.bytes + entry.bytes > 32 * 1024 * 1024) {
          this.stopSending(socket);
          socket.terminate();
          return;
        }
        outbound.bytes += entry.bytes;
      }
      outbound.queue.push(entry);
      return;
    }
    this.sendFrame(socket, entry);
  }
  /** @param {ServiceSocket} socket */
  stopSending(socket) {
    if (mainClient(socket)) return;
    const outbound = socket.outbound;
    if (!outbound) return;
    clearTimeout(outbound.timer);
    outbound.closed = true;
    outbound.queue = [];
    outbound.state = null;
    outbound.bytes = 0;
  }
  /** @param {ServiceSocket} socket @param {OutboundEntry} entry */
  sendFrame(socket, entry) {
    if (mainClient(socket)) return;
    const outbound = socket.outbound;
    if (!outbound || outbound.closed || !connected(socket)) {
      this.stopSending(socket);
      return;
    }
    if (socket.bufferedAmount > 32 * 1024 * 1024) {
      this.stopSending(socket);
      socket.terminate();
      return;
    }
    outbound.active = true;
    const fail = () => {
      this.stopSending(socket);
      socket.terminate();
    };
    outbound.timer = setTimeout(fail, 150000);
    outbound.timer.unref?.();
    try {
      const value = outboundMessage(entry, socket.projection);
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text) > 256 * 1024 * 1024) {
        fail();
        return;
      }
      socket.send(text, (error) => {
        clearTimeout(outbound.timer);
        if (error) {
          fail();
          return;
        }
        if (outbound.closed) return;
        outbound.active = false;
        const next = outbound.queue.shift();
        if (next) {
          outbound.bytes -= next.bytes;
          if (outbound.state === next) outbound.state = null;
          this.sendFrame(socket, next);
        }
      });
    } catch {
      fail();
    }
  }
  /** @param {ServiceSocket} socket @param {Fields} request */
  async historyCommand(socket, request) {
    const views = (socket.historyViews ??= new Map());
    const key = JSON.stringify([request.projectId, request.threadId, request.viewId]);
    let view = views.get(key);
    if (request.operation === "release") {
      views.delete(key);
      return view
        ? this.backend.command("history", { ...view, operation: "release" })
        : { released: true };
    }
    if (request.operation === "acquire") {
      if (!view) {
        view = { ...request, viewId: randomUUID() };
        views.set(key, view);
      }
      try {
        return await this.backend.command("history", { ...view, operation: "acquire" });
      } catch (error) {
        if (views.get(key) === view) views.delete(key);
        throw error;
      } finally {
        if (!connected(socket) || views.get(key) !== view)
          await this.backend.command("history", { ...view, operation: "release" }).catch(() => {});
      }
    }
    if (!view || !connected(socket)) throw new Error("历史视图已关闭，请重新打开聊天。");
    return this.backend.command("history", { ...request, viewId: view.viewId });
  }
  /** @param {ServiceSocket} socket */
  releaseHistoryViews(socket) {
    for (const view of socket.historyViews?.values() ?? [])
      void this.backend.command("history", { ...view, operation: "release" }).catch(() => {});
    socket.historyViews?.clear();
  }
  schedule() {
    void this.power?.refresh().catch(() => {});
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = null;
        this.publish();
      }, 20);
  }
  publish() {
    const state = this.packet();
    for (const socket of this.clients) this.sendPacket(socket, state, { method: "state" });
    this.remote?.publish();
  }
  /** @param {Fields} notice */
  notify(notice) {
    /** @type {Fields} */
    const settings = this.backend.library.value.settings;
    if (settings.taskNotifications === false) return;
    const clients = [...this.clients].filter((s) => s.notifications && connected(s));
    if (notice.kind === "completion") {
      const policy = settings.turnNotifications ?? "unfocused";
      if (policy === "never") return;
      if (
        policy === "unfocused" &&
        clients.some(
          (s) => !s.activity || Date.now() - s.activity.time > 15000 || s.activity.windowFocused,
        )
      )
        return;
    } else if (notice.kind === "approval" && settings.permissionNotifications === false) return;
    else if (notice.kind === "question" && settings.questionNotifications === false) return;
    // Most recently focused GUI owns delivery. Do not broadcast or replay if a
    // recipient disconnects: delivery is best-effort, never an execution receipt.
    clients.sort((a, b) => (b.lastFocused ?? 0) - (a.lastFocused ?? 0));
    const delivery = { ...notice, silent: settings.notificationSound === "silent" };
    if (clients.length) this.send(clients[0], { method: "notification", params: delivery });
    else
      this.backgroundNotifications?.show(
        delivery,
        /** @param {unknown} target */ (target) => this.openNotification(target),
      );
  }
  /** @param {unknown} target */
  openNotification(target) {
    const clients = [...this.clients]
      .filter((s) => s.notifications && connected(s))
      .sort((a, b) => (b.lastFocused ?? 0) - (a.lastFocused ?? 0));
    if (clients.length) {
      this.send(clients[0], { method: "notificationOpen", params: target });
      return;
    }
    // This is a user click, not a new execution request. Pass only navigation
    // identity over the authenticated connection when the GUI attaches.
    this.pendingNotificationTarget = target;
    try {
      this.backgroundNotifications?.launch();
    } catch (error) {
      console.warn(
        this.backend.providers.redact(`通知打开界面失败：${desktopError(error).message}`),
      );
    }
  }
  /** @param {ServiceSocket} socket */
  disconnectClient(socket) {
    if (mainClient(socket)) {
      if (socket.closed) return;
      socket.closed = true;
    }
    const terminals = this.hostTerminals.get(socket);
    this.hostTerminals.delete(socket);
    for (const entry of terminals?.values() ?? []) {
      entry.client.close();
      this.backend.hostCoreClients.delete(entry.key);
    }
    for (const [requestId, pending] of this.encryptionPending ?? [])
      if (pending.socket === socket) {
        clearTimeout(pending.timer);
        this.encryptionPending.delete(requestId);
        pending.reject(new Error("系统安全存储连接已断开"));
      }
    for (const [requestId, pending] of this.terminalPending)
      if (pending.socket === socket) {
        clearTimeout(pending.timer);
        this.terminalPending.delete(requestId);
        pending.reject(new Error("GUI terminal owner disconnected; outcome may be unknown"));
      }
    this.revokeMcpPageTools((lease) => lease.socket === socket);
    this.stopSending(socket);
    this.releaseHistoryViews(socket);
    if (this.computerSocket === socket) {
      this.computerSocket = null;
      this.backend.connections.revokeDesktopToolHost(socket);
    }
    for (const [key, claim] of this.browserClaims)
      if (claim.socket === socket) this.browserClaims.delete(key);
    for (const [id, record] of this.browserDiscoveryPlans)
      if (record.socket === socket) this.browserDiscoveryPlans.delete(id);
    for (const [key, entries] of this.browserEntrypoints)
      for (const entry of entries)
        if (entry.socket === socket) this.forgetBrowserEntrypoint(key, entry);
    for (const [key, attempt] of this.browserClaimAttempts)
      if (attempt.socket === socket) {
        attempt.cancelled = true;
        this.browserClaimAttempts.delete(key);
      }
    for (const [id, pending] of this.browserPending)
      if (pending.socket === socket) {
        this.browserPending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error("Browser host disconnected after dispatch"));
      }
    this.sampleActivity();
    if (this.clients.delete(socket) && !this.clients.size) this.idleSince = Date.now();
    this.sampleActivity();
    this.schedule();
    if (mainClient(socket)) socket.onClose();
  }
  /** @param {(message:Fields)=>void} onMessage @param {()=>void} onClose @param {boolean} [internal] */
  connectMain(onMessage, onClose, internal = false) {
    /** @type {MainClient} */
    const owner = { kind: "main", internal, closed: false, onMessage, onClose };
    return {
      metadata: {
        protocol: PROTOCOL,
        identity: this.identity,
        pid: process.pid,
        applicationOwner: this.backend.applicationOwner,
        desktopGeneration: this.lifecycle?.generation,
        local: /** @type {const} */ (true),
      },
      request: (/** @type {string} */ method, /** @type {Fields} */ params = {}) => {
        if (owner.closed || this.closed)
          return Promise.reject(
            Object.assign(new Error("GUI 连接已关闭"), {
              code: "DISCONNECTED",
              submissionUnknown: false,
            }),
          );
        return this.execute(owner, method, params);
      },
      close: () => this.disconnectClient(owner),
    };
  }
  async startMain() {
    await this.lifecycle?.init();
    await this.lifecycle?.reconcileLoaded();
    this.backend.host.client.requireCapability("remoteGatewayV1");
    await this.initRemote();
    this.startObservers();
  }
  startObservers() {
    if (this.activityTimer) return;
    this.activityTimer = setInterval(() => {
      this.sampleActivity();
      void this.backend.host
        .refreshScheduling()
        .then((changed) => {
          if (changed) this.backend.onChange();
        })
        .catch(() => {});
    }, 5000);
    this.flushTimer = setInterval(() => {
      void this.backend.analytics.flush();
    }, 30000);
  }
  async listen({ initialized = false } = {}) {
    if (!initialized) {
      await this.lifecycle?.init();
      await this.lifecycle?.reconcileLoaded();
    }
    const server = (this.server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      maxPayload: 256 * 1024 * 1024,
      verifyClient: /** @param {{req:import('node:http').IncomingMessage}} info */ ({ req }) => {
        const actual = Buffer.from(req.headers.authorization ?? "");
        const expected = Buffer.from(`Bearer ${this.token}`);
        return (
          !req.headers.origin &&
          actual.length === expected.length &&
          timingSafeEqual(actual, expected)
        );
      },
    }));
    this.server.on("connection", (socket) => {
      socket.on("error", () => {
        this.stopSending(socket);
        socket.terminate();
      });
      socket.on("message", (bytes) => {
        void this.receive(socket, bytes);
      });
      socket.on("close", () => this.disconnectClient(socket));
    });
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Desktop service listener unavailable");
    this.startObservers();
    return {
      ...(this.backend.applicationOwner ? { applicationOwner: this.backend.applicationOwner } : {}),
      protocol: PROTOCOL,
      endpoint: `ws://127.0.0.1:${address.port}`,
      token: this.token,
      identity: this.identity,
      ...(this.lifecycle ? { desktopGeneration: this.lifecycle.generation } : {}),
      pid: process.pid,
    };
  }
  sampleActivity() {
    const now = Date.now();
    const active = [...this.clients].some(
      (s) => s.activity && now - s.activity.time <= 15000 && s.activity.focused,
    );
    // Count the union of active GUI intervals, never one duration per client.
    this.backend.analytics.sample({ time: now, focused: active });
  }
  async stop({ cancel = false } = {}) {
    if (!this.lifecycle)
      throw Object.assign(new Error("后台未声明持久生命周期能力"), {
        code: "LIFECYCLE_UNSUPPORTED",
      });
    return this.lifecycle.request({
      requestId: randomUUID(),
      kind: "stopDesktop",
      mode: cancel ? "cancel" : "ifIdle",
      expectedDesktopGeneration: this.lifecycle.generation,
      expectedTargets: this.lifecycle.targets(),
    });
  }
  /** @param {unknown} receipt */
  requestExit(receipt) {
    if (
      !record(receipt) ||
      this.exitRequested ||
      receipt.desktopExit !== "requested" ||
      receipt.desktopGeneration !== this.lifecycle?.generation
    )
      return;
    this.exitRequested = true;
    setImmediate(() => this.onStop());
  }
  /** @param {RemoteServiceSocket} socket @param {import("ws").RawData} bytes */
  async receive(socket, bytes) {
    /** @type {unknown} */ let message;
    try {
      message = JSON.parse(bytes.toString());
    } catch {
      socket.close(1008);
      return;
    }
    if (!record(message) || !integer(message.id) || typeof message.method !== "string") {
      socket.close(1008);
      return;
    }
    try {
      const result = await this.execute(
        socket,
        message.method,
        record(message.params) ? message.params : {},
      );
      if (message.method === "hello" || message.method === "snapshot")
        this.sendPacket(
          socket,
          /** @type {PacketEntry['packet']} */ (result),
          { id: message.id },
          true,
        );
      else this.send(socket, { id: message.id, result });
    } catch (error) {
      this.send(socket, { id: message.id, error: desktopError(error) });
    }
  }
  /** @param {ServiceSocket} socket @param {string} wireMethod @param {Fields} params */
  async execute(socket, wireMethod, params = {}) {
    /** @type {unknown} */ let response;
    const guiTerminalCommand = wireMethod === "guiTerminalCommand";
    const method = guiTerminalCommand ? "command" : wireMethod;
    try {
      if (method === "hello") {
        if (params?.protocol !== PROTOCOL || params?.identity !== this.identity)
          throw Object.assign(new Error("后台服务版本或启动配置不兼容。请先安全停止旧后台服务。"), {
            code: "SERVICE_INCOMPATIBLE",
          });
        if (!mainClient(socket))
          socket.projection =
            record(params.capabilities) && params.capabilities.projection === 1
              ? (socket.projection ?? new ProjectionEncoder(randomUUID()))
              : null;
        socket.notifications = params.notifications === true;
        if (
          record(params.capabilities) &&
          params.capabilities.computerHost === 1 &&
          (!this.computerSocket ||
            this.computerSocket === socket ||
            !connected(this.computerSocket))
        ) {
          if (this.computerSocket !== socket) {
            if (this.computerSocket)
              this.backend.connections.revokeDesktopToolHost(this.computerSocket);
            this.backend.connections.revokeDesktopToolHost(null);
          }
          this.computerSocket = socket;
        }
        this.clients.add(socket);
        this.idleSince = null;
        const packet = { ...this.packet(), computerHostOwned: this.computerSocket === socket };
        response = packet;
        if (socket.notifications && this.pendingNotificationTarget) {
          this.send(socket, { method: "notificationOpen", params: this.pendingNotificationTarget });
          this.pendingNotificationTarget = null;
        }
        this.schedule();
        return response;
      }
      // Explicit local stop also works after a source upgrade, without attaching
      // an incompatible GUI. Possession of the private token is still mandatory.
      if (method === "stopService") {
        if (params?.protocol !== PROTOCOL) throw new Error("后台服务协议不兼容");
        if (!this.lifecycle)
          throw Object.assign(new Error("后台未声明持久生命周期能力"), {
            code: "LIFECYCLE_UNSUPPORTED",
          });
        if (params.cancel === true && !Array.isArray(params.expectedTargets))
          throw Object.assign(new Error("取消缺少已确认的后台目标"), {
            code: "CONFIRMATION_STALE",
          });
        const result = await this.lifecycle.request({
          requestId: params.requestId ?? randomUUID(),
          kind: params.forUpdate ? "updateDesktop" : "stopDesktop",
          mode: params.cancel === true ? "cancel" : "ifIdle",
          expectedDesktopGeneration: params.expectedDesktopGeneration ?? this.lifecycle.generation,
          expectedTargets: params.expectedTargets ?? this.lifecycle.targets(),
        });
        response = result;
        this.requestExit(result);
        return response;
      }
      if (!this.clients.has(socket)) throw new Error("请先完成后台服务握手");
      if (method === "encryptionResult") {
        const pending =
          typeof params.requestId === "number"
            ? this.encryptionPending?.get(params.requestId)
            : undefined;
        if (!pending || pending.socket !== socket) throw new Error("无效的安全存储回复");
        this.encryptionPending.delete(/** @type {number} */ (params.requestId));
        clearTimeout(pending.timer);
        if (typeof params.result === "string") pending.resolve(params.result);
        else pending.reject(new Error("系统安全存储不可用"));
        return null;
      }
      if (method === "hostReconnect") {
        if (params.protocol !== PROTOCOL || this.computerSocket !== socket)
          throw new Error("Host reconnect requires the current local Main owner");
        const result = await this.reconnectHost();
        response = result;
        this.schedule();
        return response;
      }
      if (["lifecycleRequest", "lifecycleRead", "lifecycleReconcile"].includes(method)) {
        if (!this.lifecycle)
          throw Object.assign(new Error("后台未声明持久生命周期能力"), {
            code: "LIFECYCLE_UNSUPPORTED",
          });
        if (params?.protocol !== PROTOCOL)
          throw Object.assign(new Error("后台服务协议不兼容"), { code: "LIFECYCLE_UNSUPPORTED" });
        const result =
          method === "lifecycleRequest"
            ? await this.lifecycle.request(params)
            : method === "lifecycleRead"
              ? await this.lifecycle.read(params.requestId)
              : await this.lifecycle.reconcile(params.requestId);
        response = result;
        if (method === "lifecycleRequest") this.requestExit(result);
        this.schedule();
        return response;
      }
      if (method === "terminalResult") {
        const pending =
          typeof params.requestId === "number"
            ? this.terminalPending.get(params.requestId)
            : undefined;
        if (!pending || pending.socket !== socket) throw new Error("Invalid GUI terminal response");
        this.terminalPending.delete(/** @type {number} */ (params.requestId));
        clearTimeout(pending.timer);
        if (record(params.error) && typeof params.error.message === "string")
          pending.reject(Object.assign(new Error(params.error.message), params.error));
        else if (Object.hasOwn(params, "result")) pending.resolve(params.result);
        else pending.reject(new Error("GUI terminal response is incomplete"));
        response = null;
        return response;
      }
      if (this.recovering && !["snapshot", "activity"].includes(method))
        throw blocked("正在处理后台资源，请稍后重试");
      if (method === "browserClaim") {
        if (this.computerSocket !== socket) throw new Error("Desktop tool owner is unavailable");
        const {
          coreInstanceId: claimedCoreId,
          projectId,
          threadId,
          pageId,
          browserHostId,
          hostGeneration,
          pageGeneration,
          controlEpoch,
        } = params ?? {};
        if (
          params?.protocol !== "areal.browser.host.v1" ||
          params?.available !== true ||
          JSON.stringify(params?.operations) !==
            JSON.stringify([
              "describe",
              "observe",
              "capture",
              "act",
              "wait",
              "navigate",
              "openDocument",
              "newPage",
              "diagnostics",
              "runBatch",
              "command",
            ])
        )
          throw new Error("浏览器宿主能力不兼容");
        if (
          !text(projectId) ||
          !text(threadId) ||
          !text(pageId) ||
          !text(browserHostId) ||
          !integer(hostGeneration) ||
          !integer(pageGeneration) ||
          !integer(controlEpoch)
        )
          throw new Error("无效浏览页面身份");
        const project = this.projectForThread(projectId, threadId);
        const thread = project?.model.state.threads[threadId];
        if (
          !project ||
          !thread?.dynamicTools?.some((tool) => record(tool) && tool.name === "browser_v1")
        )
          throw new Error("当前聊天未启用浏览器");
        const coreInstanceId = project.service?.serviceId,
          coreGeneration = project.service?.generation;
        if (typeof coreInstanceId !== "string" || typeof coreGeneration !== "string")
          throw new Error("Core 部署身份不可用");
        if (claimedCoreId !== coreInstanceId) throw new Error("浏览页面属于旧 Core 部署");
        const key = browserKey(projectId, threadId);
        const previous = this.browserClaims.get(key);
        if (previous && previous.socket !== socket && connected(previous.socket))
          throw new Error("浏览页面已由其他桌面窗口认领");
        if (this.browserClaimAttempts.has(key)) throw new Error("浏览页面正在认领，请稍后重试");
        const attempt = { socket, pageId, cancelled: false };
        this.browserClaimAttempts.set(key, attempt);
        const coreClient = project.client;
        try {
          if (params.bootstrapRequestId !== undefined && !integer(params.bootstrapRequestId))
            throw new Error("Browser entry authorization expired");
          const bootstrap =
            params.bootstrapRequestId === undefined
              ? null
              : this.browserPending.get(params.bootstrapRequestId);
          if (params.bootstrapRequestId !== undefined) {
            if (
              !bootstrap?.bootstrap ||
              bootstrap.socket !== socket ||
              bootstrap.key !== key ||
              bootstrap.coreInstanceId !== coreInstanceId ||
              bootstrap.coreGeneration !== coreGeneration
            )
              throw new Error("Browser entry authorization expired");
          } else await this.backend.bindBrowserHostForClaim(project, threadId);
          if (
            attempt.cancelled ||
            this.browserClaimAttempts.get(key) !== attempt ||
            this.browserClaims.get(key) !== previous ||
            !this.clients.has(socket) ||
            this.closed ||
            this.projectForThread(projectId, threadId) !== project ||
            !this.backend.currentConnection(project, coreClient) ||
            project.service?.serviceId !== coreInstanceId ||
            project.service?.generation !== coreGeneration ||
            !connected(socket)
          ) {
            throw new Error("认领期间页面、Core 或桌面连接已换代，请重新操作");
          }
          const claim =
            previous &&
            previous.socket === socket &&
            previous.coreInstanceId === coreInstanceId &&
            previous.coreGeneration === coreGeneration &&
            previous.browserHostId === browserHostId &&
            previous.hostGeneration === hostGeneration &&
            previous.hostConnection === bootstrap?.hostConnection
              ? previous
              : {
                  socket,
                  hostConnection: bootstrap?.hostConnection,
                  coreInstanceId,
                  coreGeneration,
                  browserHostId,
                  hostGeneration,
                  pages: new Map(),
                  revokedPages: new Set(),
                };
          claim.revokedPages.delete(pageId);
          claim.pages.set(pageId, { pageId, pageGeneration, controlEpoch });
          this.browserClaims.set(key, claim);
          response = { claimed: true };
          return response;
        } finally {
          if (this.browserClaimAttempts.get(key) === attempt) this.browserClaimAttempts.delete(key);
        }
      }
      if (method === "browserRevoke") {
        const key = browserKey(params?.projectId, params?.threadId);
        for (const [planId, record] of this.browserDiscoveryPlans)
          if (record.key === key && record.socket === socket)
            this.browserDiscoveryPlans.delete(planId);
        for (const entry of this.browserEntrypoints.get(key) ?? [])
          this.forgetBrowserEntrypoint(key, entry);
        for (const pending of this.browserPending.values())
          if (
            (pending.bootstrap || pending.discovery) &&
            pending.key === key &&
            pending.socket === socket
          )
            pending.reject(new Error("Browser entry revoked by human input"));
        const attempt = this.browserClaimAttempts.get(key);
        if (
          attempt?.socket === socket &&
          (typeof params?.pageId !== "string" || attempt.pageId === params.pageId)
        ) {
          attempt.cancelled = true;
          this.browserClaimAttempts.delete(key);
        }
        const claim = this.browserClaims.get(key);
        if (claim?.socket === socket) {
          if (typeof params?.pageId === "string") {
            claim.pages.delete(params.pageId);
            claim.revokedPages.add(params.pageId);
          } else claim.pages.clear();
          if (claim.pages.size === 0) this.browserClaims.delete(key);
        }
        response = { revoked: true };
        return response;
      }
      if (method === "browserResult") {
        if (!integer(params.requestId)) throw new Error("无效浏览器回执");
        const pending = this.browserPending.get(params.requestId);
        if (!pending || pending.socket !== socket) throw new Error("无效浏览器回执");
        this.browserPending.delete(params.requestId);
        clearTimeout(pending.timer);
        if (params?.error) pending.reject(new Error("Browser host failed after dispatch"));
        else pending.resolve(params?.result);
        response = null;
        return response;
      }
      if (method === "remoteControl") {
        if (!this.remote) throw new Error("手机连接未初始化");
        this.inflight++;
        try {
          response = await this.remote.control(params);
        } finally {
          this.inflight--;
          this.schedule();
        }
        return response;
      }
      if (method === "resources") {
        if (params?.operation === "inspect") {
          this.inflight++;
          try {
            response = await inspectResources(this.backend, {
              includeTasks: params.includeTasks === true,
              purpose: params.purpose === "quit" ? "quit" : undefined,
            });
          } finally {
            this.inflight--;
          }
          return response;
        }
        if (
          (params.operation !== "terminate" && params.operation !== "acknowledge") ||
          typeof params.projectId !== "string" ||
          typeof params.threadId !== "string" ||
          typeof params.id !== "string" ||
          typeof params.epoch !== "string" ||
          (params.confirmed !== undefined && typeof params.confirmed !== "boolean")
        )
          throw new Error("无效资源操作");
        if (
          this.inflight ||
          this.backend.hasWork({ includePausedQueues: false }) ||
          this.backend.starting.size ||
          this.backend.providerUpdating
        )
          throw new Error("请先完成任务和其他操作，再处理资源");
        this.inflight++;
        this.recovering = true;
        try {
          response = await recoverResource(this.backend, {
            projectId: params.projectId,
            threadId: params.threadId,
            id: params.id,
            epoch: params.epoch,
            operation: params.operation,
            confirmed: params.confirmed,
          });
        } finally {
          this.inflight--;
          this.recovering = false;
          this.schedule();
        }
        return response;
      }
      if (method === "mcpPageTools") {
        response = await this.mcpPageTools(socket, params);
        return response;
      }
      if (method === "snapshot") {
        const packet = this.packet();
        response = packet;
        return response;
      }
      if (method === "activity") {
        this.sampleActivity();
        const windowFocused = params?.focused === true && params?.suspended !== true;
        if (windowFocused && !socket.activity?.windowFocused) socket.lastFocused = Date.now();
        socket.activity = {
          time: Date.now(),
          windowFocused,
          focused:
            params?.focused === true &&
            params?.suspended !== true &&
            typeof params.idleSeconds === "number" &&
            Number.isFinite(params.idleSeconds) &&
            params.idleSeconds <= 300,
        };
        this.sampleActivity();
        response = null;
        return response;
      }
      if (method !== "addProject" && method !== "command") throw new Error("不支持的后台服务操作");
      const name = typeof params.name === "string" ? params.name : "";
      const request = record(params.request)
        ? method === "command" && name === "media"
          ? decodeMedia(params.request)
          : params.request
        : {};
      if (method === "command") {
        validateCommand(name, name === "media" ? request : params.request);
        if (
          guiTerminalCommand &&
          (name !== "manage" ||
            ![
              "processStart",
              "processSubmission",
              "processes",
              "process",
              "processOutput",
              "processWait",
              "processWrite",
              "processResize",
              "processCloseStdin",
              "processTerminate",
            ].includes(String(request.operation)))
        )
          throw new Error("Unsupported GUI terminal command");
        if (computerSetting(name, request) && this.computerSocket !== socket)
          throw new Error("Computer provider settings belong to the local computer control host");
      } else if (typeof params.path !== "string") throw new Error("无效工作区路径");
      this.inflight++;
      this.schedule();
      try {
        const entryKey =
          method === "command" && ["send", "editMessage", "continue"].includes(name)
            ? browserKey(request.projectId, request.threadId)
            : "";
        const entry = entryKey ? this.beginBrowserEntrypoint(socket, request) : null;
        let result;
        try {
          const terminalClient = guiTerminalCommand
            ? await this.hostTerminalClient(socket, request.projectId)
            : undefined;
          result =
            method === "command" && name === "history"
              ? await this.historyCommand(socket, request)
              : method === "command"
                ? await this.backend.command(name, request, {
                    ...(guiTerminalCommand
                      ? {
                          ...(terminalClient ? { guiTerminalClient: terminalClient } : {}),
                          guiTerminalRequest: (method, params) => {
                            if (!terminalClient) throw new Error("Host terminal unavailable");
                            return terminalClient.request(method, params);
                          },
                        }
                      : {}),
                    onMcpAppOpened: (project, client, request, result) =>
                      this.bindMcpPageOwner(socket, project, client, request, result),
                    onBrowserTurnStarted: (turnId) => entry?.resolve({ turnId }),
                    onBrowserTurnQueued: (queueItemId) => entry?.resolve({ queueItemId }),
                  })
                : await this.backend.addProject(String(params.path));
        } catch (error) {
          if (entry) this.forgetBrowserEntrypoint(entryKey, entry);
          throw error;
        } finally {
          entry?.resolve(null);
        }
        if (
          method === "command" &&
          name === "manage" &&
          request.operation === "mcpAppClose" &&
          record(result) &&
          result.closed === true
        ) {
          const lease = this.mcpPageOwners.get(
            JSON.stringify([request.projectId, request.instanceId]),
          );
          if (
            lease &&
            lease.threadId === request.threadId &&
            lease.generation === request.generation
          )
            this.retireMcpPageOwner(lease, true);
        }
        if (method === "command" && name === "media") result = encodeMedia(result);
        if (
          method === "command" &&
          name === "library" &&
          request.operation === "settings" &&
          request.key === "preventSleep"
        )
          await this.power?.refresh();
        this.publish();
        response = result;
      } finally {
        this.inflight--;
        this.schedule();
      }
    } catch (error) {
      const details = desktopError(error);
      const message =
        details.code === "SIDEBAR_SAVE_FAILED"
          ? "侧栏整理未能保存，原有布局已保留。请检查存储位置和写入权限后重试。"
          : details.message;
      const failure = {
        ...details,
        ...(record(error) && error.lifecycle ? { lifecycle: error.lifecycle } : {}),
        message:
          method === "command" &&
          params?.name === "providers" &&
          record(params.request) &&
          params.request.operation === "revealKey"
            ? "无法显示 API Key，请刷新配置或解锁系统安全存储后重试。"
            : this.backend.providers.redact(message),
      };
      throw Object.assign(new Error(failure.message), failure);
    }
    return response;
  }
  /** @param {ServiceSocket} socket @param {unknown} projectId */
  async hostTerminalClient(socket, projectId) {
    if (
      !connected(socket) ||
      !this.clients.has(socket) ||
      this.closed ||
      typeof projectId !== "string" ||
      !this.backend.hostCall
    )
      throw new Error("GUI terminal owner is unavailable");
    const canonical = this.backend.host.resolve(projectId).projectId;
    let terminals = this.hostTerminals.get(socket);
    if (!terminals) {
      terminals = new Map();
      this.hostTerminals.set(socket, terminals);
    }
    let entry = terminals.get(canonical);
    if (entry?.client.closed) {
      terminals.delete(canonical);
      this.backend.hostCoreClients.delete(entry.key);
      entry = undefined;
    }
    if (!entry) {
      const { HostCoreClient } = require("@areal/workbench-service/host-core-client");
      const client = new HostCoreClient({
        host: this.backend.hostCall,
        sourceId: this.backend.host.sourceId,
        projectId: canonical,
        scope: "terminal",
      });
      const key = `terminal:${randomUUID()}`;
      entry = { client, ready: client.connect(), key };
      terminals.set(canonical, entry);
      this.backend.hostCoreClients.set(key, client);
    }
    try {
      await entry.ready;
    } catch (error) {
      entry.client.close();
      terminals.delete(canonical);
      this.backend.hostCoreClients.delete(entry.key);
      throw error;
    }
    if (
      !connected(socket) ||
      this.hostTerminals.get(socket) !== terminals ||
      terminals.get(canonical) !== entry
    ) {
      entry.client.close();
      throw new Error("GUI terminal owner disconnected during attachment");
    }
    return entry.client;
  }

  async initRemote() {
    this.backend.host.client.requireCapability("remoteGatewayV1");
    await this.remote?.close();
    if (this.closed || this.exitRequested || this.backend.closing)
      throw new Error("Desktop is closing");
    const remote = new NativeRemote(this);
    this.remote = remote;
    try {
      await remote.init();
    } catch (error) {
      await remote.close();
      throw error;
    }
    if (this.closed || this.exitRequested || this.backend.closing) {
      await remote.close();
      throw new Error("Desktop is closing");
    }
    return remote;
  }
  reconnectHost() {
    if (this.hostReconnection) return this.hostReconnection;
    const task = (async () => {
      if (this.closed || this.exitRequested || this.backend.closing)
        throw new Error("Desktop is closing");
      const result = await this.backend.reconnectHost();
      if (this.closed || this.exitRequested || this.backend.closing)
        throw new Error("Desktop is closing");
      if (this.remote?.closed) {
        const remote = await this.initRemote();
        if (remote.closed || !remote.storageAvailable())
          throw new Error(remote.directError || remote.relayError || "Remote recovery failed");
      }
      return result;
    })();
    this.hostReconnection = task;
    void task.then(
      () => {
        this.hostReconnection = undefined;
      },
      () => {
        this.hostReconnection = undefined;
      },
    );
    return task;
  }
  close() {
    this.closed = true;
    for (const pending of this.encryptionPending?.values() ?? []) {
      clearTimeout(pending.timer);
      pending.reject(new Error("系统安全存储连接已关闭"));
    }
    this.encryptionPending?.clear();
    for (const pending of this.terminalPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("GUI terminal service closed; outcome may be unknown"));
    }
    this.terminalPending.clear();
    this.revokeMcpPageTools(() => true);
    clearTimeout(this.mcpPageExpiryTimer);
    this.mcpPageOwners.clear();
    for (const attempt of this.browserClaimAttempts.values()) attempt.cancelled = true;
    this.browserClaimAttempts.clear();
    for (const pending of this.browserPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Browser service closed after dispatch"));
    }
    for (const entries of this.browserEntrypoints.values())
      for (const entry of entries) entry.resolve(null);
    this.browserPending.clear();
    this.browserClaims.clear();
    this.browserEntrypoints.clear();
    for (const connection of this.hostConnections.keys()) this.disconnectHostExecution(connection);
    this.browserDiscoveryPlans.clear();
    this.remote?.close();
    this.power?.close();
    this.backgroundNotifications?.close();
    this.pendingNotificationTarget = null;
    clearTimeout(this.timer ?? undefined);
    clearInterval(this.activityTimer);
    clearInterval(this.flushTimer);
    for (const owner of this.clients) if (mainClient(owner)) this.disconnectClient(owner);
    for (const socket of this.server?.clients ?? []) {
      this.stopSending(socket);
      this.releaseHistoryViews(socket);
      socket.terminate();
    }
    this.server?.close();
  }
  /** @param {string} name @param {Fields} request */
  async executeRemote(name, request) {
    if (computerSetting(name, request))
      throw new Error("Computer provider settings must be changed on the local control host");
    if (name === "providers" && request?.operation === "revealKey")
      throw new Error("API Key 仅可在本机模型设置中查看");
    if (this.closed || this.recovering) throw new Error("后台正在停止或恢复，请稍后重试");
    this.inflight++;
    this.schedule();
    try {
      return await this.backend.command(name, request);
    } finally {
      this.inflight--;
      this.schedule();
    }
  }
  /** Host 私有准备阶段只登记一次性句柄；真正提交仍由 Host journal 放行。
   * @param {Fields} request @param {string} connection */
  async prepareHostExecution(request, connection) {
    if (!connection || this.closed || this.recovering || this.hostExecutions.size >= 128)
      throw new Error("Host execution unavailable");
    const { projectId, coreInstanceId, coreGeneration } = request;
    if (!record(request.call)) throw new Error("Invalid Host execution call");
    const { method } = request.call;
    if (
      typeof projectId !== "string" ||
      typeof method !== "string" ||
      ![
        "workbench/thread/create",
        "areal/thread/start",
        "areal/turn/start",
        "areal/turn/enqueue",
        "turn/steer",
      ].includes(method) ||
      !record(request.call.params)
    )
      throw new Error("Invalid Host execution");
    const params = structuredClone(request.call.params);
    const creating = method === "areal/thread/start" || method === "workbench/thread/create";
    if (method === "workbench/thread/create") {
      params.projectId = projectId;
      desktopContract.readCommandInvocation("create", params);
    }
    const threadId = params.threadId;
    const project = creating
      ? this.backend.projects.get(projectId)
      : typeof threadId === "string"
        ? this.projectForThread(projectId, threadId)
        : undefined;
    const client = project?.client;
    if (!project || !client) throw new Error("Host execution project unavailable");
    const owner = this.hostConnections.get(connection) ?? {};
    this.hostConnections.set(connection, owner);
    const socket = this.computerSocket;
    const current = () =>
      !this.closed &&
      !this.recovering &&
      this.hostConnections.get(connection) === owner &&
      this.computerSocket === socket &&
      this.backend.currentConnection(project, client) &&
      project.service?.serviceId === coreInstanceId &&
      project.service?.generation === coreGeneration &&
      (creating
        ? this.backend.projects.get(projectId) === project
        : typeof threadId === "string" && this.projectForThread(projectId, threadId) === project);
    if (!current()) throw new Error("Host execution owner changed");
    let ready = current;
    if (method === "areal/thread/start") {
      const prepared = await this.backend.prepareThreadInProject(project, {
        options: params.options,
        profile: params.agentProfile,
        parameters: params.parameters,
        ...(params.model ? { model: params.model } : {}),
      });
      Object.assign(params, prepared.params);
      ready = () => current() && prepared.current();
    } else if (!creating && method !== "turn/steer") {
      await this.backend.ensureBrowserTools(project, /** @type {string} */ (threadId));
    }
    if (!ready()) throw new Error("Host execution owner changed");
    const key = browserKey(projectId, threadId);
    const entry =
      !creating && method !== "turn/steer" && connected(socket)
        ? this.beginBrowserEntrypoint(socket, { projectId, threadId }, connection)
        : null;
    const handle = randomUUID();
    const timer = setTimeout(() => this.cancelHostExecution(handle, connection), 30000);
    this.hostExecutions.set(handle, {
      connection,
      method,
      params,
      project,
      client,
      current: ready,
      key,
      entry,
      timer,
    });
    return {
      handle,
      call: { method, params },
      ...(method !== "workbench/thread/create" ? { hostDispatch: true } : {}),
    };
  }

  /** @param {string} handle @param {string} connection */
  cancelHostExecution(handle, connection) {
    const pending = this.hostExecutions.get(handle);
    if (!pending || pending.connection !== connection) return;
    this.hostExecutions.delete(handle);
    clearTimeout(pending.timer);
    if (pending.entry) this.forgetBrowserEntrypoint(pending.key, pending.entry);
  }

  /** @param {string} connection */
  disconnectHostExecution(connection) {
    this.hostConnections.delete(connection);
    for (const [handle, pending] of this.hostExecutions)
      if (pending.connection === connection) this.cancelHostExecution(handle, connection);
    for (const [key, entries] of this.browserEntrypoints)
      for (const entry of entries)
        if (entry.hostConnection === connection) this.forgetBrowserEntrypoint(key, entry);
    for (const [id, plan] of this.browserDiscoveryPlans)
      if (plan.entry?.hostConnection === connection) this.browserDiscoveryPlans.delete(id);
    for (const [key, claim] of this.browserClaims)
      if (claim.hostConnection === connection) this.browserClaims.delete(key);
    for (const pending of this.browserPending.values())
      if (pending.hostConnection === connection)
        pending.reject(new Error("Host execution owner disconnected; outcome unknown"));
  }

  /** Rust 已完成 Core 调用；这里只结算原页面宿主租约，不再发送 Core 请求。
   * @param {{handle:string,result?:unknown,error?:unknown}} outcome @param {string} connection
   */
  completeHostExecution(outcome, connection) {
    const pending = this.hostExecutions.get(outcome.handle);
    if (!pending || pending.connection !== connection) return { completed: false };
    this.hostExecutions.delete(outcome.handle);
    clearTimeout(pending.timer);
    if (pending.entry) {
      const result = outcome.result;
      if (!pending.current() || outcome.error !== undefined)
        this.forgetBrowserEntrypoint(pending.key, pending.entry);
      else if (record(result) && typeof result.queueItemId === "string")
        pending.entry.resolve({ queueItemId: result.queueItemId });
      else if (record(result) && record(result.turn) && typeof result.turn.id === "string")
        pending.entry.resolve({ turnId: result.turn.id });
      else this.forgetBrowserEntrypoint(pending.key, pending.entry);
    }
    return { completed: true };
  }

  /** @param {string} handle @param {string} connection */
  async dispatchHostExecution(handle, connection) {
    const pending = this.hostExecutions.get(handle);
    if (!pending || pending.connection !== connection || !pending.current()) {
      this.cancelHostExecution(handle, connection);
      return {
        error: {
          code: -32602,
          message: "Host execution owner changed",
          data: { outcome: { kind: "noMutation" } },
        },
      };
    }
    // 先消费句柄；Core 结果未知时原句柄也不能重放。
    this.hostExecutions.delete(handle);
    clearTimeout(pending.timer);
    try {
      if (pending.method === "workbench/thread/create") {
        await this.backend.command("create", pending.params);
        return {
          result: this.backend.worktrees.readThreadCreation(pending.project.id, pending.params),
        };
      }
      const result = await pending.client.request(pending.method, pending.params);
      if (pending.entry) {
        if (!pending.current()) this.forgetBrowserEntrypoint(pending.key, pending.entry);
        else if (record(result) && typeof result.queueItemId === "string")
          pending.entry.resolve({ queueItemId: result.queueItemId });
        else if (record(result) && record(result.turn) && typeof result.turn.id === "string")
          pending.entry.resolve({ turnId: result.turn.id });
        else this.forgetBrowserEntrypoint(pending.key, pending.entry);
      }
      return { result };
    } catch (error) {
      if (pending.entry) this.forgetBrowserEntrypoint(pending.key, pending.entry);
      return {
        error:
          record(error) && typeof error.code === "number"
            ? {
                code: error.code,
                message: error instanceof Error ? error.message : "Core execution failed",
                data: error.data,
              }
            : { code: -32603, message: "Core execution outcome unknown" },
      };
    }
  }

  /** @param {ServiceSocket} socket @param {Fields} request @param {string} [hostConnection] */
  beginBrowserEntrypoint(socket, request, hostConnection) {
    const entryKey = browserKey(request.projectId, request.threadId);
    const entryProject =
      typeof request.projectId === "string" && typeof request.threadId === "string"
        ? this.projectForThread(request.projectId, request.threadId)
        : undefined;
    const thread =
      entryProject && typeof request.threadId === "string"
        ? entryProject.model.state.threads[request.threadId]
        : undefined;
    if (entryProject && thread) {
      const entries = this.browserEntrypoints.get(entryKey) ?? new Set();
      const activeTurns = new Set(
        thread.turns?.filter((turn) => turn.status === "inProgress").map((turn) => turn.id) ?? [],
      );
      for (const previous of entries)
        if (previous.accepted?.turnId && !activeTurns.has(previous.accepted.turnId))
          this.forgetBrowserEntrypoint(entryKey, previous);
      // Core 最多受理 128 个排队项，另保留本聊天的活动轮次。
      if (entries.size >= 129) throw new Error("Browser entry capacity reached");
      /** @type {(value:AcceptedEntry)=>void} */ let accept = () => {};
      /** @type {Promise<AcceptedEntry>} */ const ready = new Promise((resolve) => {
        accept = resolve;
      });
      /** @type {BrowserEntry} */
      const owned = {
        socket,
        hostConnection,
        project: entryProject,
        client: entryProject.client,
        ready,
        resolve: (value) => {
          owned.accepted ??= value;
          accept(value);
        },
      };
      entries.add(owned);
      this.browserEntrypoints.set(entryKey, entries);
      return owned;
    }
    return null;
  }

  /** @param {string} key @param {BrowserEntry} entry */
  forgetBrowserEntrypoint(key, entry) {
    entry.resolve(null);
    const entries = this.browserEntrypoints.get(key);
    entries?.delete(entry);
    if (entries?.size === 0) this.browserEntrypoints.delete(key);
  }
  /** @param {ToolRequest} request @param {string} key */
  async browserEntrypoint(request, key) {
    // 每条已受理消息独立持有入口；队列查询只读，
    // 事件顺序或对下一轮次的猜测均不能授权回调。
    /** @type {ReturnType<typeof queueList>|undefined} */ let queue;
    for (const entry of Array.from(this.browserEntrypoints.get(key) ?? [])) {
      const accepted = await entry.ready;
      const current = () =>
        this.browserEntrypoints.get(key)?.has(entry) &&
        connected(entry.socket) &&
        this.projectForThread(request.projectId, request.threadId) === entry.project &&
        this.backend.currentConnection(entry.project, entry.client) &&
        entry.project.service?.serviceId === request.coreInstanceId &&
        entry.project.service?.generation === request.coreGeneration;
      const forget = () => this.forgetBrowserEntrypoint(key, entry);
      if (!accepted || !current()) {
        forget();
        continue;
      }
      let turnId = accepted.turnId;
      if (typeof accepted.queueItemId === "string") {
        try {
          if (!entry.client) {
            forget();
            continue;
          }
          queue ??= await entry.client.request(
            "areal/queue/list",
            { threadId: request.threadId },
            { decode: queueList },
          );
        } catch {
          forget();
          continue;
        }
        if (!current()) {
          forget();
          continue;
        }
        const item = queue.items?.find((item) => item.id === accepted.queueItemId);
        if (!item || !["pending", "running"].includes(item.status)) {
          forget();
          continue;
        }
        if (item.status === "pending") continue;
        turnId = item.turnId ?? undefined;
      }
      if (turnId === request.turnId) return entry;
    }
    return null;
  }
  /** @param {ToolRequest} request @param {string} key @param {ServiceSocket} socket @param {"prepare"|"execute"} phase @param {ToolRequest["browserApproval"]} [browserApproval] @param {string} [hostConnection] @returns {Promise<unknown>} */
  async dispatchBrowserDiscovery(request, key, socket, phase, browserApproval, hostConnection) {
    if (request.signal?.aborted || !connected(socket) || this.browserPending.size >= 8)
      throw new Error("Browser entry unavailable");
    const requestId = ++this.nextBrowserId;
    return new Promise((resolve, reject) => {
      /** @param {(value:unknown)=>void} fn @param {unknown} value */
      const finish = (fn, value) => {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abort);
        this.browserPending.delete(requestId);
        fn(value);
      };
      const abort = () => finish(reject, new Error("Browser entry cancelled"));
      const timer = setTimeout(
        () => finish(reject, new Error("Browser entry outcome unknown")),
        15000,
      );
      this.browserPending.set(requestId, {
        socket,
        key,
        hostConnection,
        bootstrap: phase === "execute",
        discovery: true,
        coreInstanceId: request.coreInstanceId,
        coreGeneration: request.coreGeneration,
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
        timer,
      });
      request.signal?.addEventListener("abort", abort, { once: true });
      this.send(socket, {
        method: "browserRequest",
        params: {
          requestId,
          operation: "describe",
          phase,
          projectId: request.projectId,
          threadId: request.threadId,
          turnId: request.turnId,
          callId: request.callId,
          coreInstanceId: request.coreInstanceId,
          coreGeneration: request.coreGeneration,
          ...(browserApproval ? { browserApproval } : {}),
        },
      });
    });
  }
  /** @param {ToolRequest} request @param {string} key */
  async bootstrapBrowser(request, key) {
    const entry = await this.browserEntrypoint(request, key);
    if (!entry || !this.browserEntrypoints.get(key)?.has(entry)) return;
    this.forgetBrowserEntrypoint(key, entry);
    await this.dispatchBrowserDiscovery(
      request,
      key,
      entry.socket,
      "execute",
      undefined,
      entry.hostConnection,
    );
  }

  /** @param {ToolRequest} request @param {string} key @param {BrowserClaim|undefined} claim */
  async prepareBrowserDiscovery(request, key, claim) {
    for (const [id, record] of this.browserDiscoveryPlans)
      if (record.plan.expiresAt <= Date.now() || !connected(record.socket))
        this.browserDiscoveryPlans.delete(id);
    if (this.browserDiscoveryPlans.size >= 128) return { error: "host_busy", dispatch: "not_sent" };
    const entry = await this.browserEntrypoint(request, key);
    const socket = claim?.socket ?? entry?.socket;
    const current = () =>
      connected(socket) &&
      !request.signal?.aborted &&
      claim === this.browserClaims.get(key) &&
      (!entry || this.browserEntrypoints.get(key)?.has(entry)) &&
      (!claim ||
        (claim.coreInstanceId === request.coreInstanceId &&
          claim.coreGeneration === request.coreGeneration)) &&
      this.projectForThread(request.projectId, request.threadId)?.service?.serviceId ===
        request.coreInstanceId &&
      this.projectForThread(request.projectId, request.threadId)?.service?.generation ===
        request.coreGeneration;
    if (!socket || !current()) return { error: "human_control", dispatch: "not_sent" };
    const result = await this.dispatchBrowserDiscovery(
      request,
      key,
      socket,
      "prepare",
      undefined,
      entry?.hostConnection ?? claim?.hostConnection,
    );
    if (!current()) return { error: "human_control", dispatch: "not_sent" };
    if (!record(result)) throw new Error("Invalid browser discovery response");
    if (result.error) {
      if (typeof result.error !== "string") throw new Error("Invalid browser discovery error");
      return { error: result.error, dispatch: "not_sent" };
    }
    const plan = result.plan;
    if (
      !discoveryPlan(plan) ||
      plan.expiresAt <= Date.now() ||
      plan.expiresAt > Date.now() + 300000 ||
      plan.coreInstanceId !== request.coreInstanceId ||
      plan.coreGeneration !== request.coreGeneration ||
      plan.projectId !== request.projectId ||
      plan.threadId !== request.threadId ||
      plan.turnId !== request.turnId ||
      plan.callId !== request.callId
    )
      throw new Error("Invalid browser discovery plan");
    const pageClaim = plan.pageId === null ? undefined : claim?.pages.get(plan.pageId);
    if (
      plan.alreadyControlled
        ? !claim ||
          !pageClaim ||
          plan.browserHostId !== claim.browserHostId ||
          plan.hostGeneration !== claim.hostGeneration ||
          plan.pageGeneration !== pageClaim.pageGeneration ||
          plan.controlEpoch !== pageClaim.controlEpoch
        : !entry || entry.socket !== socket
    )
      return { error: "human_control", dispatch: "not_sent" };
    this.browserDiscoveryPlans.set(plan.preparedActionId, {
      key,
      plan,
      claim,
      entry,
      socket,
      pages: claim ? [...claim.pages.values()].map((page) => ({ ...page })) : [],
    });
    return plan;
  }

  /** @param {ToolRequest} request @param {string} key @param {BrowserClaim|undefined} claim */
  consumeBrowserDiscovery(request, key, claim) {
    const plan = request.browserApproval?.plan;
    const record = plan && this.browserDiscoveryPlans.get(plan.preparedActionId);
    if (record) this.browserDiscoveryPlans.delete(plan.preparedActionId);
    if (
      !record ||
      record.key !== key ||
      !isDeepStrictEqual(record.plan, plan) ||
      record.plan.expiresAt <= Date.now() ||
      !connected(record.socket) ||
      record.claim !== claim ||
      request.signal?.aborted ||
      this.projectForThread(request.projectId, request.threadId)?.service?.serviceId !==
        request.coreInstanceId ||
      this.projectForThread(request.projectId, request.threadId)?.service?.generation !==
        request.coreGeneration ||
      plan.coreInstanceId !== request.coreInstanceId ||
      plan.coreGeneration !== request.coreGeneration ||
      plan.projectId !== request.projectId ||
      plan.threadId !== request.threadId ||
      plan.turnId !== request.turnId ||
      plan.callId !== request.callId ||
      (record.entry &&
        (!this.browserEntrypoints.get(key)?.has(record.entry) ||
          this.projectForThread(request.projectId, request.threadId) !== record.entry.project ||
          !this.backend.currentConnection(record.entry.project, record.entry.client))) ||
      (claim && !isDeepStrictEqual(record.pages, [...claim.pages.values()]))
    )
      return null;
    return record;
  }

  /** @param {ToolRequest} request @param {Fields} image @param {()=>boolean} current */
  async uploadToolImage(request, image, current) {
    if (
      typeof image.data !== "string" ||
      typeof image.mimeType !== "string" ||
      !["image/png", "image/jpeg"].includes(image.mimeType) ||
      image.data.length > 12 * 1024 * 1024
    )
      throw new Error("Invalid desktop image");
    const bytes = Buffer.from(image.data, "base64");
    if (!bytes.length || bytes.length > 8 * 1024 * 1024 || bytes.toString("base64") !== image.data)
      throw new Error("Invalid desktop image encoding");
    const project = this.projectForThread(request.projectId, request.threadId);
    if (
      !current() ||
      request.signal?.aborted ||
      project?.service?.serviceId !== request.coreInstanceId ||
      project.service.generation !== request.coreGeneration ||
      typeof request.toolHostGeneration !== "string"
    )
      throw new Error("Desktop image owner changed");
    const { HostCoreClient } = require("@areal/workbench-service/host-core-client");
    if (!(project.client instanceof HostCoreClient))
      throw new Error("Host Core transport unavailable");
    const media = await project.client.blob({
      operation: "upload",
      threadId: request.threadId,
      mime: image.mimeType,
      base64: bytes.toString("base64"),
      callId: request.callId,
      hostGeneration: request.toolHostGeneration,
    });
    if (
      !current() ||
      request.signal?.aborted ||
      project !== this.projectForThread(request.projectId, request.threadId) ||
      project.service?.serviceId !== request.coreInstanceId ||
      project.service?.generation !== request.coreGeneration
    )
      throw new Error("Desktop image owner changed");
    return { type: "arealMedia", modality: "image", media };
  }

  /** @param {ToolRequest} request @param {Fields} envelope @param {()=>boolean} current */
  async toolResult(request, envelope, current) {
    const structuredContent = record(envelope.structuredContent)
      ? envelope.structuredContent
      : undefined;
    const dispatch = structuredContent?.dispatch_status ?? envelope.dispatch_status;
    if (dispatch === "possibly_sent" || dispatch === "unknown")
      return {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: "Desktop action outcome is UNKNOWN. Inspect before another action.",
          },
        ],
        structuredContent: { ...structuredContent, code: "outcome_unknown", dispatch: "unknown" },
      };
    const contentItems = [];
    if (!Array.isArray(envelope.content) || envelope.content.length > 32)
      throw new Error("Invalid desktop tool content");
    for (const content of envelope.content) {
      if (record(content) && content.type === "text" && typeof content.text === "string")
        contentItems.push({ type: "inputText", text: content.text });
      else if (record(content) && content.type === "image")
        contentItems.push(await this.uploadToolImage(request, content, current));
      else throw new Error("Unsupported desktop tool content");
    }
    if (!current() || request.signal?.aborted)
      throw new Error("Desktop tool owner changed after dispatch");
    return {
      success: envelope.isError !== true,
      contentItems,
      ...(envelope.structuredContent ? { structuredContent: envelope.structuredContent } : {}),
    };
  }

  /** @param {ToolHostInput} request */
  async cuaRead(request) {
    const { projectId, signal, phase } = request;
    if (typeof projectId !== "string" || typeof phase !== "string")
      throw new Error("Invalid external CUA identity");
    const project = this.backend.projects.get(projectId),
      client = project?.client,
      socket = this.computerSocket;
    const current = () =>
      !!socket &&
      !this.closed &&
      this.computerSocket === socket &&
      this.clients.has(socket) &&
      connected(socket) &&
      (phase === "revokeProject" ||
        (!!project &&
          this.backend.projects.get(projectId) === project &&
          this.backend.currentConnection(project, client) &&
          project?.service?.serviceId === request.coreInstanceId &&
          project?.service?.generation === request.coreGeneration));
    if (!socket || !current()) throw new Error("External CUA desktop host is unavailable");
    /** @type {Fields} */ const settings = this.backend.library.value.settings;
    if (
      ["catalog", "call"].includes(phase) &&
      (settings.computerControlEnabled !== true || settings.computerControlProvider !== "lcu")
    )
      throw new Error("External CUA is not the selected computer provider");
    if (signal?.aborted || this.browserPending.size >= 16)
      throw new Error("External CUA request cancelled or host busy before dispatch");
    const requestId = ++this.nextBrowserId;
    /** @type {unknown} */
    const result = await new Promise((resolve, reject) => {
      /** @type {NodeJS.Timeout|undefined} */ let timer;
      /** @param {(value:unknown)=>void} next @param {unknown} value */
      const finish = (next, value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.browserPending.delete(requestId);
        next(value);
      };
      const cancel = () =>
        this.send(socket, { method: "browserCancel", params: { tool: "external_cua", requestId } });
      const onAbort = () => {
        cancel();
        finish(reject, new Error("External CUA cancelled; outcome is UNKNOWN"));
      };
      if (phase !== "call")
        timer = setTimeout(() => {
          cancel();
          finish(reject, new Error("External CUA host did not finish"));
        }, 130000);
      this.browserPending.set(requestId, {
        socket,
        tool: "external_cua",
        timer,
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      const { signal: _ignoredSignal, ...params } = request;
      this.send(socket, {
        method: "browserRequest",
        params: { ...params, tool: "external_cua", cuaTool: request.tool, requestId },
      });
    });
    if (!current() || signal?.aborted)
      throw new Error("External CUA owner changed; outcome is UNKNOWN");
    if (!record(result) || Buffer.byteLength(JSON.stringify(result)) > 32 * 1024 * 1024)
      throw new Error("Invalid external CUA response");
    if (result.error)
      throw new Error(
        typeof result.error === "string" ? result.error : "Invalid external CUA error",
      );
    return result;
  }

  /** @param {ToolHostInput} raw */
  async computerRead(raw) {
    if (!toolRequest(raw))
      return raw?.phase === "prepare"
        ? { error: "invalid_arguments", dispatch: "not_sent" }
        : browserFailure("invalid_arguments", "Unsupported computer identity");
    const request = raw;
    const { projectId, threadId, turnId, callId, coreInstanceId, coreGeneration, signal, phase } =
      request;
    if (
      ![projectId, threadId, turnId, callId, coreInstanceId].every((value) => value.length > 0) ||
      !validComputerInput(request.arguments)
    )
      return phase === "prepare"
        ? { error: "invalid_arguments", dispatch: "not_sent" }
        : browserFailure("invalid_arguments", "Unsupported computer operation or parameters");
    const project = this.backend.projects.get(projectId),
      client = project?.client,
      socket = this.computerSocket;
    const current = () =>
      !!socket &&
      !this.closed &&
      this.computerSocket === socket &&
      this.clients.has(socket) &&
      connected(socket) &&
      !!project &&
      this.backend.projects.get(projectId) === project &&
      this.backend.currentConnection(project, client) &&
      project?.service?.serviceId === coreInstanceId &&
      project?.service?.generation === coreGeneration;
    /** @type {Fields} */ const settings = this.backend.library.value.settings;
    if (
      request.discardPreparedPlan !== true &&
      (settings.computerControlEnabled !== true || settings.computerControlProvider === "lcu")
    ) {
      const refusal = {
        code: "not_authorized",
        message: "Computer control is disabled",
        action_sent: false,
        dispatch_status: "not_sent",
        dispatch: "not_sent",
      };
      return phase === "prepare"
        ? { ...refusal, error: refusal.code }
        : {
            success: false,
            contentItems: [{ type: "inputText", text: JSON.stringify(refusal) }],
            structuredContent: refusal,
          };
    }
    if (!socket || !current())
      return phase === "prepare"
        ? { error: "computer_unavailable", dispatch: "not_sent" }
        : browserFailure("computer_unavailable", "The local computer control host is unavailable");
    if (signal?.aborted) throw new Error("Computer request cancelled before dispatch");
    if (this.browserPending.size >= 16)
      return phase === "prepare"
        ? { error: "host_busy", dispatch: "not_sent" }
        : browserFailure("host_busy", "Desktop host is busy; no action was sent");
    const requestId = ++this.nextBrowserId;
    /** @type {unknown} */
    const result = await new Promise((resolve, reject) => {
      /** @param {(value:unknown)=>void} next @param {unknown} value */
      const finish = (next, value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.browserPending.delete(requestId);
        next(value);
      };
      const cancel = () =>
        this.send(socket, {
          method: "browserCancel",
          params: { tool: "computer_v1", requestId, projectId, threadId, turnId, callId },
        });
      const onAbort = () => {
        cancel();
        finish(reject, new Error("Computer request cancelled; dispatch may be unknown"));
      };
      const timer = setTimeout(
        () => {
          cancel();
          finish(reject, new Error("Computer host response unknown"));
        },
        phase === "prepare" ? 10000 : 125000,
      );
      this.browserPending.set(requestId, {
        socket,
        tool: "computer_v1",
        timer,
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      const { signal: _ignoredSignal, ...params } = request;
      this.send(socket, {
        method: "browserRequest",
        params: { ...params, tool: "computer_v1", requestId },
      });
    });
    if (!current() || signal?.aborted) throw new Error("Computer owner changed during dispatch");
    if (!record(result) || JSON.stringify(result).length > 32 * 1024 * 1024)
      throw new Error("Invalid computer host response");
    if (phase === "prepare") {
      if (request.discardPreparedPlan === true) return result;
      if (result.error && result.dispatch === "not_sent") return result;
      if (
        result.operation !== request.arguments.operation ||
        result.parameters === undefined ||
        !isDeepStrictEqual(result.parameters, request.arguments.parameters) ||
        result.coreInstanceId !== coreInstanceId ||
        result.coreGeneration !== coreGeneration ||
        result.projectId !== projectId ||
        result.threadId !== threadId ||
        result.turnId !== turnId ||
        result.callId !== callId ||
        result.toolHostGeneration !== request.toolHostGeneration
      )
        throw new Error("Invalid prepared computer identity");
      return result;
    }
    return this.toolResult(request, result, current);
  }

  /** @param {ToolHostInput} raw */
  async browserRead(raw) {
    if (!toolRequest(raw))
      return browserFailure("invalid_arguments", "Unsupported browser identity");
    const request = raw;
    const {
      projectId,
      threadId,
      turnId,
      callId,
      toolHostGeneration,
      coreInstanceId,
      coreGeneration,
      signal,
      arguments: input,
      phase = "execute",
      browserApproval,
    } = request ?? {};
    if (!validToolInput(input))
      return browserFailure("invalid_arguments", "Unsupported browser operation or parameters");
    const action = [
      "act",
      "wait",
      "navigate",
      "newPage",
      "openDocument",
      "runBatch",
      "command",
    ].includes(input.operation);
    const scoped = input.operation !== "describe";
    const key = browserKey(projectId, threadId);
    let claim = this.browserClaims.get(key);
    const origin = await this.browserEntrypoint(request, key);
    if (origin?.hostConnection && claim && !claim.hostConnection) {
      claim = { ...claim, hostConnection: origin.hostConnection };
      this.browserClaims.set(key, claim);
    }
    if (
      claim?.hostConnection &&
      (!this.hostConnections.has(claim.hostConnection) ||
        (origin?.hostConnection && origin.hostConnection !== claim.hostConnection)) &&
      input.operation !== "describe"
    )
      return browserFailure(
        "human_control",
        "Browser session owner changed; request discovery again",
      );
    if (input.operation === "describe" && phase === "prepare")
      return this.prepareBrowserDiscovery(request, key, claim);
    /** @type {Fields|undefined} */ let discoveryResult;
    if (input.operation === "describe" && browserApproval?.plan) {
      const prepared = this.consumeBrowserDiscovery(request, key, claim);
      if (!prepared)
        return browserFailure(
          "plan_stale",
          "Browser entry authorization changed; send a new explicit request",
        );
      if (prepared.entry) this.forgetBrowserEntrypoint(key, prepared.entry);
      const received = await this.dispatchBrowserDiscovery(
        request,
        key,
        prepared.socket,
        "execute",
        browserApproval,
        prepared.entry?.hostConnection ?? claim?.hostConnection,
      );
      if (!record(received)) throw new Error("Invalid browser discovery response");
      discoveryResult = received;
      if (discoveryResult.error) {
        if (typeof discoveryResult.error !== "string")
          throw new Error("Invalid browser discovery error");
        return browserFailure(
          discoveryResult.error,
          "Browser entry changed; send a new explicit request",
        );
      }
      claim = this.browserClaims.get(key);
      const permit = discoveryResult.controlPermit;
      const pageClaim =
        record(permit) && typeof permit.pageId === "string"
          ? claim?.pages.get(permit.pageId)
          : undefined;
      if (
        !record(permit) ||
        discoveryResult.coreInstanceId !== coreInstanceId ||
        discoveryResult.coreGeneration !== coreGeneration ||
        discoveryResult.projectId !== projectId ||
        discoveryResult.threadId !== threadId ||
        discoveryResult.turnId !== turnId ||
        discoveryResult.callId !== callId ||
        claim?.socket !== prepared.socket ||
        permit.browserHostId !== claim?.browserHostId ||
        permit.hostGeneration !== claim?.hostGeneration ||
        !pageClaim ||
        permit.pageGeneration !== pageClaim.pageGeneration ||
        permit.controlEpoch !== pageClaim.controlEpoch
      )
        return browserFailure("plan_stale", "Browser entry changed during authorization");
    } else if (input.operation === "describe" && phase === "execute" && !claim) {
      await this.bootstrapBrowser(request, key);
      claim = this.browserClaims.get(key);
    }
    // 已批准计划在派发前失去授权时，必须重新授权和观察；普通读取仍报告宿主不可用。
    if (!claim || !connected(claim.socket))
      return action && phase === "execute"
        ? browserFailure(
            "plan_stale",
            "Approved page authorization changed; authorize the page and observe again before a new action",
          )
        : browserFailure("host_unavailable", "No authorized live desktop page");
    if (claim.coreInstanceId !== coreInstanceId || claim.coreGeneration !== coreGeneration) {
      this.browserClaims.delete(key);
      return browserFailure(
        "host_unavailable",
        "Core deployment changed; authorize the page again",
      );
    }
    if (
      scoped &&
      phase === "execute" &&
      (!browserApproval?.plan || typeof browserApproval.plan.preparedActionId !== "string")
    )
      return browserFailure("approval_required", "Core approval metadata is required");
    if (input.operation === "describe")
      return browserSuccess({
        protocol: "areal.browser.host.v1",
        browserHostId: claim.browserHostId,
        hostGeneration: claim.hostGeneration,
        available: true,
        operations: [
          "describe",
          "observe",
          "capture",
          "act",
          "wait",
          "navigate",
          "openDocument",
          "newPage",
          "diagnostics",
          "runBatch",
          "command",
        ],
        command: describeCommands(input.parameters.topic),
        ...discoveryGuidance,
        actions: {
          ref: ["click", "fill", "press", "hover", "selectOption", "setChecked"],
          viewport: ["scroll"],
          scroll:
            "{kind:scroll,target:viewport,deltaX,deltaY}; nonzero safe integers in [-4096,4096]",
          selectOption:
            "native single SELECT, exact observed unique enabled option value; semantic input/change events are not trusted physical input",
          setChecked:
            "native checkbox boolean state; already equal is a confirmed no-op without input",
          screenshot: ["clickAt", "drag", "pressAt"],
          screenshotCoordinates:
            "bitmap pixels from the latest viewport capture; capture observationId is snapshotId",
          keyboard: [
            "Enter",
            "Tab",
            "Escape",
            "Backspace",
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
          ],
        },
        waits: {
          timeoutMs: [1, 30000],
          conditions: ["documentReady", "accessibleName", "checked", "enabled"],
          checked:
            "{kind:checked,ref,value:boolean}; original native checkbox, including disabled controls; zero input",
          enabled: "{kind:enabled,ref,value:boolean}; original native form control; zero input",
          documentReady: "{kind:documentReady,state:interactive|complete}",
          accessibleName:
            "{kind:accessibleName,ref,name}; exact current AX name; stale Ref refused",
          withoutCondition: "bounded delay only; not page readiness",
        },
        ...(discoveryResult?.controlPermit ? { controlPermit: discoveryResult.controlPermit } : {}),
        pages: [...claim.pages.keys()],
      });
    const pageClaim = claim.pages.get(input.parameters.pageId);
    if (!pageClaim) return browserFailure("wrong_page", "Page does not belong to this thread");
    const imagePageId =
      input.operation === "command" && "tabId" in input.parameters.command
        ? (input.parameters.command.tabId ?? pageClaim.pageId)
        : pageClaim.pageId;
    const imagePageClaim = claim.pages.get(imagePageId);
    if (this.browserPending.size >= 8)
      return browserFailure("host_busy", "Too many pending browser observations");
    if (signal?.aborted) throw new Error("Browser request was cancelled");
    const requestId = ++this.nextBrowserId;
    /** @param {string} phase */
    const trace = (phase) => {
      if (this.browserTestTrace)
        appendFileSync(
          this.browserTestTrace,
          JSON.stringify({ phase, requestId, threadId, callId }) + "\n",
        );
    };
    /** @type {unknown} */
    const result = await new Promise((resolve, reject) => {
      /** @param {(value:unknown)=>void} kind @param {unknown} value */
      const finish = (kind, value) => {
        trace("finished");
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.browserPending.delete(requestId);
        kind(value);
      };
      const cancelNative = () =>
        this.send(claim.socket, {
          method: "browserCancel",
          params: {
            requestId,
            projectId,
            threadId,
            pageId: pageClaim.pageId,
            hostGeneration: claim.hostGeneration,
          },
        });
      const onAbort = () => {
        cancelNative();
        finish(reject, new Error("Browser request was cancelled"));
      };
      const timeoutMs =
        phase === "prepare"
          ? 10000
          : input.operation === "command"
            ? 125000
            : input.operation === "runBatch"
              ? 32000
              : input.operation === "wait"
                ? Math.min(35000, input.parameters.timeoutMs + 3000)
                : 15000;
      const timer = setTimeout(() => {
        cancelNative();
        finish(reject, new Error("Browser host response unknown"));
      }, timeoutMs);
      this.browserPending.set(requestId, {
        socket: claim.socket,
        hostConnection: claim.hostConnection,
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
        timer,
      });
      trace("pending");
      signal?.addEventListener("abort", onAbort, { once: true });
      this.send(claim.socket, {
        method: "browserRequest",
        params: {
          requestId,
          coreInstanceId,
          coreGeneration,
          projectId,
          threadId,
          turnId,
          callId,
          workspacePath: this.projectForThread(projectId, threadId)?.root,
          pageId: pageClaim.pageId,
          browserHostId: claim.browserHostId,
          hostGeneration: claim.hostGeneration,
          pageGeneration: pageClaim.pageGeneration,
          controlEpoch: pageClaim.controlEpoch,
          operation: input.operation,
          parameters: input.parameters,
          phase,
          ...(scoped && phase === "execute" ? { browserApproval } : {}),
        },
      });
    });
    if (
      !record(result) ||
      result.pageId !== pageClaim.pageId ||
      result.callId !== callId ||
      result.turnId !== turnId ||
      result.threadId !== threadId ||
      result.projectId !== projectId ||
      result.coreInstanceId !== coreInstanceId ||
      result.coreGeneration !== coreGeneration ||
      result.browserHostId !== claim.browserHostId ||
      result.hostGeneration !== claim.hostGeneration ||
      result.pageGeneration !== pageClaim.pageGeneration ||
      result.controlEpoch !== pageClaim.controlEpoch ||
      JSON.stringify(result).length >
        (input.operation === "command"
          ? 16 * 1024 * 1024
          : input.operation === "capture"
            ? 3 * 1024 * 1024
            : 512 * 1024)
    )
      throw new Error("Invalid browser host response");
    if (this.browserClaims.get(key) !== claim || claim.pages.get(pageClaim.pageId) !== pageClaim) {
      // Execute may already have reached native input. Revocation cannot turn
      // its receipt into a factual claim that nothing was sent.
      if (input.operation === "runBatch" && phase === "execute")
        return browserUnconfirmed("runBatch", "action_unconfirmed", result);
      if (action && phase === "execute")
        return browserUnconfirmed(input.operation, "control_changed");
      return browserFailure("human_control", "Browser authorization was revoked");
    }
    const currentProject = this.projectForThread(projectId, threadId);
    if (
      currentProject?.service?.serviceId !== coreInstanceId ||
      currentProject.service.generation !== coreGeneration
    ) {
      if (input.operation === "runBatch" && phase === "execute")
        return browserUnconfirmed("runBatch", "action_unconfirmed", result);
      if (action && phase === "execute")
        return browserUnconfirmed(input.operation, "deployment_changed");
      return browserFailure("host_unavailable", "Core deployment changed during observation");
    }
    if (result.error) {
      if (typeof result.error !== "string") throw new Error("Invalid browser host error");
      if (
        input.operation === "runBatch" &&
        phase === "execute" &&
        result.error === "outcome_unknown"
      )
        return browserUnconfirmed("runBatch", "action_unconfirmed", result);
      if (action && phase === "execute" && result.error === "outcome_unknown")
        return browserUnconfirmed(input.operation, result.reason);
      if (phase === "prepare") return { error: result.error, dispatch: "not_sent" };
      /** @type {Record<string,string>} */
      const hints = {
        human_control: "Human controls this page",
        plan_stale: "Page or target changed; observe again before a new action",
        stale_ref: "Target changed; observe again",
        human_takeover_required: "Use human takeover for this page",
        not_sent: "Target unavailable before input; observe again",
        condition_timeout: "The requested page condition was not observed before timeout",
      };
      const hint = hints[result.error] ?? "Page unavailable";
      if (input.operation === "runBatch")
        return {
          ...browserFailure(result.error, hint),
          structuredContent: {
            code: result.error,
            dispatch: "not_sent",
            receipts: result.receipts ?? [],
            failedStep: result.failedStep,
            remaining: "not_sent",
            remainingSteps: result.remainingSteps,
          },
        };
      return browserFailure(result.error, hint);
    }
    if (phase === "prepare") {
      if (
        !record(result.plan) ||
        result.plan.pageId !== pageClaim.pageId ||
        result.plan.operation !== input.operation
      )
        throw new Error("Invalid browser plan");
      return result.plan;
    }
    if (input.operation === "command") {
      const closedPageIds = result.closedPageIds ?? [],
        revokedPageIds = result.revokedPageIds ?? [];
      if (!strings(closedPageIds) || !strings(revokedPageIds))
        throw new Error("Invalid closed browser page");
      for (const pageId of [...closedPageIds, ...revokedPageIds]) {
        if (typeof pageId !== "string") throw new Error("Invalid closed browser page");
        claim.pages.delete(pageId);
        claim.revokedPages.add(pageId);
      }
      if (Array.isArray(result.controlPermits))
        for (const permit of result.controlPermits) {
          if (
            !record(permit) ||
            permit.browserHostId !== claim.browserHostId ||
            permit.hostGeneration !== claim.hostGeneration ||
            typeof permit.pageId !== "string" ||
            !integer(permit.pageGeneration) ||
            !integer(permit.controlEpoch)
          )
            throw new Error("Invalid command page permit");
          if (!claim.revokedPages.has(permit.pageId))
            claim.pages.set(permit.pageId, {
              pageId: permit.pageId,
              pageGeneration: permit.pageGeneration,
              controlEpoch: permit.controlEpoch,
            });
        }
      const value = result.commandResult;
      if (!record(value) || typeof value.ok !== "boolean")
        throw new Error("Invalid browser command result");
      if (record(value.error) && value.error.sideEffect === "uncertain")
        return {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: "Browser command dispatch is unknown. Inspect before another action.",
            },
          ],
          structuredContent: { code: "outcome_unknown", dispatch: "unknown", result: value },
        };
      const { image, ...metadata } = value;
      if (
        image !== undefined &&
        (!record(image) || typeof image.base64 !== "string" || typeof image.mimeType !== "string")
      )
        throw new Error("Invalid browser command image");
      if (image) metadata.imageSource = imagePageClaim ? { ...imagePageClaim } : null;
      return this.toolResult(
        request,
        {
          isError: !value.ok,
          structuredContent: metadata,
          content: [
            { type: "text", text: JSON.stringify(metadata) },
            ...(image ? [{ type: "image", data: image.base64, mimeType: image.mimeType }] : []),
          ],
        },
        () => {
          const source = claim.pages.get(image ? imagePageId : pageClaim.pageId);
          const project = this.projectForThread(projectId, threadId);
          return (
            this.browserClaims.get(key) === claim &&
            connected(claim.socket) &&
            ((!image &&
              (closedPageIds.includes(pageClaim.pageId) ||
                revokedPageIds.includes(pageClaim.pageId))) ||
              (!claim.revokedPages.has(image ? imagePageId : pageClaim.pageId) &&
                source?.pageGeneration ===
                  (image ? imagePageClaim?.pageGeneration : pageClaim.pageGeneration) &&
                source?.controlEpoch ===
                  (image ? imagePageClaim?.controlEpoch : pageClaim.controlEpoch) &&
                !!source)) &&
            project?.service?.serviceId === coreInstanceId &&
            project.service.generation === coreGeneration
          );
        },
      );
    }
    if (action) {
      if (input.operation === "newPage" && result.createdPage) {
        const child = result.createdPage;
        if (
          !record(child) ||
          typeof child.pageId !== "string" ||
          !integer(child.pageGeneration) ||
          !integer(child.controlEpoch) ||
          claim.pages.has(child.pageId)
        )
          throw new Error("Invalid created browser page");
        if (!claim.revokedPages.has(child.pageId))
          claim.pages.set(child.pageId, {
            pageId: child.pageId,
            pageGeneration: child.pageGeneration,
            controlEpoch: child.controlEpoch,
          });
      }
      return { ...browserSuccess(result), structuredContent: result };
    }
    if (input.operation === "capture") {
      if (
        signal?.aborted ||
        this.browserClaims.get(key) !== claim ||
        claim.pages.get(pageClaim.pageId) !== pageClaim ||
        !connected(claim.socket)
      )
        return browserFailure("human_control", "Browser authorization was revoked during capture");
      if (
        result.mimeType !== "image/png" ||
        typeof result.imageBase64 !== "string" ||
        result.imageBase64.length > 2_800_000 ||
        typeof toolHostGeneration !== "string"
      )
        throw new Error("Invalid browser image");
      const bytes = Buffer.from(result.imageBase64, "base64");
      if (
        !bytes.length ||
        bytes.length > 2 * 1024 * 1024 ||
        bytes.toString("base64") !== result.imageBase64
      )
        throw new Error("Invalid browser image");
      const project = this.projectForThread(projectId, threadId);
      const { HostCoreClient } = require("@areal/workbench-service/host-core-client");
      if (!(project?.client instanceof HostCoreClient))
        throw new Error("Host Core transport unavailable");
      const media = await project.client.blob({
        operation: "upload",
        threadId,
        mime: "image/png",
        base64: bytes.toString("base64"),
        callId,
        hostGeneration: toolHostGeneration,
      });
      if (
        signal?.aborted ||
        this.browserClaims.get(key) !== claim ||
        claim.pages.get(pageClaim.pageId) !== pageClaim ||
        !connected(claim.socket)
      )
        return browserFailure("human_control", "Browser authorization was revoked during capture");
      const current = this.projectForThread(projectId, threadId);
      if (
        current?.service?.serviceId !== coreInstanceId ||
        current.service.generation !== coreGeneration
      )
        return browserFailure("host_unavailable", "Core deployment changed during capture");
      const { imageBase64: _imageBase64, ...metadata } = result;
      return {
        success: true,
        contentItems: [
          { type: "inputText", text: JSON.stringify({ ...metadata, media }) },
          { type: "arealMedia", modality: "image", media },
        ],
      };
    }
    return browserSuccess(result);
  }
}
module.exports = {
  PROTOCOL,
  COMMAND_CONTRACT,
  DesktopService,
  validateCommand,
  encodeMedia,
  decodeMedia,
};

/** @param {PageOwner} lease @returns {lease is LivePageOwner} */
function livePageOwner(lease) {
  return !!lease.socket && !!lease.client && !!lease.project;
}

/** @param {OutboundEntry} entry @param {RemoteServiceSocket['projection']} [projection] */
function outboundMessage(entry, projection) {
  if (entry.kind === "message") return entry.value;
  const key = "method" in entry.header ? "params" : "result";
  const packet = entry.packet;
  return {
    ...entry.header,
    [key]: projection
      ? { ...packet, snapshot: projection.encode(packet.snapshot, entry.full) }
      : packet,
  };
}
