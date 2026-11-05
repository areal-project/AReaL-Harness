"use strict";
// Host 持有进程和私有管道；桌面后台复用原模块，原生能力仍由已认证的 Main 提供。
const { createRequire } = require("node:module");
const { join } = require("node:path");
const { readFile, writeFile, unlink } = require("node:fs/promises");
const { createInterface } = require("node:readline");
const { MAX_FRAME } = require("./channel.cjs");
const { createPageSession, prepareInput } = require("./pages.cjs");
const pageMethods = ["pages.command", "pages.resource"];
const privateMethods = ["input.prepare", "execution.prepare", "execution.dispatch", "creation.read", "creation.catalog"];
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

async function start({ input, output }) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || Buffer.byteLength(first.value) >= MAX_FRAME) throw new Error("INVALID_PARAMS");
  const frame = JSON.parse(first.value);
  if (frame.version !== 1 || frame.method !== "backend.start") throw new Error("INVALID_PARAMS");
  const { appRoot, options, retired } = frame.params;
  const appRequire = createRequire(join(appRoot, "package.json"));
  const { createMainDesktop } = appRequire("@areal/workbench-service/desktop/core/service-main.cjs");
  let desktop, metadata, claimed = false;
  const pages = new Map();
  const retiredPages = new Set();
  const closePages = async (connection) => {
    retiredPages.add(connection);
    const opening = pages.get(connection);
    pages.delete(connection);
    try { await (await opening)?.close(); }
    finally { retiredPages.delete(connection); }
  };
  const path = join(options.home, "service.json");
  try {
    if (retired) {
      const previous = JSON.parse(await readFile(path, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "null";
        throw error;
      }));
      if (previous && previous.pid === retired.pid && previous.identity === retired.identity &&
          previous.desktopGeneration === retired.desktopGeneration) await unlink(path);
    }
    // 启动前拒绝抢占任何未由本 Host 确认退役的后台。
    await writeFile(path, JSON.stringify({ state: "starting", pid: process.pid }), { mode: 0o600, flag: "wx" });
    claimed = true;
    const encryption = {
      isEncryptionAvailable: () => true,
      encryptString: async (value) => Buffer.from(await desktop.adapter.encryptionRequest("encrypt", value), "base64"),
      decryptString: (value) => desktop.adapter.encryptionRequest("decrypt", value.toString("base64")),
    };
    desktop = await createMainDesktop({ ...options, applicationOwner: undefined, sourceSingletonHeld: false }, { onClose: () => lines.close(), hostManaged: true });
    desktop.backend.cloud.encryption = encryption;
    metadata = await desktop.adapter.listen({ initialized: true });
    await writeFile(path, JSON.stringify(metadata), { mode: 0o600 });
    output.write(JSON.stringify({ version: 1, event: "ready", methods: [...Object.keys(domains), ...pageMethods, ...privateMethods], service: {
      pid: metadata.pid, identity: metadata.identity, desktopGeneration: metadata.desktopGeneration,
    } }) + "\n");
    // EOF 是 Host 的关闭指令；领域调用只由已鉴权的 Host 经私有管道进入。
    const pending = new Set();
    for await (const line of { [Symbol.asyncIterator]: () => iterator }) {
      if (Buffer.byteLength(line) >= MAX_FRAME) throw new Error("LIMIT_EXCEEDED");
      const request = JSON.parse(line);
      if (request.version !== 1) throw new Error("INVALID_PARAMS");
      if (request.event === "execution.cancel" && typeof request.connection === "string" && typeof request.handle === "string") {
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
      if (!Object.hasOwn(domains, request.method) && !pageMethods.includes(request.method) &&
          !privateMethods.includes(request.method))
        throw new Error("INVALID_PARAMS");
      const domain = domains[request.method];
      const execute = async () => {
        if (request.method === "creation.catalog") {
          const project = desktop.backend.projects.get(request.params.projectId);
          if (!project?.client) throw Error("Creation catalog unavailable");
          const pick = (value, fields) => Object.fromEntries(fields.filter(key => value?.[key] !== undefined).map(key => [key,value[key]]));
          const managed = desktop.backend.providers.manages(project);
          const modelFields = ["providerId","providerName","modelId","providerRevision","isDefault","credentialState","displayName","parameters","contextWindowTokens","maxOutputTokens","reasoningEffortOptions","capabilities","available","availability","unavailableReason"];
          const models = desktop.backend.providers.catalog(project.models ?? [], project).slice(0,200).map(model => {
            const value = pick(model, modelFields);
            if (value.parameters) value.parameters = pick(value.parameters,["temperature","maxOutputTokens","contextWindowTokens","reasoningEffort","reasoningSummary","serviceTier"]);
            if (value.capabilities) value.capabilities = pick(value.capabilities,["tools","vision","reasoning","reasoningEffortOptions"]);
            return value;
          });
          const profiles = (Array.isArray(project.profiles) ? project.profiles : []).map(profile => pick(profile,["id","revision","displayName","instructions","model","readOnly","skills","workflow","toolAllowlist","approvalTools","allowThreadProcesses","allowConnectionProcesses","allowPluginSkills","requiredModalities"]));
          const accepted = managed ? desktop.backend.providers.lastAcceptedModel : null;
          const defaultProfile = managed ? (project.resourceProfile ?? desktop.backend.defaultProfile) : null;
          return {models,profiles,defaultProfile:defaultProfile ? pick(defaultProfile,["id","revision"]) : null,
            lastAcceptedModel:accepted ? {...pick(accepted,["modelId","reasoningEffort","acceptedAt"]),model:accepted.model ? pick(accepted.model,["providerId","modelId"]) : null} : null};
        }
        if (request.method === "creation.read") return desktop.backend.worktrees.readThreadCreation(request.params.projectId, request.params.request);
        if (request.method === "input.prepare") return prepareInput({ desktop, request: request.params });
        if (request.method === "execution.prepare" || request.method === "execution.dispatch") {
          const connection = request.context?.connection;
          if (typeof connection !== "string" || !connection || connection.length > 256) throw Error("Invalid execution owner");
          return request.method === "execution.prepare"
            ? desktop.adapter.prepareHostExecution(request.params, connection)
            : desktop.adapter.dispatchHostExecution(request.params.handle, connection);
        }
        if (pageMethods.includes(request.method)) {
          const connection = request.context?.connection;
          if (typeof connection !== "string" || !connection || connection.length > 256 ||
              retiredPages.has(connection)) throw Error("Invalid page connection");
          if (!pages.has(connection)) {
            if (request.method !== "pages.command") throw Error("Page owner disconnected");
            if (pages.size >= 32) throw Error("Page connection limit reached");
            const opening = createPageSession({ appRequire, desktop, notify: (event) => {
              if (!retiredPages.has(connection)) output.write(JSON.stringify({
                version: 1, event: "pages.event", params: { connection, ...event },
              }) + "\n");
            } });
            pages.set(connection, opening);
            void opening.catch(() => { if (pages.get(connection) === opening) pages.delete(connection); });
          }
          const session = await pages.get(connection);
          if (retiredPages.has(connection)) throw Error("Page connection closed");
          if (request.method === "pages.command") return (await session.command(request.params)) ?? {};
          const response = await session.resource(request.params.token, request.params.path);
          const offset = request.params.offset ?? 0;
          if (!Number.isSafeInteger(offset) || offset < 0) throw Error("Invalid resource offset");
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length > 8 * 1024 * 1024 || offset > bytes.length) throw Error("Page resource limit reached");
          return { status: response.status, headers: Object.fromEntries(response.headers),
            body: bytes.subarray(offset, offset + 192 * 1024).toString("base64"),
            offset, total: bytes.length };
        }
        const result = await desktop.adapter.executeRemote(domain, request.params);
        appRequire("@areal/workbench/desktop-contract").validateCommandResponse(domain, request.params, result);
        return result;
      };
      const task = execute().then(
        (result) => output.write(JSON.stringify({ version: 1, id: request.id, result }) + "\n"),
        () => output.write(JSON.stringify({ version: 1, id: request.id, error: { code: "CORE_UNAVAILABLE" } }) + "\n"),
      );
      pending.add(task);
      void task.then(() => pending.delete(task), () => pending.delete(task));
    }
    // EOF 先撤销页面请求；等请求完成之后才关闭页面会让两者互相等待。
    await Promise.allSettled([...pages.keys()].map(closePages));
    await Promise.allSettled(pending);
  } finally {
    await Promise.allSettled([...pages.keys()].map(closePages));
    await desktop?.close();
    const current = JSON.parse(await readFile(path, "utf8").catch(() => "null"));
    if (claimed && current?.pid === process.pid && (!metadata || current.identity === metadata.identity))
      await unlink(path);
    lines.close();
  }
}

module.exports = { start };
if (require.main === module) {
  // 业务模块的 console 输出不能混入 Host 协议，错误也不能打印原始凭据。
  console.log = console.info = () => {};
  start({ input: process.stdin, output: process.stdout }).then(
    () => process.exit(0),
    () => { process.stderr.write("Workbench backend failed\n"); process.exit(1); },
  );
}
