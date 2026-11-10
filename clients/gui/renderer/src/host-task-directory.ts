import type { HostClient, ShellProject } from "@areal/client";

export type TaskDirectoryState = {
  tasks: Map<string, Record<string, unknown>>;
  reads: Map<string, string>;
};

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** 任务目录行只带最近与当前运行；补成 runs，界面按同一形状找任务对话。 */
function taskDirectory(rows: unknown[]) {
  const value: Record<string, unknown> = {};
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const task = row as Record<string, unknown>;
    if (typeof task.id !== "string") continue;
    const runs = [task.activeRun, task.latestRun].filter(
      (run, index, all): run is Record<string, unknown> =>
        !!run &&
        typeof run === "object" &&
        all.findIndex(
          (other) => (other as { id?: unknown } | null)?.id === (run as { id?: unknown }).id,
        ) === index,
    );
    value[task.id] = { ...task, runs };
  }
  return value;
}

/** Host 每次任务更新换一次标记；任一项目标记变化时一次读回全部任务目录，并通知已打开的任务视图重读。 */
export function refreshTaskDirectory(
  client: HostClient,
  projects: readonly ShellProject[],
  ids: ReadonlyMap<string, string>,
  { tasks, reads: taskReads }: TaskDirectoryState,
  publish: () => void,
) {
  const ready = projects.filter((project) => project.state === "ready" && project.taskRevision);
  const revisions = new Map(ready.map((project) => [project.projectId, project.taskRevision!]));
  const changed = ready.filter(
    (project) => taskReads.get(project.projectId) !== project.taskRevision,
  );
  if (!changed.length && revisions.size === taskReads.size) return;
  const previous = new Map(taskReads);
  taskReads.clear();
  for (const [projectId, revision] of revisions) taskReads.set(projectId, revision);
  const current = () =>
    taskReads.size === revisions.size &&
    [...revisions].every(([projectId, revision]) => taskReads.get(projectId) === revision);
  if (!revisions.size) {
    tasks.clear();
    return;
  }
  const hostIds = new Map([...ids].map(([hostId, alias]) => [alias, hostId]));
  void client
    .workbench("tasks.read", {
      operation: "observe",
      limit: 1024,
    } as Parameters<HostClient["workbench"]>[1])
    .then((value) => {
      if (!current() || !object(value) || !Array.isArray(value.data)) return;
      const rows = new Map<string, unknown[]>();
      for (const row of value.data) {
        if (!object(row) || typeof row.projectId !== "string") continue;
        const projectId = hostIds.get(row.projectId) ?? row.projectId;
        rows.set(projectId, [...(rows.get(projectId) ?? []), row]);
      }
      tasks.clear();
      for (const projectId of revisions.keys())
        tasks.set(projectId, taskDirectory(rows.get(projectId) ?? []));
      publish();
      if (typeof window === "undefined") return;
      for (const project of changed)
        if (previous.has(project.projectId))
          window.dispatchEvent(
            new CustomEvent("areal-scheduled-tasks-changed", {
              detail: ids.get(project.projectId) ?? project.projectId,
            }),
          );
    })
    .catch(() => {
      if (current()) taskReads.clear();
    });
}
