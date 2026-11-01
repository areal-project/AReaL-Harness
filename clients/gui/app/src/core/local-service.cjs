// @ts-check
"use strict";

const { executeCore } = require("./core-process.cjs");
const { readFile, realpath } = require("node:fs/promises");
const { isAbsolute, resolve, join } = require("node:path");
const WebSocket = require("ws");
const { desktopError } = require("@areal/workbench/desktop-contract");
/** @typedef {import('./project-index.cjs').SavedProject} SavedProject */
/** @typedef {import('@areal/runtime-client/core').CoreClient} CoreClient */
/** @typedef {{protocolVersion:1,state:'ready',serviceId:string,generation:string,configFingerprint:string,workspace:string,dataDir:string,endpoint:string,authFile:string,owner?:unknown,[key:string]:unknown}} ServiceDescriptor */
/** @typedef {SavedProject & {service?:ServiceReference|null,endpoint?:string|null,reconnectTimer?:NodeJS.Timeout|null,client?:CoreClient|null,model:{connection:(connected:boolean,error?:string|null)=>void},taskNotificationMonitor?:{stop:()=>void}}} ServiceProject */
/** @typedef {{binary:string,home:string,applicationOwner?:import('./application-owner.cjs').ApplicationOwner,hooks:{environment:()=>NodeJS.ProcessEnv},providers:{redact:(value:string)=>string},host?:InstanceType<typeof import('./gui-host-projects.cjs').GuiHostProjects>,hostRegistry?:string,projects:Map<string,ServiceProject>,saved:SavedProject[]}} ServiceHost */
/** @typedef {Pick<ServiceHost,'binary'|'home'|'hooks'|'providers'> & Partial<Pick<ServiceHost,'applicationOwner'|'host'|'hostRegistry'>>} ServiceReader */
/** @typedef {{serviceId:string,generation:string}} ServiceReference */
/** @typedef {ServiceReference & {projectId:string,requestId:string}} StopTarget */
/** @typedef {ServiceReference & {configFingerprint:string,dataDir:string}} RecoveryTarget */
/** @typedef {{service:ServiceReference & {configFingerprint:string,workspace:string,dataDir:string,owner:unknown,state?:unknown},recovery:{version:1,generation:string,eligible:boolean,reason:string},[key:string]:unknown}} RecoveryStatus */
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// 服务管理只走公共 CLI；轮次核查只读原代际的认证 app-server，不持有或终止 Core/Runtime 子进程。
/** @param {ServiceReader} backend @param {string[]} args @param {NodeJS.ProcessEnv} [environment] @returns {Promise<unknown>} */
async function request(backend, args, environment = backend.hooks.environment()) {
  let stdout;
  try {
    const execution = executeCore(backend.binary, ["service", ...args, "--json"], {
      env: environment,
      timeout: ["status", "capabilities", "operation"].includes(args[0]) ? 10_000 : 120_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    ({ stdout } = await execution);
  } catch (error) {
    const details = desktopError(error);
    const stderr =
      error instanceof Error && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr
        : "";
    /** @type {unknown} */
    let failure;
    try {
      failure = JSON.parse(stderr)?.error;
    } catch {
      /* CLI/launcher diagnostics can be plain text. */
    }
    const message =
      record(failure) && typeof failure.message === "string"
        ? failure.message
        : stderr || details.message;
    if (message.includes("service is busy; wait for work to settle or stop with --cancel")) {
      throw Object.assign(
        new Error("Core 仍有活动目标、排队消息或后台任务，请等待完成或先暂停相关任务后重试。"),
        { code: "CORE_BUSY" },
      );
    }
    throw Object.assign(
      new Error(`Core 服务请求失败：${backend.providers.redact(message).slice(0, 2048)}`),
      {
        code:
          record(failure) && typeof failure.code === "string"
            ? failure.code
            : record(error) && error.timedOut
              ? "TIMEOUT"
              : details.code,
      },
    );
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("Core 返回了无效的本地服务描述");
  }
}

/** @param {ServiceReader} backend @param {string} operation @param {string[]} args @param {NodeJS.ProcessEnv} environment @param {{root:string,id?:string}} project @param {string} dataDir */
async function connectService(backend, operation, args, environment, project, dataDir) {
  const descriptor = await request(
    backend,
    [operation, ...args, ...(operation === "ensure" ? ["--no-auto-restart"] : [])],
    environment,
  );
  if (
    operation === "status" &&
    record(descriptor) &&
    typeof descriptor.state === "string" &&
    ["stopped", "unavailable", "stopping"].includes(descriptor.state)
  ) {
    throw Object.assign(new Error("Core 服务已停止或正在停止，请显式重新连接"), {
      code: "CORE_STOPPED",
    });
  }
  return readServiceConnection(descriptor, project.root, dataDir, backend.applicationOwner);
}

/** @param {InstanceType<typeof import('./gui-host-projects.cjs').GuiHostProjects>} host @param {string} id @param {unknown} descriptor */
async function authenticateService(host, id, descriptor) {
  const binding = host.resolve(id);
  return readServiceConnection(descriptor, binding.workspace, binding.dataDir, {
    kind: "host",
    hostId: host.client.hostId,
    generation: host.client.generation,
  });
}

/** @param {unknown} descriptor @param {string} workspace @param {string} dataDir @param {unknown} owner */
async function readServiceConnection(descriptor, workspace, dataDir, owner) {
  let endpoint;
  try {
    endpoint = new URL(
      record(descriptor) && typeof descriptor.endpoint === "string" ? descriptor.endpoint : "",
    );
  } catch {
    throw Object.assign(new Error("Core 返回了无效的服务地址"), { code: "CORE_INCOMPATIBLE" });
  }
  if (
    !serviceDescriptor(descriptor) ||
    descriptor.workspace !== (await realpath(workspace)) ||
    descriptor.dataDir !== (await realpath(dataDir)) ||
    endpoint.protocol !== "ws:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username ||
    endpoint.password ||
    !isAbsolute(descriptor.authFile)
  ) {
    throw Object.assign(new Error("Core 服务描述与当前工作区不匹配"), {
      code: "CORE_INCOMPATIBLE",
    });
  }
  if (owner && !require("node:util").isDeepStrictEqual(descriptor.owner, owner))
    throw Object.assign(new Error("Core 服务所有者与当前连接不匹配"), {
      code: "CORE_OWNER_MISMATCH",
    });
  /** @type {unknown} */
  const auth = JSON.parse(await readFile(resolve(descriptor.authFile), "utf8"));
  const principal =
    record(auth) && Array.isArray(auth.principals)
      ? auth.principals.find(
          /** @param {unknown} item */ (item) => {
            if (!record(item) || !Array.isArray(item.permissions)) return false;
            const permissions = item.permissions;
            return ["observe", "interact", "manage"].every((permission) =>
              permissions.includes(permission),
            );
          },
        )
      : undefined;
  if (!record(principal) || typeof principal.token !== "string" || !principal.token)
    throw new Error("Core 未提供桌面身份");
  return { descriptor, token: principal.token };
}

/** @param {ServiceReference} target */
const targetArguments = (target) => [
  "--instance",
  target.serviceId,
  "--expected-generation",
  target.generation,
];

/** @param {ServiceReader} backend @param {ServiceReference} target */
async function lifecycleCapabilities(backend, target) {
  if (backend.host) {
    backend.host.client.requireCapability("stopOperations");
    return { version: 1, stopOperations: 1 };
  }
  let value;
  try {
    value = await request(backend, ["capabilities", ...targetArguments(target)]);
  } catch (error) {
    throw Object.assign(new Error("原 Core Host 不支持持久生命周期回执，请先安全升级后台。"), {
      code: /generation changed/.test(desktopError(error).message)
        ? "CONFIRMATION_STALE"
        : "LIFECYCLE_UNSUPPORTED",
    });
  }
  if (!record(value) || value.version !== 1 || value.stopOperations !== 1)
    throw Object.assign(new Error("原 Core Host 不支持持久生命周期回执，请先安全升级后台。"), {
      code: "LIFECYCLE_UNSUPPORTED",
    });
  return value;
}

/** @param {ServiceReader} backend @param {StopTarget} target @param {boolean} cancel */
async function requestStop(backend, target, cancel) {
  if (backend.host)
    return hostStopOperation(
      await backend.host.stop(
        target.requestId,
        target.projectId,
        target.generation,
        cancel ? "cancel" : "ifIdle",
      ),
      target,
      backend.host.resolve(target.projectId).projectId,
    );
  return request(backend, [
    "stop",
    ...targetArguments(target),
    "--request-id",
    target.requestId,
    ...(cancel ? ["--cancel"] : []),
  ]);
}

/** @param {ServiceReader} backend @param {StopTarget} target */
async function readStop(backend, target) {
  if (backend.host)
    return hostStopOperation(
      await backend.host.operation(target.requestId),
      target,
      backend.host.resolve(target.projectId).projectId,
    );
  if (backend.hostRegistry) {
    const { stdout } = await executeCore(
      backend.binary,
      ["host", "operation", target.requestId, "--json"],
      {
        env: { ...backend.hooks.environment(), AREAL_HARNESS_SERVICE_HOME: backend.hostRegistry },
        timeout: 10000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    return hostStopOperation(JSON.parse(stdout).operation, target);
  }
  const result = await request(backend, [
    "operation",
    ...targetArguments(target),
    "--request-id",
    target.requestId,
  ]);
  if (!record(result) || !Object.hasOwn(result, "operation"))
    throw new Error("Core 返回了无效的生命周期回执查询");
  return result.operation;
}

/** @param {ServiceHost} backend @param {ServiceReference & {projectId:string}} target */
function detachStoppedProject(backend, target) {
  const project = backend.projects.get(target.projectId);
  if (
    project?.service?.serviceId !== target.serviceId ||
    project.service.generation !== target.generation
  )
    return;
  project.service = null;
  project.endpoint = null;
  clearTimeout(project.reconnectTimer ?? undefined);
  project.reconnectTimer = null;
  project.taskNotificationMonitor?.stop();
  project.client?.close();
  project.client = null;
  project.model.connection(false);
}

/** @param {CoreClient} client @param {string} threadId @param {string} turnId @param {{observe?:()=>Promise<unknown>,assertCurrent?:()=>void}} [options] */
async function readTurnMetadata(
  client,
  threadId,
  turnId,
  { observe, assertCurrent = () => {} } = {},
) {
  const invalid = () =>
    Object.assign(new Error("原轮次历史元数据不完整或身份不匹配"), {
      code: "LIFECYCLE_RECEIPT_INVALID",
    });
  const features = client.capabilities?.features;
  const bounded =
    record(features) && features.boundedObservation === true && features.boundedHistory === true;
  assertCurrent();
  let result;
  if (!bounded) result = await client.request("thread/read", { threadId, includeTurns: true });
  else if (observe) result = await observe();
  else {
    for (const maxBytes of [262144, 1048576]) {
      try {
        result = await client.request(
          "areal/thread/observe",
          { threadId, mode: "bounded", maxBytes },
          { maxResponseBytes: maxBytes },
        );
        break;
      } catch (error) {
        assertCurrent();
        if (maxBytes === 1048576 || desktopError(error).reason !== "HISTORY_BUDGET_TOO_SMALL")
          throw error;
      }
    }
  }
  assertCurrent();
  if (
    !record(result) ||
    !record(result.thread) ||
    result.thread.id !== threadId ||
    !Array.isArray(result.thread.turns)
  )
    throw invalid();
  const found = result.thread.turns.find(
    /** @param {unknown} turn */ (turn) => record(turn) && turn.id === turnId,
  );
  if (record(found)) {
    return { id: turnId, status: found.status };
  }
  if (!bounded) return null;
  const history = result.history;
  if (
    !record(history) ||
    typeof history.snapshotId !== "string" ||
    typeof history.complete !== "boolean"
  )
    throw invalid();
  let cursor = history.nextCursor;
  if (cursor != null && typeof cursor !== "string") throw invalid();
  while (!history.complete && cursor) {
    assertCurrent();
    const page = await client.request(
      "areal/conversation/history",
      { threadId, view: "own", cursor, maxBytes: 262144 },
      { maxResponseBytes: 262144 },
    );
    assertCurrent();
    if (
      !record(page) ||
      page.snapshotId !== history.snapshotId ||
      !Array.isArray(page.data) ||
      page.data.some(
        /** @param {unknown} entry */ (entry) =>
          !record(entry) || entry.sourceThreadId !== threadId,
      ) ||
      typeof page.complete !== "boolean"
    )
      throw invalid();
    const entry = page.data.find(
      /** @param {unknown} entry */ (entry) => record(entry) && entry.sourceTurnId === turnId,
    );
    if (record(entry)) {
      return { id: turnId, status: entry.sourceTurnStatus };
    }
    if (page.complete) return null;
    if (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor === cursor)
      throw invalid();
    cursor = page.nextCursor;
  }
  if (!history.complete) throw invalid();
  return null;
}

/** @param {ServiceReader & {saved:SavedProject[]}} backend @param {ServiceReference & {projectId:string,dataDir?:string}} target @param {string} threadId @param {string} turnId */
async function readOriginalTurn(backend, target, threadId, turnId) {
  const project = backend.saved.find((project) => project.id === target.projectId);
  if (!project)
    throw Object.assign(new Error("原工作区登记不可用，无法核对轮次"), {
      code: "LIFECYCLE_INCOMPLETE",
    });
  const { descriptor, token } = backend.host
    ? await backend.host.observe(target.projectId)
    : await connectService(
        backend,
        "status",
        ["--instance", target.serviceId],
        backend.hooks.environment(),
        project,
        target.dataDir ?? join(backend.home, target.projectId, "state"),
      );
  if (descriptor.serviceId !== target.serviceId || descriptor.generation !== target.generation)
    throw Object.assign(new Error("原 Core 代际已变化，不能用新实例代替核查"), {
      code: "CONFIRMATION_STALE",
    });
  const { CoreClient, MAX_RESPONSE_BYTES } = await import("@areal/runtime-client/core");
  const client = new CoreClient({
    createSocket: () =>
      new WebSocket(descriptor.endpoint, {
        headers: { Authorization: `Bearer ${token}` },
        followRedirects: false,
        maxPayload: MAX_RESPONSE_BYTES,
      }),
  });
  try {
    await client.connect();
    return await readTurnMetadata(client, threadId, turnId);
  } finally {
    client.close();
  }
}

// Status alone normalizes a vanished Host to stopped. Recovery also requires
// the original Host's clean-shutdown marker; PID/socket disappearance is not proof.
/** @param {ServiceReader} backend @param {ServiceReference & {projectId:string,root:string}} target */
async function inspectOriginalService(backend, target) {
  const descriptor = await request(backend, ["status", "--instance", target.serviceId]);
  const dataDir = await realpath(join(backend.home, target.projectId, "state"));
  const workspace = await realpath(target.root);
  /** @param {unknown} value @returns {value is Record<string,unknown>} */
  const matches = (value) =>
    record(value) &&
    value.protocolVersion === 1 &&
    value.serviceId === target.serviceId &&
    value.generation === target.generation &&
    value.dataDir === dataDir &&
    value.workspace === workspace;
  if (!matches(descriptor))
    throw Object.assign(new Error("原 Core 身份或代际已变化，不能用新实例代替核查"), {
      code: "CONFIRMATION_STALE",
    });
  if (descriptor.state === "stopped") {
    const serviceHome = backend.hooks.environment().AREAL_HARNESS_SERVICE_HOME;
    if (!serviceHome) throw new Error("Core service registry home unavailable");
    /** @type {unknown} */
    const stored = JSON.parse(
      await readFile(join(serviceHome, "services", target.serviceId, "service.json"), "utf8"),
    );
    return { descriptor, cleanupConfirmed: matches(stored) && stored.state === "stopped" };
  }
  if (descriptor.state !== "ready") return { descriptor, cleanupConfirmed: false };
  const { token, descriptor: connected } = await connectService(
    backend,
    "status",
    ["--instance", target.serviceId],
    backend.hooks.environment(),
    target,
    dataDir,
  );
  if (!matches(connected))
    throw Object.assign(new Error("原 Core 代际已变化"), { code: "CONFIRMATION_STALE" });
  const { CoreClient } = await import("@areal/runtime-client/core");
  const client = new CoreClient({
    createSocket: () =>
      new WebSocket(connected.endpoint, {
        headers: { Authorization: `Bearer ${token}` },
        followRedirects: false,
        maxPayload: 4 * 1024 * 1024,
      }),
  });
  try {
    await client.connect();
    return {
      descriptor,
      cleanupConfirmed: false,
      status: await client.request("areal/server/status"),
    };
  } finally {
    client.close();
  }
}

/** @param {unknown} value @returns {value is ServiceDescriptor} */
function serviceDescriptor(value) {
  return (
    record(value) &&
    value.protocolVersion === 1 &&
    value.state === "ready" &&
    typeof value.serviceId === "string" &&
    /^[a-f0-9]{24}$/.test(value.serviceId) &&
    typeof value.generation === "string" &&
    typeof value.configFingerprint === "string" &&
    typeof value.workspace === "string" &&
    typeof value.dataDir === "string" &&
    typeof value.endpoint === "string" &&
    typeof value.authFile === "string"
  );
}
module.exports = {
  authenticateService,
  connectService,
  lifecycleCapabilities,
  requestStop,
  readStop,
  detachStoppedProject,
  readOriginalTurn,
  readTurnMetadata,
  inspectOriginalService,
  serviceRequest: request,
};

/** @param {unknown} value @param {StopTarget} target @param {string} [projectId] */
function hostStopOperation(value, target, projectId) {
  if (value === null) return null;
  if (
    !record(value) ||
    value.version !== 1 ||
    value.requestId !== target.requestId ||
    value.serviceId !== target.serviceId ||
    value.serviceGeneration !== target.generation ||
    (projectId !== undefined && value.projectId !== projectId) ||
    !["ifIdle", "cancel"].includes(String(value.strategy))
  )
    throw Object.assign(new Error("Host stop receipt identity mismatch"), {
      code: "LIFECYCLE_RECEIPT_INVALID",
    });
  return { ...value, generation: value.serviceGeneration, cancel: value.strategy === "cancel" };
}
