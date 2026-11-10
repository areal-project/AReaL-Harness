import type { HostClient } from "@areal/client";
import { configurationIdentity, type ReadProject } from "./host-snapshot.js";

type Cache = Map<string, { identity: string; value?: Record<string, unknown> }>;
type ShellProject = { projectId: string; state: string; serviceGeneration?: unknown };

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** 模型、配置档与 Core 能力都由 Host 的 project.models 提供，桌面与网页同一来源。 */
export function refreshModelCatalogs(
  client: HostClient,
  projects: readonly ShellProject[],
  catalogs: Cache,
  publish: () => void,
) {
  const connection = client.snapshot();
  if (connection.connection !== "ready") return;
  for (const project of projects) {
    if (project.state !== "ready") continue;
    const identity = JSON.stringify([connection.identity.connectionId, project.serviceGeneration]);
    if (catalogs.get(project.projectId)?.identity === identity) continue;
    const entry: { identity: string; value?: Record<string, unknown> } = { identity };
    catalogs.set(project.projectId, entry);
    void client
      .query("project.models", project.projectId, {})
      .then((value) => {
        if (catalogs.get(project.projectId) !== entry || !object(value)) return;
        if (!Array.isArray(value.models)) return;
        entry.value = value;
        publish();
      })
      .catch(() => {});
  }
}

/** 会话配置不带解析后的模型名；网页经后台 inspect 补上，与桌面一致。 */
export function refreshInspections(
  client: HostClient,
  projects: readonly ReadProject[],
  inspections: Cache,
  publish: () => void,
) {
  for (const project of projects) {
    for (const threadId of Object.keys(project.state.threads)) {
      const configuration = project.state.threads[threadId]?.desktop?.configuration;
      if (!object(configuration)) continue;
      const key = `${project.id}:${threadId}`;
      const identity = configurationIdentity(configuration);
      if (inspections.get(key)?.identity === identity) continue;
      const entry: { identity: string; value?: Record<string, unknown> } = { identity };
      inspections.set(key, entry);
      void client
        .workbench("desktop.command", {
          command: "manage",
          request: { projectId: project.id, threadId, operation: "inspect" },
        })
        .then((value) => {
          if (inspections.get(key) !== entry || !object(value)) return;
          entry.value = {
            ...(typeof value.modelName === "string" ? { modelName: value.modelName } : {}),
            ...(object(value.resolvedParameters)
              ? { resolvedParameters: value.resolvedParameters }
              : {}),
          };
          publish();
        })
        .catch(() => {});
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
