import type { HostClient } from "@areal/client";
import { configurationIdentity, type ReadProject } from "./host-snapshot.js";

type Cache = Map<string, { identity: string; scope?: string; value?: Record<string, unknown> }>;
type ShellProject = {
  projectId: string;
  state: string;
  serviceGeneration?: unknown;
  modelCatalogRevision?: unknown;
};

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const RETRY_MS = 5000;

// 每个连接一份：模型服务设置变化后加一，同一代 Core 的目录重读，重读期间继续显示旧目录。
const stalenessByClient = new WeakMap<
  HostClient,
  { epoch: number; seen?: string; wake?: () => void }
>();
function staleness(client: HostClient) {
  let entry = stalenessByClient.get(client);
  if (!entry) stalenessByClient.set(client, (entry = { epoch: 0 }));
  return entry;
}
/**
 * 每次拿到模型服务设置（providers 命令的结果）都对一下：保存先落盘、再逐个应用到各项目的 Core，
 * 写入返回时目录可能还是旧的。修订号、凭据状态或任一项目的应用状态变了，就让模型目录重读。
 */
export function modelServiceObserved(client: HostClient, value: unknown) {
  if (!object(value) || !Array.isArray(value.projects)) return;
  const entry = staleness(client);
  const seen = JSON.stringify([value.revision, value.credentialStates, value.projects]);
  const first = entry.seen === undefined;
  if (entry.seen === seen) return;
  entry.seen = seen;
  if (first) return;
  entry.epoch++;
  entry.wake?.();
}

/** 模型、配置档与 Core 能力都由 Host 的 project.models 提供，桌面与网页同一来源。 */
export function refreshModelCatalogs(
  client: HostClient,
  projects: readonly ShellProject[],
  catalogs: Cache,
  publish: () => void,
) {
  const stale = staleness(client);
  stale.wake = publish;
  const connection = client.snapshot();
  if (connection.connection !== "ready") return;
  for (const project of projects) {
    if (project.state !== "ready") continue;
    const scope = JSON.stringify([connection.identity.connectionId, project.serviceGeneration]);
    const identity = `${scope}#${stale.epoch}#${String(project.modelCatalogRevision ?? "")}`;
    const previous = catalogs.get(project.projectId);
    if (previous?.identity === identity) continue;
    const entry: NonNullable<ReturnType<Cache["get"]>> = {
      identity,
      scope,
      ...(previous?.scope === scope && previous.value ? { value: previous.value } : {}),
    };
    catalogs.set(project.projectId, entry);
    void client
      .query("project.models", project.projectId, {})
      .then((value) => {
        if (catalogs.get(project.projectId) !== entry) return;
        if (!object(value) || !Array.isArray(value.models)) throw new Error("INVALID_RESPONSE");
        entry.value = value;
        publish();
      })
      .catch(() => {
        // 后台可能还在连接；这一代的条目先占着挡住重绘重读，过了退避再放开重试。
        setTimeout(() => {
          if (catalogs.get(project.projectId) !== entry) return;
          catalogs.delete(project.projectId);
          publish();
        }, RETRY_MS);
      });
  }
}

/** 会话配置不带解析后的模型名；网页经后台 inspect 补上，与桌面一致。 */
export function refreshInspections(
  client: HostClient,
  projects: readonly ReadProject[],
  inspections: Cache,
  publish: () => void,
) {
  const connection = client.snapshot();
  if (connection.connection !== "ready") return;
  for (const project of projects) {
    for (const threadId of Object.keys(project.state.threads)) {
      const configuration = project.state.threads[threadId]?.desktop?.configuration;
      if (!object(configuration)) continue;
      const key = `${project.id}:${threadId}`;
      const identity = configurationIdentity(configuration);
      const scope = JSON.stringify([
        connection.identity.connectionId,
        project.core?.serviceGeneration,
      ]);
      if (inspections.get(key)?.identity === identity && inspections.get(key)?.scope === scope)
        continue;
      const entry: { identity: string; scope: string; value?: Record<string, unknown> } = {
        identity,
        scope,
      };
      inspections.set(key, entry);
      void client
        .workbench("desktop.command", {
          command: "manage",
          request: { projectId: project.id, threadId, operation: "inspect" },
        })
        .then((value) => {
          if (!object(value)) throw new Error("INVALID_RESPONSE");
          const current = client.snapshot();
          if (
            inspections.get(key) !== entry ||
            current.connection !== "ready" ||
            current.identity.connectionId !== connection.identity.connectionId
          )
            return;
          entry.value = {
            ...(typeof value.modelName === "string" ? { modelName: value.modelName } : {}),
            ...(object(value.resolvedParameters)
              ? { resolvedParameters: value.resolvedParameters }
              : {}),
          };
          publish();
        })
        .catch(() => {
          setTimeout(() => {
            if (inspections.get(key) !== entry) return;
            inspections.delete(key);
            publish();
          }, RETRY_MS);
        });
    }
  }
}

/** 浏览器拿不到本机文件夹选择框；本机网页让用户填路径，登记仍由桌面后台完成。 */
export async function chooseHostProject(client: HostClient) {
  if (!client.writable("desktop.command")) throw new Error("此功能需要桌面应用");
  const path = globalThis.prompt("输入项目文件夹的完整路径")?.trim();
  if (!path) return null;
  const id = await client.workbench("desktop.command", {
    command: "addProject",
    request: { path },
  });
  if (typeof id !== "string") throw new Error("项目登记结果无效");
  client.refreshShell();
  return id;
}

export async function reviewToken(
  client: HostClient,
  hostProjectId: string,
  target: Record<string, string>,
) {
  let cursor: string | undefined;
  for (let page = 0; page < 64; page++) {
    const value = (await client.query("attention.read", hostProjectId, {
      ...target,
      ...(cursor && { cursor }),
    })) as Record<string, unknown>;
    if (typeof value.reviewToken === "string") return value;
    if (typeof value.nextCursor !== "string") break;
    cursor = value.nextCursor;
  }
  throw new Error("审批详情未读完");
}
