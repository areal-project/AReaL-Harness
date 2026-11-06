import type { HostClient } from "@areal/client";
import { configurationIdentity, type ReadProject } from "./host-snapshot.js";

type Cache = Map<string, { identity: string; value?: Record<string, unknown> }>;
type ShellProject = { projectId: string; state: string; serviceGeneration?: unknown };

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** 桌面后台只认识资料库里的项目；其余项目（如命令行登记的）由 Host 读模型目录。 */
export function refreshModelCatalogs(
  client: HostClient,
  projects: readonly ShellProject[],
  known: (projectId: string) => boolean,
  catalogs: Cache,
  publish: () => void,
) {
  const connection = client.snapshot();
  if (connection.connection !== "ready") return;
  for (const project of projects) {
    if (project.state !== "ready" || known(project.projectId)) continue;
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
  sourceId: string,
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
          sourceId,
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
export async function chooseHostProject(client: HostClient, sourceId: string | undefined) {
  if (!sourceId || !client.writable("desktop.command")) throw new Error("此功能需要桌面应用");
  const path = globalThis.prompt("输入项目文件夹的完整路径")?.trim();
  if (!path) return null;
  const id = await client.workbench("desktop.command", {
    sourceId,
    command: "addProject",
    request: { path },
  });
  if (typeof id !== "string") throw new Error("项目登记结果无效");
  client.refreshShell();
  return id;
}
