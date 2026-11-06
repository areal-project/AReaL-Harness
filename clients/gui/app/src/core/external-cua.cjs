// @ts-check
"use strict";
const { record } = require("@areal/workbench-service/desktop/core/service-transport-contract.cjs");
const { access } = require("node:fs/promises");
const { constants } = require("node:fs");
const { isAbsolute } = require("node:path");
const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

/** @typedef {import('@modelcontextprotocol/sdk/types.js').Tool} CuaTool */
/** @typedef {import('@modelcontextprotocol/sdk/types.js').ElicitRequest['params']} Elicitation */
/** @typedef {import('@modelcontextprotocol/sdk/types.js').ElicitResult} ElicitationResult */
/** @typedef {{projectId:string,threadId:string,cwd?:string,coreInstanceId?:string,coreGeneration?:string,toolHostGeneration?:string,turnId?:string,callId?:string}} CuaOwner */
/** @typedef {CuaOwner & {turnId:string,callId:string,coreInstanceId:string,toolHostGeneration:string,tool:'js'|'js_reset',arguments:Record<string,unknown>,definition:unknown,clientInstructions:string,signal?:AbortSignal}} CuaCall */
/** @typedef {{identity:string,owner:CuaOwner,generation:string,turns:Set<string>,active:{owner:CuaCall,controller:AbortController}|null,state:string,client:ReturnType<typeof import('../vendor/lcu/client.mjs').createCuaClient>|null,connected?:Promise<CuaSession>,instructions:string,tools:CuaTool[],cleanupFailure?:unknown}} CuaSession */
const upstream = () => import("../vendor/lcu/client.mjs");
/** @param {CuaTool} tool */
const definition = (tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
});
/** @template T @param {Promise<T>} promise @param {number} milliseconds @param {string} message @returns {Promise<T>} */
const bounded = (promise, milliseconds, message) => {
  /** @type {NodeJS.Timeout|undefined} */
  let timer;
  return Promise.race([
    promise,
    new Promise(
      /** @param {(value:never)=>void} _ */ (_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      },
    ),
  ]).finally(() => clearTimeout(timer));
};

class ExternalCua {
  /** @param {{getSelection:()=>{enabled:boolean,provider:string,executable:string},getAvailable:()=>boolean,onElicitation:(params:Elicitation,context:{signal:AbortSignal,owner:CuaCall})=>Promise<ElicitationResult>,onActivity?:(status:ReturnType<ExternalCua['status']>)=>void}} options */
  constructor({ getSelection, getAvailable, onElicitation, onActivity = () => {} }) {
    this.getSelection = getSelection;
    this.getAvailable = getAvailable;
    this.onElicitation = onElicitation;
    this.onActivity = onActivity;
    /** @type {Map<string,CuaSession>} */
    this.sessions = new Map();
    this.generation = randomUUID();
    this.state = "disconnected";
    this.reason = "";
    /** @type {string|null} */
    this.selectionKey = null;
    /** @type {Promise<void>|null} */
    this.transition = null;
    /** @type {string|null} */
    this.failure = null;
    /** @type {Set<string>} */
    this.revokedTurns = new Set();
    /** @type {Map<symbol,CuaCall>} */
    this.admissions = new Map();
  }
  /** @param {string} state @param {string} [reason] */
  publish(state, reason = "") {
    if (state === "quarantined") this.failure = reason;
    this.state = this.failure ? "quarantined" : state;
    this.reason = this.failure ?? reason;
    this.onActivity(this.status());
  }
  status() {
    return {
      provider: "lcu",
      supported: process.platform === "darwin",
      platform: process.platform,
      ready: this.state === "ready" && this.getAvailable(),
      state: this.state,
      reason: this.reason,
      active: [...this.sessions.values()].some((session) => session.turns.size > 0),
      sessions: this.sessions.size,
    };
  }
  /** @param {string} generation @param {string} [selectionKey] */
  assertAdmission(generation, selectionKey) {
    if (
      generation !== this.generation ||
      this.transition ||
      this.failure ||
      !this.getAvailable() ||
      (selectionKey !== undefined && selectionKey !== JSON.stringify(this.getSelection()))
    )
      throw new Error("External CUA admission was revoked before dispatch");
  }
  /** @param {string} generation */
  async selected(generation) {
    if (process.platform !== "darwin") throw new Error("External CUA is supported only on macOS");
    this.assertAdmission(generation);
    const selection = this.getSelection();
    if (!selection.enabled || selection.provider !== "lcu" || !this.getAvailable())
      throw new Error("External CUA is not enabled or its desktop host is unavailable");
    if (this.state === "quarantined")
      throw new Error(this.reason || "External CUA cleanup is unresolved");
    const key = JSON.stringify(selection);
    if (this.selectionKey !== null && this.selectionKey !== key) await this.close();
    if (typeof selection.executable !== "string" || !isAbsolute(selection.executable))
      throw new Error("Choose an absolute path to an installed LCU executable");
    await access(selection.executable, constants.X_OK);
    this.assertAdmission(generation, key);
    this.selectionKey = key;
    return selection;
  }
  /** @param {CuaOwner} owner @param {string} [generation] @returns {Promise<CuaSession>} */
  async session(owner, generation = this.generation) {
    const selection = await this.selected(generation);
    this.assertAdmission(generation, JSON.stringify(selection));
    const key = JSON.stringify([owner.projectId, owner.threadId]);
    let session = this.sessions.get(key);
    const identity = JSON.stringify([
      owner.coreInstanceId,
      owner.coreGeneration,
      owner.toolHostGeneration,
    ]);
    if (session && session.identity !== identity) {
      try {
        await this.retire(session, "core_changed");
      } catch (error) {
        this.publish("quarantined", error instanceof Error ? error.message : String(error));
        throw error;
      }
      this.assertAdmission(generation, JSON.stringify(selection));
      this.sessions.delete(key);
      session = undefined;
    }
    if (session) {
      await session.connected;
      this.assertAdmission(generation, JSON.stringify(selection));
      return session;
    }
    if (this.sessions.size >= 32)
      throw new Error(
        "External CUA session limit reached; stop computer control before opening another chat",
      );
    /** @type {CuaSession} */
    const created = {
      identity,
      owner,
      generation,
      turns: new Set(),
      active: null,
      state: "disconnected",
      client: null,
      instructions: "",
      tools: [],
    };
    this.sessions.set(key, created);
    created.connected = (async () => {
      const env = Object.fromEntries(
        ["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL"].flatMap((name) =>
          process.env[name] ? [[name, process.env[name]]] : [],
        ),
      );
      env.CUA_REPL_ENABLED_SURFACES = "computer";
      const { createCuaClient } = await upstream();
      created.client = createCuaClient({
        command: [selection.executable],
        cwd: owner.cwd,
        env,
        allowedOrigins: [],
        adapter: "areal",
        log: { event() {}, path: undefined },
        appBuild: undefined,
        /** @param {Elicitation} params @param {{signal:AbortSignal}} context */
        onElicitation: async (params, { signal }) => {
          const active = created.active;
          if (!active || !this.current(created) || active.controller.signal.aborted)
            return { action: "cancel" };
          const answer = await this.onElicitation(params, {
            signal: AbortSignal.any([signal, active.controller.signal]),
            owner: active.owner,
          });
          return created.active === active &&
            this.current(created) &&
            !active.controller.signal.aborted
            ? answer
            : { action: "cancel" };
        },
      });
      await created.client.connect();
      /** @type {unknown} */
      const instructions = created.client.instructions;
      if (typeof instructions !== "string") throw new Error("Invalid LCU instructions");
      created.instructions = instructions;
      const { ToolSchema } = await import("@modelcontextprotocol/sdk/types.js");
      /** @type {unknown} */
      const descriptors = created.client.publicTools();
      if (!Array.isArray(descriptors)) throw new Error("Invalid LCU tool catalog");
      created.tools = descriptors.map((tool) => ToolSchema.parse(tool));
      if (!created.instructions || Buffer.byteLength(created.instructions) > 32768)
        throw new Error(
          "Original LCU instructions are empty or exceed the 32768-byte client instruction budget",
        );
      if (generation !== this.generation) throw new Error("External CUA connection was revoked");
      created.state = "ready";
      this.publish("ready");
      return created;
    })().catch(async (error) => {
      await created.client?.close().catch(() => {});
      if (this.sessions.get(key) === created) this.sessions.delete(key);
      this.publish("disconnected", error instanceof Error ? error.message : String(error));
      throw error;
    });
    return created.connected;
  }
  /** @param {CuaSession} session */
  current(session) {
    return (
      !this.failure &&
      session.generation === this.generation &&
      this.selectionKey === JSON.stringify(this.getSelection()) &&
      this.getAvailable() &&
      session.state === "ready"
    );
  }
  /** @param {Record<string,unknown>} raw */
  async catalog(raw) {
    const session = await this.session(readOwner(raw));
    return {
      instructions: session.instructions,
      tools: session.tools.map(definition),
      descriptors: session.tools,
    };
  }
  async check() {
    const owner = { projectId: "dependency-check", threadId: randomUUID(), cwd: process.cwd() };
    const key = JSON.stringify([owner.projectId, owner.threadId]);
    try {
      await this.catalog(owner);
      return this.status();
    } catch (error) {
      this.publish("disconnected", error instanceof Error ? error.message : String(error));
      return this.status();
    } finally {
      const session = this.sessions.get(key);
      if (session) {
        await session.client?.close();
        this.sessions.delete(key);
      }
    }
  }
  /** @param {CuaOwner} owner */
  turnKey(owner) {
    return JSON.stringify([
      owner.projectId,
      owner.coreInstanceId,
      owner.coreGeneration,
      owner.toolHostGeneration,
      owner.threadId,
      owner.turnId,
    ]);
  }
  /** @param {import("@areal/workbench-service/desktop/core/service-transport-contract.cjs").ToolHostInput} raw @returns {Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult>} */
  async call(raw) {
    const request = readCall(raw);
    const generation = this.generation;
    const admission = Symbol();
    this.admissions.set(admission, request);
    try {
      if (this.revokedTurns.has(this.turnKey(request)) || this.revokedTurns.size >= 4096)
        throw new Error(
          "This computer control turn was stopped or the turn record limit was reached",
        );
      const session = await this.session(request, generation);
      this.assertAdmission(generation);
      if (this.revokedTurns.has(this.turnKey(request)))
        throw new Error("This computer control turn was stopped");
      if (!this.current(session) || session.active || !session.client)
        throw new Error("External CUA session is unavailable or busy");
      if (
        !isDeepStrictEqual(
          session.tools.map(definition).find((tool) => tool.name === request.tool),
          request.definition,
        ) ||
        typeof request.clientInstructions !== "string" ||
        !request.clientInstructions.endsWith(session.instructions)
      ) {
        throw new Error(
          "External CUA catalog changed; create a new chat before using computer control",
        );
      }
      const controller = new AbortController();
      const active = { owner: request, controller };
      session.active = active;
      session.turns.add(request.turnId);
      this.onActivity(this.status());
      const cancel = () => controller.abort();
      request.signal?.addEventListener("abort", cancel, { once: true });
      if (request.signal?.aborted) cancel();
      try {
        this.assertAdmission(generation);
        if (controller.signal.aborted)
          throw new Error("External CUA request cancelled before dispatch");
        /** @type {unknown} */
        const result = await session.client.call(request.tool, request.arguments, {
          sessionId: request.threadId,
          threadId: request.threadId,
          turnId: request.turnId,
          toolCallId: request.callId,
          signal: controller.signal,
        });
        if (!this.current(session) || controller.signal.aborted)
          throw new Error("External CUA owner changed after dispatch; outcome is UNKNOWN");
        if (
          !isDeepStrictEqual(session.tools, session.client.publicTools()) ||
          session.instructions !== session.client.instructions
        ) {
          session.state = "quarantined";
          this.publish(
            "quarantined",
            "LCU runtime changed its catalog; create a new chat after stopping computer control",
          );
        }
        const { CallToolResultSchema } = await import("@modelcontextprotocol/sdk/types.js");
        return CallToolResultSchema.parse(result);
      } catch (error) {
        session.state = "quarantined";
        if (session.generation === this.generation)
          this.publish(
            "quarantined",
            `External CUA outcome is UNKNOWN. ${error instanceof Error ? error.message : String(error)}`,
          );
        throw error;
      } finally {
        request.signal?.removeEventListener("abort", cancel);
        if (session.active === active) session.active = null;
      }
    } finally {
      this.admissions.delete(admission);
    }
  }
  /** @param {Record<string,unknown>} raw */
  async endTurn(raw) {
    const owner = readOwner(raw);
    if (typeof owner.turnId !== "string") throw new Error("Invalid external CUA turn");
    const event = typeof raw.event === "string" ? raw.event : undefined;
    const session = this.sessions.get(JSON.stringify([owner.projectId, owner.threadId]));
    if (
      !session?.client ||
      session.identity !==
        JSON.stringify([owner.coreInstanceId, owner.coreGeneration, owner.toolHostGeneration]) ||
      !session.turns.has(owner.turnId)
    )
      return {};
    this.revokedTurns.add(this.turnKey(owner));
    try {
      await bounded(
        session.client.turnEnded({ sessionId: owner.threadId, turnId: owner.turnId, event }),
        125000,
        "LCU turn cleanup is unresolved",
      );
      session.turns.delete(owner.turnId);
      this.onActivity(this.status());
      return {};
    } catch (error) {
      session.state = "quarantined";
      this.publish("quarantined", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  /** @param {CuaSession} session @param {string} reason */
  async retire(session, reason) {
    if (session.cleanupFailure) throw session.cleanupFailure;
    for (const turnId of session.turns)
      this.revokedTurns.add(this.turnKey({ ...session.owner, turnId }));
    session.active?.controller.abort();
    await session.connected?.catch(() => {});
    if (!session.client) return;
    let failure;
    for (const turnId of session.turns) {
      const owner = { sessionId: session.owner.threadId, turnId };
      try {
        if (reason === "user_stop") {
          /** @type {unknown} */
          const status = await session.client.controlStatus(owner);
          if (
            !record(status) ||
            !record(status.computerUse) ||
            !Array.isArray(status.computerUse.activeApplications)
          )
            throw new Error("Invalid LCU control status");
          for (const app of status.computerUse.activeApplications) {
            const identity = record(app)
              ? (app.bundleIdentifier ?? app.applicationId ?? app.id)
              : app;
            if (typeof identity !== "string") throw new Error("Invalid LCU active application");
            await session.client.controlStop({ ...owner, app: identity });
          }
        }
        await bounded(
          session.client.turnEnded({ ...owner, event: "Interrupt" }),
          125000,
          "LCU turn cleanup is unresolved",
        );
        session.turns.delete(turnId);
        this.onActivity(this.status());
      } catch (error) {
        failure ??= error;
      }
    }
    await bounded(session.client.close(), 10000, "LCU transport close is unresolved").catch(
      (error) => {
        failure ??= error;
      },
    );
    if (failure) {
      session.cleanupFailure = failure;
      throw failure;
    }
  }
  async stop(reason = "stopped") {
    if (this.transition) return this.transition;
    for (const owner of this.admissions.values()) this.revokedTurns.add(this.turnKey(owner));
    this.generation = randomUUID();
    this.transition = Promise.resolve()
      .then(async () => {
        const results = await Promise.allSettled(
          [...this.sessions.values()].map((session) => this.retire(session, reason)),
        );
        const failed = results.find((result) => result.status === "rejected");
        if (failed) {
          this.publish(
            "quarantined",
            failed.reason instanceof Error ? failed.reason.message : String(failed.reason),
          );
          throw failed.reason;
        }
        this.sessions.clear();
        this.selectionKey = null;
        this.failure = null;
        this.publish("disconnected");
      })
      .finally(() => {
        this.transition = null;
      });
    this.publish("stopping", reason);
    return this.transition;
  }
  /** @param {Record<string,unknown>} raw */
  async revokeProject(raw) {
    const owner = readOwner(raw, false);
    const sessions = [...this.sessions.entries()].filter(
      ([, session]) =>
        session.owner.projectId === owner.projectId &&
        session.identity ===
          JSON.stringify([owner.coreInstanceId, owner.coreGeneration, owner.toolHostGeneration]),
    );
    for (const [key, session] of sessions) {
      session.state = "stopping";
      try {
        await this.retire(session, "core_disconnected");
        this.sessions.delete(key);
      } catch (error) {
        this.publish("quarantined", error instanceof Error ? error.message : String(error));
      }
    }
  }
  close() {
    return this.stop("closed");
  }
}

/** @param {Record<string,unknown>} value @param {boolean} [thread] @returns {CuaOwner} */
function readOwner(value, thread = true) {
  if (
    typeof value.projectId !== "string" ||
    (thread && typeof value.threadId !== "string") ||
    (value.cwd !== undefined && typeof value.cwd !== "string") ||
    ["coreInstanceId", "coreGeneration", "toolHostGeneration", "turnId", "callId"].some(
      (key) => value[key] !== undefined && typeof value[key] !== "string",
    )
  )
    throw new Error("Invalid external CUA owner");
  return {
    projectId: value.projectId,
    threadId: typeof value.threadId === "string" ? value.threadId : "",
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    ...(typeof value.coreInstanceId === "string" ? { coreInstanceId: value.coreInstanceId } : {}),
    ...(typeof value.coreGeneration === "string" ? { coreGeneration: value.coreGeneration } : {}),
    ...(typeof value.toolHostGeneration === "string"
      ? { toolHostGeneration: value.toolHostGeneration }
      : {}),
    ...(typeof value.turnId === "string" ? { turnId: value.turnId } : {}),
    ...(typeof value.callId === "string" ? { callId: value.callId } : {}),
  };
}
/** @param {import('@areal/workbench-service/desktop/core/service-transport-contract.cjs').ToolHostInput} value @returns {CuaCall} */
function readCall(value) {
  const owner = readOwner(value);
  if (
    (value.tool !== "js" && value.tool !== "js_reset") ||
    !owner.projectId ||
    !owner.threadId ||
    !owner.turnId ||
    !owner.callId ||
    !owner.coreInstanceId ||
    !owner.toolHostGeneration ||
    !record(value.arguments) ||
    typeof value.clientInstructions !== "string"
  )
    throw new Error("Invalid external CUA call owner");
  return {
    ...owner,
    turnId: owner.turnId,
    callId: owner.callId,
    coreInstanceId: owner.coreInstanceId,
    toolHostGeneration: owner.toolHostGeneration,
    tool: value.tool,
    arguments: value.arguments,
    definition: value.definition,
    clientInstructions: value.clientInstructions,
    signal: value.signal,
  };
}

/** @param {import('electron').App} app @param {()=>boolean} getAvailable @param {()=>import('electron').BrowserWindow|undefined} getWindow @param {(options:import('electron').MessageBoxOptions)=>Promise<import('electron').MessageBoxReturnValue>} showMessageBox */
function nativeAppElicitation(app, getAvailable, getWindow, showMessageBox) {
  /** @param {Elicitation} params @param {{signal:AbortSignal,owner:CuaCall}} context @returns {Promise<ElicitationResult>} */
  return async (params, { signal, owner }) => {
    const { nativeAppApprovalOptions, nativeAppApprovalResponse } = await upstream();
    const { declineAgentHostApp, detectHostApps, appBundleOf, plistBundleId } =
      await import("../vendor/lcu/host-guard.mjs");
    const bundle = appBundleOf(process.execPath),
      bundleId = bundle && plistBundleId(bundle);
    const refusal = declineAgentHostApp(params, {
      env: {},
      report() {},
      hosts: [...detectHostApps(), ...(bundleId ? [{ bundleId, name: app.getName() }] : [])],
    });
    const { ElicitResultSchema } = await import("@modelcontextprotocol/sdk/types.js");
    if (refusal) return ElicitResultSchema.parse(refusal);
    const window = getWindow();
    const approval = nativeAppApprovalOptions(params);
    if (!approval || signal.aborted || !getAvailable() || !window || window.isDestroyed())
      return { action: "cancel" };
    const choices = [...approval.choices, { value: "cancel", label: "Cancel" }];
    const result = await showMessageBox({
      type: "question",
      title: "External computer control",
      message: approval.message,
      detail: [
        approval.resource,
        typeof params._meta?.warning === "string" ? params._meta.warning : "",
        `Chat ${owner.threadId}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      buttons: choices.map((choice) => choice.label),
      defaultId: choices.length - 1,
      cancelId: choices.length - 1,
      noLink: true,
      signal,
    });
    return signal.aborted
      ? { action: "cancel" }
      : ElicitResultSchema.parse(
          nativeAppApprovalResponse(params, choices[result.response]?.value),
        );
  };
}

module.exports = { ExternalCua, upstream, nativeAppElicitation };
