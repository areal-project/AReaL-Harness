// @ts-check
"use strict";
const { createHash, randomUUID } = require("node:crypto");
const { pushRegistration } = require("./remote-config.cjs");
const { readOverview } = require("./remote-work-overview.cjs");
const { record } = require("./remote-core-decoder.cjs");
/** @typedef {InstanceType<typeof import('./remote.cjs').RemoteControl>} Remote */
/** @typedef {import('./remote-session-observer.cjs').RemoteConnection} Connection */
/** @typedef {import('./remote-config.cjs').DeviceGrant} Grant */
/** @typedef {{type:'push',token:string,environment:'production'|'development',collapseId:string,kind:'attention'|'turnCompleted'|'turnFailed',count:number,target:{projectId:string,threadId?:string,attentionRef?:string}}} PushMessage */
const METHODS = ["device.push.register", "device.push.unregister"];
/** @param {string} code */
const failure = (code) => Object.assign(new Error(code), { code });
/** @param {unknown} value @param {string[]} keys @returns {value is Record<string,unknown>} */
const exact = (value, keys) =>
  record(value) && Object.keys(value).every((key) => keys.includes(key));
/** @param {unknown} value @returns {value is string} */
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
/** @param {Remote} remote @param {Connection} connection */
function authorize(remote, connection) {
  const grant = remote.config.deviceGrants?.find(
    (value) => value.devicePeerId === connection.peer && value.status === "active",
  );
  if (!grant || grant.revision !== connection.grantRevision) throw failure("GRANT_CHANGED");
  if (!grant.capabilities.includes("observe")) throw failure("FORBIDDEN");
  if (
    remote.closed ||
    !connection.alive() ||
    connection.gatewayGeneration !== remote.gatewayGeneration
  )
    throw failure("RESYNC_REQUIRED");
  return grant;
}
/** @param {Remote} remote @param {Connection} connection @param {Record<string,unknown>} request @param {(value:unknown)=>void} publish */
async function deviceCommand(remote, connection, request, publish) {
  const read = request.method === "command.read";
  const register = request.method === "device.push.register";
  const params = request.params;
  const commandId = read && record(params) ? params.commandId : request.commandId;
  if (
    !exact(request, ["id", "method", "params", ...(read ? [] : ["commandId"])]) ||
    (!read && !METHODS.includes(String(request.method))) ||
    !uuid(commandId) ||
    (read
      ? !exact(params, ["commandId"])
      : register
        ? !pushRegistration(params)
        : !exact(params, []))
  )
    throw failure("INVALID_PARAMS");
  const id = commandId.toLowerCase();
  const push =
    register && pushRegistration(params)
      ? {
          platform: params.platform,
          token: params.token.toLowerCase(),
          environment: params.environment,
        }
      : undefined;
  const digest = createHash("sha256")
    .update(JSON.stringify({ method: request.method, params: push ?? {} }))
    .digest("hex");
  const task = (remote.writes ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const grant = authorize(remote, connection);
      const original = remote.config.pushCommands?.find(
        (value) => value.devicePeerId === connection.peer && value.commandId === id,
      );
      if (read) {
        publish(
          original
            ? {
                commandId: id,
                method: original.method,
                admissionState: "accepted",
                submissionUnknown: false,
                receipt: { registered: original.registered },
              }
            : { commandId: id, admissionState: "notFound", submissionUnknown: true },
        );
        return;
      }
      if (original) {
        if (original.semanticDigest !== digest) throw failure("COMMAND_CONFLICT");
        publish({ registered: original.registered });
        return;
      }
      if (register && !remote.relayTransport?.pushSupported) throw failure("RESOURCE_UNAVAILABLE");
      const commands = remote.config.pushCommands ?? [];
      if (commands.length >= 4096) throw failure("CAPACITY_EXCEEDED");
      await remote.save({
        ...remote.config,
        deviceGrants: remote.config.deviceGrants?.map((value) =>
          value === grant ? { ...value, push } : value,
        ),
        pushCommands: [
          ...commands,
          {
            devicePeerId: connection.peer,
            commandId: id,
            method: String(request.method),
            semanticDigest: digest,
            registered: register,
          },
        ],
      });
      authorize(remote, connection);
      remote.service.schedule();
      remote.push.start();
      publish({ registered: register });
    });
  remote.writes = task;
  return task;
}
/** @typedef {{client:NonNullable<import('./project-state.cjs').CoreProject['client']>,generation:string|undefined,seen:Set<string>,scan:Set<string>,cursor?:string,initialized:boolean,summariesComplete:boolean,window?:{until:number,id:string,count:number}}} AttentionState */
class RemotePush {
  /** @param {Remote} remote */
  constructor(remote) {
    this.remote = remote;
    /** @type {Map<string,AttentionState>} */ this.projects = new Map();
    /** @type {NodeJS.Timeout|undefined} */ this.timer = undefined;
    this.running = false;
    this.closed = false;
    this.diagnostic = "";
    /** @type {Map<string,{release:()=>void,alive:()=>boolean}>} */ this.turnWatches = new Map();
    /** @type {Set<string>} */ this.commands = new Set();
  }
  start() {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 5000);
    this.timer.unref?.();
  }
  /** @param {string} projectId */
  grants(projectId) {
    return (this.remote.config.deviceGrants ?? []).filter(
      (grant) =>
        grant.status === "active" &&
        grant.push &&
        grant.projectIds.includes(projectId) &&
        grant.capabilities.includes("observe"),
    );
  }
  /** @param {Grant} grant @param {string} projectId @param {string} capability */
  eligible(grant, projectId, capability) {
    const project = this.remote.backend.projects.get(projectId);
    return (
      !this.closed &&
      !this.remote.closed &&
      this.remote.config.deviceGrants?.includes(grant) === true &&
      grant.status === "active" &&
      !!grant.push &&
      grant.projectIds.includes(projectId) &&
      grant.capabilities.includes(capability) &&
      grant.capabilities.includes("observe") &&
      this.remote.backend.saved.some((value) => value.id === projectId) &&
      !!project?.client?.ready &&
      !project.client.closed &&
      !!project.model.state.connected &&
      !project.resourceInitializing &&
      ![...this.remote.sessions.sockets].some(
        (socket) =>
          socket.authenticated &&
          socket.remotePeer === grant.devicePeerId &&
          socket.readyState === 1,
      )
    );
  }
  /** @param {Grant} grant @param {PushMessage} message @param {string} capability */
  send(grant, message, capability) {
    const project = this.remote.backend.projects.get(message.target.projectId);
    const client = project?.client;
    const generation = project?.service?.generation;
    const current = () =>
      this.eligible(grant, message.target.projectId, capability) &&
      grant.push?.token === message.token &&
      this.remote.backend.projects.get(message.target.projectId) === project &&
      project?.client === client &&
      project?.service?.generation === generation;
    if (!current()) return;
    if (!this.remote.relayTransport?.tryPush(message, current))
      this.diagnostic = "push-unavailable";
  }
  async tick() {
    if (this.closed || this.running) return;
    this.running = true;
    try {
      for (const [key, watch] of this.turnWatches) if (!watch.alive()) this.turnWatches.delete(key);
      const active = new Set();
      for (const project of this.remote.backend.projects.values()) {
        const grants = this.grants(project.id);
        if (
          !grants.length ||
          !project.client?.ready ||
          project.client.closed ||
          !project.model.state.connected ||
          project.resourceInitializing
        )
          continue;
        active.add(project.id);
        for (const outcome of Object.values(project.outcomes ?? {}).reverse())
          this.track(project.id, outcome, true);
        let state = this.projects.get(project.id);
        if (
          !state ||
          state.client !== project.client ||
          state.generation !== project.service?.generation
        ) {
          state = {
            client: project.client,
            generation: project.service?.generation,
            seen: new Set(),
            scan: new Set(),
            initialized: false,
            summariesComplete: true,
          };
          this.projects.set(project.id, state);
        }
        const owner = grants.find((grant) => grant.capabilities.includes("answer"));
        if (!owner) continue;
        try {
          for (let pages = 0; pages < 8; pages++) {
            let complete = false;
            await readOverview(
              this.remote,
              owner.devicePeerId,
              owner.revision,
              {
                method: "attention.list",
                context: { projectId: project.id },
                params: {
                  limit: 100,
                  ...(state.cursor ? { cursor: state.cursor } : {}),
                },
              },
              (raw) => {
                if (
                  !record(raw) ||
                  !Array.isArray(raw.data) ||
                  this.closed ||
                  this.projects.get(project.id) !== state
                )
                  return;
                state.summariesComplete &&= raw.summariesComplete === true;
                for (const attention of raw.data) {
                  if (
                    !record(attention) ||
                    !["approval", "syncQuestion", "asyncQuestion"].includes(
                      String(attention.kind),
                    ) ||
                    typeof attention.attentionRef !== "string"
                  )
                    continue;
                  const ref = attention.attentionRef;
                  if (state.scan.size >= 4096 || state.seen.size >= 4096) continue;
                  state.scan.add(ref);
                  if (!state.initialized || state.seen.has(ref)) continue;
                  state.seen.add(ref);
                  const now = Date.now();
                  if (!state.window || state.window.until <= now)
                    state.window = {
                      until: now + 30000,
                      id: randomUUID(),
                      count: 0,
                    };
                  state.window.count++;
                  for (const grant of this.grants(project.id)) {
                    if (!grant.push) continue;
                    this.send(
                      grant,
                      {
                        type: "push",
                        token: grant.push.token,
                        environment: grant.push.environment,
                        collapseId: state.window.id,
                        kind: "attention",
                        count: state.window.count,
                        target: {
                          projectId: project.id,
                          attentionRef: ref,
                          ...(typeof attention.threadId === "string"
                            ? { threadId: attention.threadId }
                            : {}),
                        },
                      },
                      "answer",
                    );
                  }
                }
                complete = raw.complete === true;
                state.cursor = typeof raw.nextCursor === "string" ? raw.nextCursor : undefined;
                if (complete) {
                  for (const ref of state.scan) state.seen.add(ref);
                  state.initialized ||= state.summariesComplete;
                  state.scan.clear();
                  state.summariesComplete = true;
                }
              },
            );
            if (complete) break;
          }
        } catch {
          this.projects.delete(project.id);
        }
      }
      for (const id of this.projects.keys()) if (!active.has(id)) this.projects.delete(id);
    } finally {
      this.running = false;
    }
  }
  /** @param {string} projectId @param {Record<string,unknown>} outcome @param {boolean} [baseline] */
  track(projectId, outcome, baseline = false) {
    if (
      this.closed ||
      outcome.admissionState !== "accepted" ||
      !record(outcome.remote) ||
      outcome.remote.method !== "session.send" ||
      typeof outcome.threadId !== "string" ||
      typeof outcome.remote.commandId !== "string" ||
      typeof outcome.remote.devicePeerId !== "string"
    )
      return;
    const association = outcome.remote;
    const peer = association.devicePeerId;
    const threadId = outcome.threadId;
    const queueItemId =
      record(outcome.receipt) && typeof outcome.receipt.queueItemId === "string"
        ? outcome.receipt.queueItemId
        : undefined;
    if (typeof outcome.turnId !== "string" && !queueItemId) return;
    const key = JSON.stringify([projectId, peer, association.commandId]);
    if (this.commands.has(key)) return;
    const current = () => {
      const grant = this.grants(projectId).find((value) => value.devicePeerId === peer);
      const project = this.remote.backend.projects.get(projectId);
      return (
        !this.closed &&
        !!grant &&
        !!this.remote.config.identity &&
        association.hostId === this.remote.crypto.identityId(this.remote.config.identity) &&
        association.projectId === projectId &&
        this.remote.backend.saved.some((value) => value.id === projectId) &&
        !!project?.client?.ready &&
        !project.client.closed &&
        !!project.model.state.connected &&
        !project.resourceInitializing
      );
    };
    if (!current()) return;
    if (this.commands.size >= 8192) {
      this.diagnostic = "push-watch-capacity";
      return;
    }
    this.commands.add(key);
    let consumed = false;
    /** @type {string|undefined} */ let queuedTurnId;
    const retire = () => {
      consumed = true;
      this.turnWatches.get(key)?.release();
      this.turnWatches.delete(key);
    };
    const finish = (/** @type {string} */ status, /** @type {boolean} */ initial) => {
      if (consumed || !["completed", "failed", "interrupted", "cancelled"].includes(status)) return;
      retire();
      if (initial && baseline) return;
      const grant = this.grants(projectId).find((value) => value.devicePeerId === peer);
      if (!current() || !grant?.push) return;
      this.send(
        grant,
        {
          type: "push",
          token: grant.push.token,
          environment: grant.push.environment,
          collapseId: createHash("sha256").update(key).digest("hex"),
          kind: status === "completed" ? "turnCompleted" : "turnFailed",
          count: 1,
          target: { projectId, threadId },
        },
        "observe",
      );
    };
    const receive = (/** @type {string} */ method, /** @type {unknown} */ raw) => {
      if (!current() || !record(raw)) return;
      const initial = method === "baseline";
      const thread = initial && record(raw.thread) ? raw.thread : undefined;
      if (initial && thread?.id !== threadId) return;
      if (queueItemId) {
        if (
          method === "turn/completed" &&
          record(raw.turn) &&
          raw.turn.id === queuedTurnId &&
          typeof raw.turn.status === "string"
        ) {
          finish(raw.turn.status, false);
          return;
        }
        const desktop = record(thread?.desktop) ? thread.desktop : undefined;
        const queue = initial
          ? desktop?.queue
          : method === "areal/queue/updated"
            ? raw.queue
            : undefined;
        if (!record(queue) || !Array.isArray(queue.items)) return;
        const item = queue.items.find((value) => record(value) && value.id === queueItemId);
        if (record(item) && typeof item.turnId === "string" && typeof item.status === "string") {
          queuedTurnId = item.turnId;
          finish(item.status, initial);
          const turn =
            initial && Array.isArray(thread?.turns)
              ? thread.turns.find((value) => record(value) && value.id === queuedTurnId)
              : undefined;
          if (record(turn) && typeof turn.status === "string") finish(turn.status, initial);
        } else if (
          !item ||
          (record(item) && ["removed", "failed", "cancelled"].includes(String(item.status)))
        ) {
          this.diagnostic = "push-turn-unavailable";
          retire();
        }
        return;
      }
      const turn =
        initial && Array.isArray(thread?.turns)
          ? thread.turns.find((value) => record(value) && value.id === outcome.turnId)
          : method === "turn/completed"
            ? raw.turn
            : undefined;
      if (record(turn) && turn.id === outcome.turnId && typeof turn.status === "string")
        finish(turn.status, initial);
      else if (initial) {
        this.diagnostic = "push-turn-unavailable";
        retire();
      }
    };
    try {
      const watch = this.remote.sessions.observers.watchPush(projectId, threadId, current, receive);
      this.turnWatches.set(key, watch);
    } catch {
      this.diagnostic = "push-watch-unavailable";
    }
  }
  /** @param {string} token */
  unregisterToken(token) {
    const task = (this.remote.writes ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (
          this.closed ||
          !this.remote.config.deviceGrants?.some((grant) => grant.push?.token === token)
        )
          return;
        await this.remote.save({
          ...this.remote.config,
          deviceGrants: this.remote.config.deviceGrants.map((grant) =>
            grant.push?.token === token ? { ...grant, push: undefined } : grant,
          ),
        });
        this.remote.service.schedule();
      });
    this.remote.writes = task;
    void task.catch(() => {
      this.diagnostic = "push-token-removal-failed";
    });
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.projects.clear();
    for (const watch of this.turnWatches.values()) watch.release();
    this.turnWatches.clear();
    this.commands.clear();
  }
}
module.exports = { RemotePush, deviceCommand, METHODS };
