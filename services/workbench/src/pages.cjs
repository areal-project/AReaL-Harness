// @ts-check
"use strict";

/**
 * 每个已鉴权的 Host 连接持有一个页面会话；不借用 Main 的页面身份或磁盘状态。
 * @param {{appRequire:NodeRequire,desktop:Awaited<ReturnType<typeof import('@areal/workbench-service/desktop/core/service-main.cjs').createMainDesktop>>,notify:(event:{token:string,notification:Record<string,unknown>})=>void}} options
 */
async function createPageSession({ appRequire, desktop, notify }) {
  /** @type {typeof import('@areal/workbench-service/desktop/core/mcp-apps.cjs')} */
  const { McpAppsHost } = appRequire("@areal/workbench-service/desktop/core/mcp-apps.cjs");
  /** @type {typeof import('@areal/workbench-service/desktop/core/service-state.cjs')} */
  const { ownsThread, retainsThreadResources } = appRequire(
    "@areal/workbench-service/desktop/core/service-state.cjs",
  );
  /** @type {typeof import('@areal/workbench-service/desktop/core/gen-ui-state.cjs')} */
  const { genUiScope } = appRequire("@areal/workbench-service/desktop/core/gen-ui-state.cjs");
  /** @type {typeof import('@areal/workbench-service/desktop/core/service-protocol.cjs')} */
  const { PROTOCOL } = appRequire("@areal/workbench-service/desktop/core/service-protocol.cjs");
  const backend = desktop.backend;
  let closed = false;
  /** @type {InstanceType<typeof import('@areal/workbench-service/desktop/core/mcp-apps.cjs').McpAppsHost>|undefined} */
  let host;
  const connection = desktop.adapter.connectMain(
    (message) => {
      if (closed || !host) return;
      if (message.method === "state") host.revokeInvalid();
      if (message.method === "mcpAppNotification") host.notification(message.params);
      if (message.method === "mcpPageToolNotice")
        void host.pageToolNotice(message.params).catch(() => {});
      if (message.method === "mcpPageToolsRevoked") host.pageToolsDisconnected(message.params);
    },
    () => {
      closed = true;
      host?.dispose();
    },
  );
  try {
    // 只建立业务会话，不登记 computerHost、通知展示或原生工具能力。
    await connection.request("hello", {
      protocol: PROTOCOL,
      identity: connection.metadata.identity,
    });
    host = new McpAppsHost({
      ownerId: () => (closed ? undefined : 1),
      notify: (/** @type {{token:string,notification:Record<string,unknown>}} */ event) => {
        if (!closed) notify(event);
      },
      backend: {
        get saved() {
          return backend.snapshot().projects;
        },
        snapshot: () => backend.snapshot(),
        ownsThread: (/** @type {string} */ projectId, /** @type {string} */ threadId) =>
          ownsThread(backend.snapshot(), projectId, threadId),
        retainsThreadResources: (/** @type {string} */ projectId, /** @type {string} */ threadId) =>
          retainsThreadResources(backend.snapshot(), projectId, threadId),
        genUiState: backend.genUiState,
        genUiScope: (
          /** @type {import('@areal/workbench-service/desktop/core/gen-ui-state.cjs').GenUiProject} */ project,
          /** @type {string} */ threadId,
        ) => genUiScope(backend.home, project, threadId),
        command: (/** @type {string} */ name, /** @type {Record<string,unknown>} */ request) =>
          connection.request("command", { name, request }),
        mcpPageTools: (/** @type {Record<string,unknown>} */ request) =>
          connection.request("mcpPageTools", request),
      },
    });
  } catch (error) {
    connection.close();
    throw error;
  }
  const pages = host;
  /** @type {Set<Promise<unknown>>} */
  const pending = new Set();
  /** @type {Promise<void>|undefined} */
  let closing;
  /** @param {Record<string,unknown>} request */
  const command = async (request) => {
    if (closed) throw Error("Page owner disconnected");
    switch (request.operation) {
      case "catalog":
        return connection.request("command", {
          name: "manage",
          request: {
            operation: "mcpApps",
            projectId: request.projectId,
            ...(typeof request.threadId === "string" ? { threadId: request.threadId } : {}),
          },
        });
      case "open":
        return pages.open(request, 1);
      case "openFromResult":
        return pages.openFromResult(request, 1);
      case "openGenUi":
        return pages.openGenUi(request, 1);
      case "genUiVisibility":
        return pages.genUiVisibility(request, 1);
    }
    if (typeof request.token !== "string") throw Error("Invalid page token");
    switch (request.operation) {
      case "request":
        return pages.request(request.token, request.request, 1);
      case "close":
        if (!pages.instances.has(request.token)) throw Error("Invalid page owner");
        return pages.close(request.token, 1);
      case "pageToolsReady":
        if (typeof request.mountId === "string")
          return pages.pageToolsReady(request.token, request.mountId, request.declaration, 1);
        break;
      case "pageToolsUnmount":
        if (typeof request.mountId === "string")
          return pages.pageToolsUnmount(request.token, request.mountId, 1);
        break;
      case "pageToolResult":
        if (typeof request.mountId === "string" && typeof request.callId === "string")
          return pages.pageToolResult(
            request.token,
            request.mountId,
            request.callId,
            request.reply,
            1,
          );
    }
    throw Error("Unsupported page operation");
  };
  return {
    /** @param {Record<string,unknown>} request */
    command(request) {
      const operation = command(request);
      pending.add(operation);
      void operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation),
      );
      return operation;
    },
    /** @param {string} token @param {string} path */
    async resource(token, path) {
      if (closed) throw Error("Page owner disconnected");
      pages.get(token, 1);
      if (!path.startsWith("/") || path.startsWith("//") || /[?#\\]/.test(path))
        throw Error("Invalid page resource");
      return pages.resource({ method: "GET", url: `areal-mcp://${token}${path}` });
    },
    close() {
      if (closing) return closing;
      closed = true;
      // 先封住在途 open 的收养，并取消现有页面请求，避免等待请求与关闭互相阻塞。
      pages.epoch++;
      const retired = [...pages.instances].map(([token]) => pages.close(token, 1));
      closing = (async () => {
        try {
          await Promise.allSettled([...retired, ...pending]);
          await Promise.allSettled([...pages.instances].map(([token]) => pages.close(token, 1)));
        } finally {
          connection.close();
        }
      })();
      return closing;
    },
  };
}

/**
 * 输入上下文复用后台的权威状态投影；不接受客户端提供的状态或文件作用域。
 * @param {{desktop:Awaited<ReturnType<typeof import('@areal/workbench-service/desktop/core/service-main.cjs').createMainDesktop>>,request:Record<string,unknown>}} options
 */
async function prepareInput({ desktop, request }) {
  if (
    Object.keys(request).some((key) => !["projectId", "threadId", "text"].includes(key)) ||
    typeof request.projectId !== "string" ||
    !request.projectId ||
    typeof request.threadId !== "string" ||
    !request.threadId ||
    typeof request.text !== "string"
  )
    throw Error("Invalid input owner");
  const project = desktop.adapter.projectForThread(request.projectId, request.threadId);
  if (!project) throw Error("Input project unavailable");
  const text = await desktop.backend.genUiText(project, request.threadId, request.text);
  if (desktop.adapter.projectForThread(request.projectId, request.threadId) !== project)
    throw Error("Input project changed");
  return { text };
}

module.exports = { createPageSession, prepareInput };
