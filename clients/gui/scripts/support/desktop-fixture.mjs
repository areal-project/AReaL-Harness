import { lstat, mkdir } from "node:fs/promises";
import { relative, resolve, sep, isAbsolute } from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

let hostClientModule;
async function fixtureHostRequest(page, request) {
  hostClientModule ??= createRequire(
    new URL("../../packages/browser-data/package.json", import.meta.url),
  )("esbuild")
    .build({
      entryPoints: [fileURLToPath(new URL("../../packages/client/src/index.ts", import.meta.url))],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "SmokeHostClient",
      platform: "browser",
    })
    .then(({ outputFiles }) => outputFiles[0].text);
  await page.evaluate(await hostClientModule);
  return page.evaluate(async ({ method, params, projectId, write }) => {
    let client;
    try {
      // Playwright 的求值上下文加载生产客户端，保持页面 CSP 和传输实现不变。
      const { HostClient } = globalThis.SmokeHostClient;
      const bootstrap = await window.arealDesktop.getHostTicket();
      client = new HostClient({
        bootstrap: async () => bootstrap,
        origin: "areal-ui://app",
        writes: true,
      });
      await client.retry();
      if (projectId) {
        const shell = client.readsSnapshot().shell;
        if (shell.state !== "fresh") throw new Error("Fixture project inventory is unavailable");
        const matches = shell.value.snapshot.projects.filter(
          (entry) =>
            entry.alias?.sourceId === bootstrap.preferredSourceId &&
            entry.alias.projectId === projectId,
        );
        if (matches.length !== 1) throw new Error("Expected exactly one original source project");
        const commandId = params.requestId ?? crypto.randomUUID();
        const result = await client.command(
          method,
          matches[0].projectId,
          { ...params, requestId: commandId },
          commandId,
        );
        if (result.admissionState !== "accepted" || typeof result.threadId !== "string")
          throw new Error(`Original thread creation ${commandId}: ${result.admissionState}`);
        return result;
      }
      const payload =
        method === "library.command"
          ? { sourceId: bootstrap.preferredSourceId, ...params }
          : params;
      if (!write) return await client.workbench(method, payload);
      const commandId = crypto.randomUUID();
      const reply = await client.workbench(method, payload, commandId);
      if (
        reply?.commandId !== commandId ||
        reply.method !== method ||
        reply.admissionState !== "accepted" ||
        reply.submissionUnknown !== false ||
        !reply.receipt
      )
        throw new Error(`Original ${method} command ${commandId} is unconfirmed`);
      return reply.receipt;
    } finally {
      client?.close();
      delete globalThis.SmokeHostClient;
    }
  }, request);
}

export function libraryCommand(page, params) {
  return fixtureHostRequest(page, { method: "library.command", params, write: true });
}

export function fixtureWorkbench(page, method, params, { write = false } = {}) {
  return fixtureHostRequest(page, { method, params, write });
}

export function createFixtureThread(page, projectId, params) {
  return fixtureHostRequest(page, { method: "session.create", projectId, params });
}

// 冒烟脚本共用的等待与桌面桥。等的是权威快照、回执或观测值满足条件，不是固定时长。
export async function until(
  read,
  label,
  { timeout = 30000, interval = 100, accept = Boolean, abort } = {},
) {
  const end = Date.now() + timeout;
  let value;
  const timeoutError = () =>
    new Error(
      `Timeout: ${label}. Last observation ${String(JSON.stringify(value)).slice(0, 4096)}`,
    );
  const beforeDeadline = async (operation) => {
    const remaining = end - Date.now();
    if (remaining <= 0) throw timeoutError();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(timeoutError()), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  do {
    abort?.();
    value = await beforeDeadline(read);
    if (await beforeDeadline(() => accept(value))) return value;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(interval, Math.max(0, end - Date.now()))),
    );
  } while (Date.now() < end);
  throw timeoutError();
}

// page 会在重启 GUI 后换新，所以传取值函数而不是 page 本身。
export function desktopBridge(currentPage) {
  const state = () => currentPage().evaluate(() => window.arealDesktop.snapshot());
  const call = async (name, params) => {
    if (name === "library") return libraryCommand(currentPage(), params);
    const reply = await currentPage().evaluate(
      ({ name, params }) => window.arealDesktop.command(name, params),
      { name, params },
    );
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply.value;
  };
  const untilState = (predicate, label, options) =>
    until(state, label, { ...options, accept: predicate });
  return { state, call, untilState };
}

// 失败现场只保留身份和结算状态，不复制消息正文、模型配置或凭据。
export function observationSummary(snapshot) {
  return (snapshot?.projects ?? []).map((project) => ({
    id: project.id,
    core: project.core && { serviceGeneration: project.core.serviceGeneration },
    connected: project.state?.connected,
    pending: project.pending?.map(({ method }) => method),
    threads: Object.entries(project.state?.threads ?? {}).map(([threadId, thread]) => ({
      threadId,
      serviceGeneration: thread.executionCore?.serviceGeneration,
      turns: (thread.turns ?? []).map(({ id, status }) => ({ id, status })),
    })),
    queues: Object.entries(project.state?.queues ?? {}).map(([threadId, queue]) => ({
      threadId,
      paused: queue.paused,
      statuses: (queue.items ?? []).map((item) => item.status),
    })),
  }));
}

// 只准备调用方认领的隔离目录；已有目录不修权限，避免掩盖复制夹具的问题。
export async function preparePrivateFixtureDirectories(root, directories) {
  const base = resolve(root);
  const paths = directories.map((directory) => {
    const child = relative(base, resolve(directory));
    if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
      throw new Error(`Private directory is outside fixture root: ${directory}`);
    return child.split(sep);
  });
  async function check(path) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Private fixture path must be a real directory: ${path}`);
    if (process.platform !== "win32") {
      if (info.uid !== process.getuid())
        throw new Error(`Private fixture directory must belong to current user: ${path}`);
      const mode = info.mode & 0o777;
      if (mode !== 0o700)
        throw new Error(`Private fixture directory ${path}: expected 700, got ${mode.toString(8)}`);
    }
  }
  await check(base);
  for (const parts of paths) {
    let current = base;
    for (const part of parts) {
      current = resolve(current, part);
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      await check(current);
    }
  }
}
