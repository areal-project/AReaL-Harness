// @ts-check
"use strict";
// Host 持有进程和私有管道；桌面后台复用原模块，原生能力仍由已认证的 Main 提供。
const { createRequire } = require("node:module");
const { isAbsolute, join } = require("node:path");
const { readFile, realpath, stat, writeFile, unlink } = require("node:fs/promises");
const { createInterface } = require("node:readline");
const { MAX_FRAME } = require("./channel.cjs");
const { createPageSession, prepareInput } = require("./pages.cjs");
const pageMethods = ["pages.command", "pages.resource"];
// 本机网页的桌面命令；与 Host 协议的 DesktopCommandParams.command 一致。
const desktopCommands = new Set([
  "addProject",
  "analytics",
  "chatgpt",
  "cloud",
  "cloudSession",
  "configure",
  "connect",
  "continue",
  "dismissRecovery",
  "editMessage",
  "feedback",
  "fork",
  "history",
  "library",
  "list",
  "manage",
  "media",
  "open",
  "prediction",
  "prepareCreator",
  "projectless",
  "providers",
  "queue",
  "queueEdit",
  "reconcile",
  "remoteControl",
  "resources",
  "side",
  "tasks",
  "trajectory",
  "workspace",
  "recovery",
]);
const privateMethods = [
  "lifecycle.dependencies",
  "lifecycle.flush",
  "core.callback",
  "library.dependencies",
  "desktop.command",
  "input.prepare",
  "execution.prepare",
  "execution.dispatch",
  "execution.complete",
  "creation.read",
  "creation.catalog",
];
/** @type {Record<string,string>} */
const domains = {
  "library.command": "library",
  "worktree.read": "workspace",
  "worktree.command": "workspace",
  "tasks.read": "tasks",
  "trajectory.read": "trajectory",
  "trajectory.command": "trajectory",
  "feedback.read": "feedback",
  "feedback.command": "feedback",
  "providers.read": "providers",
  "providers.command": "providers",
  "manage.read": "manage",
  "manage.command": "manage",
};

// 与 Host 显式认可的业务码对照；新增码须同时检查跨层处理和准入语义。
const businessErrorCodes = /** @type {const} */ ([
  "INVALID_PARAMS",
  "ATTACHMENT_UNSUPPORTED",
  "PROVIDER_CREDENTIAL_REQUIRED",
  "FORBIDDEN",
  "GRANT_CHANGED",
  "RESYNC_REQUIRED",
  "REVIEW_INCOMPLETE",
  "PROFILE_NOT_SUPPORTED",
  "TARGET_CHANGED",
  "COMMAND_CONFLICT",
  "CAPABILITY_UNAVAILABLE",
  "RESOURCE_UNAVAILABLE",
  "CORE_INCOMPATIBLE",
  "LIMIT_EXCEEDED",
  "CAPACITY_EXCEEDED",
  "TURN_BUSY",
  "TASK_CONTROL_REQUIRED",
  "SUBMISSION_UNKNOWN",
  "CORE_UNAVAILABLE",
  "RESOURCE_BUSY",
  "PERSISTED_HISTORY_UNAVAILABLE",
  "MIGRATION_PENDING",
  "migrationBlocked",
]);
/** @typedef {(typeof businessErrorCodes)[number]} BusinessErrorCode */
/** @type {ReadonlySet<string>} */
const businessCodes = new Set(businessErrorCodes);
/** @type {Readonly<Partial<Record<number, BusinessErrorCode>>>} */
const coreRejections = { [-32009]: "TARGET_CHANGED", [-32004]: "RESOURCE_UNAVAILABLE" };
/** @param {unknown} value @param {boolean} desktopCommand
 * @returns {{code:BusinessErrorCode | "COMMAND_FAILED",message?:string}} */
function mapBackendError(value, desktopCommand) {
  const error =
    /** @type {Partial<import('../../../clients/gui/packages/runtime-client/core.js').CoreRpcError>} */ (
      value && typeof value === "object" ? value : {}
    );
  if (
    error.submissionUnknown ||
    error.outcome?.kind === "admitted" ||
    error.outcome?.kind === "unconfirmed"
  )
    return { code: "SUBMISSION_UNKNOWN" };
  if (typeof error.code === "string" && businessCodes.has(error.code))
    return { code: /** @type {BusinessErrorCode} */ (error.code) };
  if (error.outcome?.kind === "rejected" || error.outcome?.kind === "noMutation") {
    if (error.code === -32010 && error.reason === "PROFILE_NOT_SUPPORTED")
      return { code: "PROFILE_NOT_SUPPORTED" };
    const mapped = typeof error.code === "number" ? coreRejections[error.code] : undefined;
    if (mapped) return { code: mapped };
  }
  return desktopCommand
    ? { code: "COMMAND_FAILED", message: String(error.message ?? "").slice(0, 512) }
    : { code: "CORE_UNAVAILABLE" };
}

/** @param {{input:import("node:stream").Readable,output:import("node:stream").Writable}} streams */
async function start({ input, output }) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || Buffer.byteLength(first.value) >= MAX_FRAME) throw new Error("INVALID_PARAMS");
  const frame = JSON.parse(first.value);
  if (frame.version !== 1 || frame.method !== "backend.start") throw new Error("INVALID_PARAMS");
  const { appRoot, options, retired } = frame.params;
  const calls = new Map();
  let callSequence = 0;
  /** @param {string} call @param {unknown} params */
  const hostCall = (call, params) =>
    new Promise((resolve, reject) => {
      const id = `backend-${++callSequence}`;
      calls.set(id, { resolve, reject });
      const line = JSON.stringify({ version: 1, id, call, params });
      if (Buffer.byteLength(line) >= MAX_FRAME) {
        calls.delete(id);
        reject(Object.assign(new Error("LIMIT_EXCEEDED"), { code: "LIMIT_EXCEEDED" }));
        return;
      }
      output.write(line + "\n");
    });
  // 初始化也可能反向读 Host；不能等 createMainDesktop 完成后才消费回复。
  /** @param {string} line */
  const reply = (line) => {
    if (Buffer.byteLength(line) >= MAX_FRAME) return;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (frame.version !== 1 || frame.method !== undefined || frame.event !== undefined) return;
    const pending = calls.get(frame.id);
    if (!pending) return;
    calls.delete(frame.id);
    if (frame.error)
      pending.reject(
        Object.assign(new Error(frame.error.message ?? frame.error.code), frame.error),
      );
    else pending.resolve(frame.result);
  };
  lines.on("line", reply);
  lines.once("close", () => {
    for (const pending of calls.values())
      pending.reject(
        Object.assign(new Error("Host channel closed; outcome unknown"), {
          code: "DISCONNECTED",
        }),
      );
    calls.clear();
  });
  const appRequire = createRequire(join(appRoot, "package.json"));
  const { createMainDesktop } = appRequire(
    "@areal/workbench-service/desktop/core/service-main.cjs",
  );
  /** @type {Awaited<ReturnType<typeof import("./desktop/core/service-main.cjs").createMainDesktop>> | undefined} */
  let cleanupDesktop;
  let metadata,
    claimed = false;
  const pages = new Map();
  const retiredPages = new Set();
  /** @param {string} connection */
  const closePages = async (connection) => {
    retiredPages.add(connection);
    const opening = pages.get(connection);
    pages.delete(connection);
    try {
      await (await opening)?.close();
    } finally {
      retiredPages.delete(connection);
    }
  };
  const path = join(options.home, "service.json");
  try {
    if (retired) {
      const previous = JSON.parse(
        await readFile(path, "utf8").catch((error) => {
          if (error.code === "ENOENT") return "null";
          throw error;
        }),
      );
      if (
        previous &&
        previous.pid === retired.pid &&
        previous.identity === retired.identity &&
        previous.desktopGeneration === retired.desktopGeneration
      )
        await unlink(path);
    }
    // 启动前拒绝抢占任何未由本 Host 确认退役的后台。
    await writeFile(path, JSON.stringify({ state: "starting", pid: process.pid }), {
      mode: 0o600,
      flag: "wx",
    });
    claimed = true;
    const encryption = {
      isEncryptionAvailable: () => true,
      /** @param {string} value */
      encryptString: async (value) =>
        Buffer.from(await desktop.adapter.encryptionRequest("encrypt", value), "base64"),
      /** @param {Buffer} value */
      decryptString: (value) =>
        desktop.adapter.encryptionRequest("decrypt", value.toString("base64")),
    };
    /** @type {NonNullable<typeof cleanupDesktop>} */
    const desktop = await createMainDesktop(
      { ...options, applicationOwner: undefined, sourceSingletonHeld: false },
      { onClose: () => lines.close(), hostCall },
    );
    cleanupDesktop = desktop;
    desktop.backend.cloud.encryption = encryption;
    metadata = await desktop.adapter.listen({ initialized: true });
    await writeFile(path, JSON.stringify(metadata), { mode: 0o600 });
    output.write(
      JSON.stringify({
        version: 1,
        event: "ready",
        methods: [...Object.keys(domains), ...pageMethods, ...privateMethods],
        service: {
          pid: metadata.pid,
          identity: metadata.identity,
          desktopGeneration: metadata.desktopGeneration,
        },
      }) + "\n",
    );
    // EOF 是 Host 的关闭指令；领域调用只由已鉴权的 Host 经私有管道进入。
    const pending = new Set();
    for await (const line of { [Symbol.asyncIterator]: () => iterator }) {
      if (Buffer.byteLength(line) >= MAX_FRAME) throw new Error("LIMIT_EXCEEDED");
      const request = JSON.parse(line);
      if (request.version !== 1) throw new Error("INVALID_PARAMS");
      if (request.method === undefined && request.event === undefined) continue;
      if (request.event === "core.event") {
        for (const client of desktop.backend.hostCoreClients.values()) client.event(request);
        continue;
      }
      if (request.event === "worktree.changed") {
        if (request.sourceId !== desktop.backend.host.sourceId) throw new Error("FORBIDDEN");
        await desktop.backend.worktrees.reloadNative();
        desktop.backend.onChange();
        continue;
      }
      if (request.event === "library.changed") {
        await desktop.backend.library.reload();
        desktop.backend.onChange();
        continue;
      }
      if (
        request.event === "execution.complete" &&
        typeof request.connection === "string" &&
        typeof request.handle === "string"
      ) {
        desktop.adapter.completeHostExecution(request, request.connection);
        continue;
      }
      if (request.event === "tasks.event") {
        desktop.backend.ownerTasks.hostEvent(request);
        continue;
      }
      if (
        request.event === "execution.cancel" &&
        typeof request.connection === "string" &&
        typeof request.handle === "string"
      ) {
        desktop.adapter.cancelHostExecution(request.handle, request.connection);
        continue;
      }
      if (request.event === "pages.disconnect" && typeof request.connection === "string") {
        desktop.adapter.disconnectHostExecution(request.connection);
        const closing = closePages(request.connection).catch(() => {});
        pending.add(closing);
        void closing.finally(() => pending.delete(closing));
        continue;
      }
      if (
        !Object.hasOwn(domains, request.method) &&
        !pageMethods.includes(request.method) &&
        !privateMethods.includes(request.method)
      )
        throw new Error("INVALID_PARAMS");
      const domain = domains[request.method];
      const execute = async () => {
        if (request.method === "lifecycle.dependencies")
          return {
            clients: [...desktop.adapter.clients].filter((client) => !("kind" in client && client.kind === "main" && client.internal)).length,
            inflight: Math.max(desktop.adapter.inflight, desktop.backend.activeCommands ?? 0),
            providerUpdating:
              desktop.backend.providerUpdating === true ||
              desktop.backend.resourcesUpdating === true,
            starting: desktop.backend.starting.size,
            lifecycleGeneration: desktop.backend.lifecycleOperations.generation,
          };
        if (request.method === "lifecycle.flush") {
          await desktop.backend.library.writes;
          await Promise.all(desktop.backend.saves.values());
          return { flushed: true };
        }
        if (request.method === "core.callback") {
          const client = [...desktop.backend.hostCoreClients.values()].find((client) =>
            client.owns(request.params.lease),
          );
          if (!client) throw Error("Desktop Core projection unavailable");
          return client.callback(request.params);
        }
        if (request.method === "library.dependencies") {
          const cloudThreads = desktop.backend.cloudConversations.records
            .filter(
              (row) =>
                typeof row.projectId === "string" && typeof row.binding?.threadId === "string",
            )
            .map((row) => ({
              projectId: row.projectId,
              threadId: row.binding.threadId,
            }));
          const pendingProjects = [...desktop.backend.projects.values()]
            .filter((project) => project.pending.length > 0)
            .map((project) => project.id);
          if (
            cloudThreads.length > 65536 ||
            pendingProjects.length > 65536 ||
            [
              ...pendingProjects,
              ...cloudThreads.flatMap((row) => [row.projectId, row.threadId]),
            ].some((id) => typeof id !== "string" || !id || id.length > 512)
          )
            throw Error("Library dependency limit reached");
          return { cloudThreads, pendingProjects };
        }
        if (request.method === "creation.catalog") {
          // Host 比工作台先看到 Core 就绪；连接进行中时等它读完配置档，免得界面拿到空目录。
          await desktop.backend.starting.get(request.params.projectId)?.catch(() => {});
          await desktop.backend.providers.settled();
          const project = desktop.backend.projects.get(request.params.projectId);
          if (!project?.client) throw Error("Creation catalog unavailable");
          const client = project.client;
          const coreModels = await client.request(
            "areal/model/list",
            {},
            {
              decode: require("./desktop/core/provider-contract.cjs").models,
            },
          );
          if (
            desktop.backend.projects.get(request.params.projectId) !== project ||
            project.client !== client
          )
            throw Error("Creation catalog connection changed");
          /** @param {Record<string,unknown>} value @param {string[]} fields */
          const pick = (value, fields) =>
            Object.fromEntries(
              fields.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]),
            );
          const managed = desktop.backend.providers.manages(project);
          const modelFields = [
            "providerId",
            "providerName",
            "modelId",
            "providerRevision",
            "isDefault",
            "credentialState",
            "displayName",
            "parameters",
            "contextWindowTokens",
            "maxOutputTokens",
            "reasoningEffortOptions",
            "capabilities",
            "available",
            "availability",
            "unavailableReason",
          ];
          const models = desktop.backend.providers
            .catalog(coreModels.data, project)
            .slice(0, 200)
            .map((model) => {
              const value = pick(model, modelFields);
              if (value.parameters)
                value.parameters = pick(/** @type {Record<string,unknown>} */ (value.parameters), [
                  "temperature",
                  "maxOutputTokens",
                  "contextWindowTokens",
                  "reasoningEffort",
                  "reasoningSummary",
                  "serviceTier",
                ]);
              if (value.capabilities)
                value.capabilities = pick(
                  /** @type {Record<string,unknown>} */ (value.capabilities),
                  ["tools", "vision", "reasoning", "reasoningEffortOptions"],
                );
              return value;
            });
          const profiles = (Array.isArray(project.profiles) ? project.profiles : []).map(
            (profile) =>
              pick(profile, [
                "id",
                "revision",
                "displayName",
                "instructions",
                "model",
                "readOnly",
                "skills",
                "workflow",
                "toolAllowlist",
                "approvalTools",
                "allowThreadProcesses",
                "allowConnectionProcesses",
                "allowPluginSkills",
                "requiredModalities",
              ]),
          );
          const accepted = managed ? desktop.backend.providers.lastAcceptedModel : null;
          const defaultProfile = managed
            ? (project.resourceProfile ?? desktop.backend.defaultProfile)
            : null;
          return {
            models,
            profiles,
            defaultProfile: defaultProfile ? pick(defaultProfile, ["id", "revision"]) : null,
            lastAcceptedModel: accepted
              ? {
                  ...pick(accepted, ["modelId", "reasoningEffort", "acceptedAt"]),
                  model: accepted.model ? pick(accepted.model, ["providerId", "modelId"]) : null,
                }
              : null,
          };
        }
        if (request.method === "desktop.command") {
          const { command, request: params } = request.params ?? {};
          if (
            !desktopCommands.has(command) ||
            !params ||
            typeof params !== "object" ||
            Array.isArray(params)
          )
            throw Error("Invalid desktop command");
          if (command === "recovery") {
            if (["history", "importProvider"].includes(params.operation)) {
              const contract = appRequire("@areal/workbench/desktop-contract");
              contract.validateCommand(command, params);
              const { operation, ...query } = params;
              return await hostCall(`recovery.${operation}`, query);
            }
            if (
              !["inspect", "openWorkspace"].includes(params.operation) ||
              (params.spaceId !== undefined && typeof params.spaceId !== "string") ||
              Object.keys(params).some((key) => !["operation", "spaceId"].includes(key))
            )
              throw Object.assign(new Error("Invalid recovery query"), {
                code: "INVALID_PARAMS",
              });
            const catalog = await hostCall(
              "recovery.inspect",
              params.spaceId === undefined ? {} : { spaceId: params.spaceId },
            );
            if (params.operation === "inspect") return catalog;
            if (typeof catalog?.workspace !== "string") throw Error("Invalid recovery workspace");
            return { projectId: await desktop.backend.addProject(catalog.workspace) };
          }
          // 网页没有系统文件夹选择框，由用户填写路径；之后与桌面"打开项目"走同一条登记路径。
          if (command === "addProject") {
            if (
              typeof params.path !== "string" ||
              !isAbsolute(params.path) ||
              params.path.length > 4096
            )
              throw Error("请填写项目文件夹的完整路径");
            const path = await realpath(params.path).catch(() => {
              throw Error("找不到这个文件夹");
            });
            if (!(await stat(path)).isDirectory()) throw Error("请选择文件夹");
            return await desktop.backend.addProject(path);
          }
          // 文件选择框只在桌面窗口里有。
          if (
            command === "manage" &&
            ["pluginArchivePick", "pluginArchiveImport"].includes(params.operation)
          )
            throw Error("Desktop only");
          const contract = appRequire("@areal/workbench/desktop-contract");
          contract.validateCommand(command, params);
          // 手机连接在桌面窗口里也不经后台命令表，而是直接交给连接管理。
          const remote = desktop.adapter.remote;
          if (command === "remoteControl" && !remote) throw Error("手机连接未初始化");
          const result =
            command === "remoteControl" && remote
              ? await remote.control(params)
              : await desktop.adapter.executeRemote(command, params);
          contract.validateCommandResponse(command, params, result);
          return result ?? null;
        }
        if (request.method === "creation.read")
          return desktop.backend.worktrees.readThreadCreation(
            request.params.projectId,
            request.params.request,
          );
        if (request.method === "input.prepare")
          return prepareInput({ desktop, request: request.params });
        if (
          request.method === "execution.prepare" ||
          request.method === "execution.dispatch" ||
          request.method === "execution.complete"
        ) {
          const connection = request.context?.connection;
          if (typeof connection !== "string" || !connection || connection.length > 256)
            throw Error("Invalid execution owner");
          return request.method === "execution.prepare"
            ? desktop.adapter.prepareHostExecution(request.params, connection)
            : request.method === "execution.complete"
              ? desktop.adapter.completeHostExecution(request.params, connection)
              : desktop.adapter.dispatchHostExecution(request.params.handle, connection);
        }
        if (pageMethods.includes(request.method)) {
          const connection = request.context?.connection;
          if (
            typeof connection !== "string" ||
            !connection ||
            connection.length > 256 ||
            retiredPages.has(connection)
          )
            throw Error("Invalid page connection");
          if (!pages.has(connection)) {
            if (request.method !== "pages.command") throw Error("Page owner disconnected");
            if (pages.size >= 32) throw Error("Page connection limit reached");
            const opening = createPageSession({
              appRequire,
              desktop,
              notify: (event) => {
                if (!retiredPages.has(connection))
                  output.write(
                    JSON.stringify({
                      version: 1,
                      event: "pages.event",
                      params: { connection, ...event },
                    }) + "\n",
                  );
              },
            });
            pages.set(connection, opening);
            void opening.catch(() => {
              if (pages.get(connection) === opening) pages.delete(connection);
            });
          }
          const session = await pages.get(connection);
          if (retiredPages.has(connection)) throw Error("Page connection closed");
          if (request.method === "pages.command")
            return (await session.command(request.params)) ?? {};
          const response = await session.resource(request.params.token, request.params.path);
          const offset = request.params.offset ?? 0;
          if (!Number.isSafeInteger(offset) || offset < 0) throw Error("Invalid resource offset");
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length > 8 * 1024 * 1024 || offset > bytes.length)
            throw Error("Page resource limit reached");
          return {
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: bytes.subarray(offset, offset + 192 * 1024).toString("base64"),
            offset,
            total: bytes.length,
          };
        }
        const result = await desktop.adapter.executeRemote(domain, request.params);
        appRequire("@areal/workbench/desktop-contract").validateCommandResponse(
          domain,
          request.params,
          result,
        );
        return result;
      };
      const task = execute().then(
        (result) => output.write(JSON.stringify({ version: 1, id: request.id, result }) + "\n"),
        (error) =>
          output.write(
            JSON.stringify({
              version: 1,
              id: request.id,
              error: mapBackendError(error, request.method === "desktop.command"),
            }) + "\n",
          ),
      );
      pending.add(task);
      void task.then(
        () => pending.delete(task),
        () => pending.delete(task),
      );
    }
    // EOF 先撤销页面请求；等请求完成之后才关闭页面会让两者互相等待。
    await Promise.allSettled([...pages.keys()].map(closePages));
    await Promise.allSettled(pending);
  } finally {
    await Promise.allSettled([...pages.keys()].map(closePages));
    await cleanupDesktop?.close();
    const current = JSON.parse(await readFile(path, "utf8").catch(() => "null"));
    if (
      claimed &&
      current?.pid === process.pid &&
      (!metadata || current.identity === metadata.identity)
    )
      await unlink(path);
    lines.off("line", reply);
    lines.close();
  }
}

module.exports = { start, businessErrorCodes, mapBackendError };
if (require.main === module) {
  // 业务模块的 console 输出不能混入 Host 协议，错误也不能打印原始凭据。
  console.log = console.info = () => {};
  start({ input: process.stdin, output: process.stdout }).then(
    () => process.exit(0),
    () => {
      process.stderr.write("Workbench backend failed\n");
      process.exit(1);
    },
  );
}
