import type { HostClient } from "@areal/client";
import type { PlatformServices } from "./services.js";
import { isLibraryState } from "@areal/workbench/desktop-contract/library-media";

const WORKTREE_READS = new Set(["worktreeList", "worktreeOptions", "worktreeRead"]);
const WORKTREE_WRITES = new Set([
  "worktreeSettings",
  "worktreeEnvironmentSave",
  "worktreeEnvironmentDelete",
  "worktreeCreate",
  "worktreeCancel",
  "worktreeAction",
  "worktreeDelete",
  "worktreeOpen",
]);

const MANAGE_READS = new Set([
  "task",
  "taskScheduleContext",
  "taskSchedulePreview",
  "server",
  "profile",
  "skills",
  "skill",
  "plugins",
  "plugin",
  "pluginComponents",
  "pluginHooks",
  "pluginMcp",
  "processes",
  "process",
  "processWait",
  "processOutput",
  "executions",
  "execution",
  "executionWait",
  "executionTrace",
  "workgroups",
  "workgroupPolicy",
  "workgroup",
  "workgroupWait",
  "workflows",
  "workflow",
  "tasks",
  "taskInbox",
  "taskRuns",
  "taskRun",
]);

const MANAGE_WRITES = new Set([
  "taskPause",
  "taskResume",
  "taskUpdate",
  "taskCancel",
  "taskDelete",
  "archive",
  "unarchive",
  "planUpdate",
  "permissionsForget",
  "closeResources",
  "serverDrain",
  "serverGc",
  "executionApply",
  "executionCancel",
  "workgroupCancel",
  "pluginConfigure",
  "pluginComponentConfigure",
  "pluginHooksConfigure",
  "pluginResolve",
  "pluginInstall",
  "pluginUninstall",
  "pluginDevelopmentLink",
  "pluginDevelopmentUnlink",
  "marketplaceAdd",
  "marketplaceAddGit",
  "marketplaceRemove",
  "marketplaceUpdate",
  "processStart",
  "processWrite",
  "processResize",
  "processCloseStdin",
  "processTerminate",
  "contextCompact",
  "taskStopRun",
  "taskRunNow",
  "taskResumeRun",
]);

const ACTIVITY_MS = 5000;
const IDLE_CAP_SECONDS = 24 * 60 * 60;
/** 服务没起来或方法未开放时退回桌面原路径；其它错误照常报给界面。 */
const FALLBACK = new Set(["CAPABILITY_UNAVAILABLE", "methodNotFound", "FORBIDDEN"]);
const LIBRARY_OPERATIONS = new Set(
  "renameProject renameThread pinThread pinProject createSection renameSection removeSection orderSection moveThread moveProject readThread markAllRead orderSidebarThread hideProject orderProject orderThread dropSidebar".split(
    " ",
  ),
);

const LIBRARY_SETTINGS = new Set([
  "sidebarSort",
  "sidebarSortChats",
  "sidebarSortProjects",
  "sidebarSortPinned",
  "showPinned",
  "showCompleted",
]);

/** 按领域切到工作台服务的开关，逗号分隔，如 `analytics`。只在 reads 开着时生效。 */
export function hostDomains(): Set<string> {
  try {
    if (localStorage.getItem("areal.oneProtocol.reads") !== "1") return new Set();
    return new Set(
      (localStorage.getItem("areal.oneProtocol.domains") ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function declined(error: unknown) {
  return (
    error !== null &&
    typeof error === "object" &&
    FALLBACK.has(String((error as { code?: unknown }).code))
  );
}

/**
 * 使用统计切到 Host 的工作台服务：读与同步走 Host；本窗口每 5 秒上报前台与空闲状态，
 * 服务对所有客户端取并集；首次连上时把桌面原有的每日活跃时间合并过去。
 */
export function createWorkbenchRoutes(
  client: HostClient,
  desktop: PlatformServices | undefined,
  domains: Set<string>,
  events: Pick<Window, "addEventListener"> | undefined,
  document: Document | undefined,
  source: () => string | undefined,
): PlatformServices["workbench"] {
  if (
    ![
      "analytics",
      "library",
      "worktree",
      "tasks",
      "trajectory",
      "feedback",
      "manage",
      "providers",
      "pages",
    ].some((domain) => domains.has(domain))
  )
    return undefined;
  let lastInput = Date.now();
  for (const name of ["pointerdown", "pointermove", "keydown", "wheel"])
    events?.addEventListener(name, () => (lastInput = Date.now()), { passive: true });
  let imported: Promise<void> | undefined;
  const importDesktop = () =>
    (imported ??= (async () => {
      if (!desktop) return;
      const result = await desktop.command("analytics", { operation: "read" });
      if (!result.ok) return;
      const summary = result.value as { since: number; days: Record<string, { activeMs: number }> };
      const days = Object.fromEntries(
        Object.entries(summary.days)
          .filter(([, day]) => day.activeMs > 0)
          .map(([date, day]) => [date, day.activeMs]),
      );
      await client.workbench("analytics.import", {
        state: { version: 1, since: summary.since, days, turns: {}, skills: {} },
      });
    })().catch((error) => {
      imported = undefined;
      throw error;
    }));
  const report = () => {
    if (!domains.has("analytics")) return;
    if (!client.writable("analytics.activity")) return;
    void importDesktop().catch(() => {});
    const focused = document
      ? document.hasFocus() && document.visibilityState === "visible"
      : false;
    const idleSeconds = Math.min(IDLE_CAP_SECONDS, Math.floor((Date.now() - lastInput) / 1000));
    void client.workbench("analytics.activity", { focused, idleSeconds }).catch(() => {});
  };
  if (domains.has("analytics")) {
    setInterval(report, ACTIVITY_MS);
    for (const name of ["focus", "blur"]) events?.addEventListener(name, report);
  }
  return {
    async call(name, params) {
      if (name === "manage" && params.operation === "mcpApps" && domains.has("pages")) {
        if (!client.writable("pages.command")) return undefined;
        return {
          value: await client.workbench("pages.command", {
            operation: "catalog",
            projectId: params.projectId,
            ...(params.threadId ? { threadId: params.threadId } : {}),
          } as Parameters<HostClient["workbench"]>[1]),
        };
      }
      if (name === "tasks" && domains.has("tasks") && client.writable("tasks.read")) {
        const sourceId = source();
        if (!sourceId) throw new Error("请先选择任务目录来源");
        return {
          value: await client.workbench("tasks.read", { ...params, sourceId } as Parameters<
            HostClient["workbench"]
          >[1]),
        };
      }

      if (
        (name === "workspace" && domains.has("worktree")) ||
        (name === "trajectory" && domains.has("trajectory")) ||
        (name === "feedback" && domains.has("feedback")) ||
        (name === "manage" && domains.has("manage")) ||
        (name === "providers" && domains.has("providers"))
      ) {
        const operation = String(params.operation);
        const domain = name === "workspace" ? "worktree" : name;
        const read =
          name === "workspace"
            ? WORKTREE_READS.has(operation)
            : name === "trajectory"
              ? operation === "status"
              : name === "providers"
                ? operation === "list"
                : name === "manage"
                  ? MANAGE_READS.has(operation)
                  : ["status", "read"].includes(operation);
        const write =
          name === "workspace"
            ? WORKTREE_WRITES.has(operation)
            : name === "trajectory"
              ? ["retry", "setEnabled"].includes(operation)
              : name === "providers"
                ? [
                    "apply",
                    "default",
                    "defaultAndApply",
                    "save",
                    "saveAndApply",
                    "remove",
                    "removeAndApply",
                    "probe",
                    "discover",
                  ].includes(operation)
                : name === "manage"
                  ? MANAGE_WRITES.has(operation)
                  : ["preference", "prepare", "draft", "refine", "submit", "close"].includes(
                      operation,
                    );
        if (!read && !write) return undefined;
        const method = `${domain}.${read ? "read" : "command"}`;
        if (!client.writable(method)) return undefined;
        const sourceId = source();
        if (!sourceId)
          throw Object.assign(new Error("请先选择资料库来源"), { submissionUnknown: false });
        const payload = { ...params, sourceId } as Parameters<HostClient["workbench"]>[1];
        if (read) return { value: await client.workbench(method, payload) };
        // 保留领域请求 ID；Host commandId 管跨端派发，后台原 journal 管领域生命周期。
        const commandId = crypto.randomUUID();
        try {
          const result = (await client.workbench(method, payload, commandId)) as {
            commandId?: string;
            method?: string;
            admissionState?: string;
            submissionUnknown?: boolean;
            receipt?: unknown;
          } | null;
          if (
            !result ||
            result.commandId !== commandId ||
            result.method !== method ||
            result.admissionState !== "accepted" ||
            result.submissionUnknown !== false ||
            !("receipt" in result)
          )
            throw new Error("操作结果尚未确认，请查询原操作状态");
          return { value: result.receipt };
        } catch (error) {
          const unknown = !(
            error &&
            typeof error === "object" &&
            "submissionUnknown" in error &&
            error.submissionUnknown === false
          );
          throw Object.assign(error instanceof Error ? error : new Error("操作结果尚未确认"), {
            commandId,
            submissionUnknown: unknown,
          });
        }
      }

      if (
        name === "library" &&
        domains.has("library") &&
        (LIBRARY_OPERATIONS.has(String(params.operation)) ||
          (params.operation === "settings" && LIBRARY_SETTINGS.has(String(params.key)))) &&
        client.writable("library.command")
      ) {
        const sourceId = source();
        if (!sourceId)
          throw Object.assign(new Error("请先选择资料库来源"), { submissionUnknown: false });
        const commandId = crypto.randomUUID();
        // 已派发的写操作不能退回 Main 再做一次；丢失回复保留原 commandId 供查询。
        try {
          const result = (await client.workbench(
            "library.command",
            { ...params, sourceId } as Parameters<HostClient["workbench"]>[1],
            commandId,
          )) as {
            commandId?: string;
            method?: string;
            admissionState?: string;
            submissionUnknown?: boolean;
            receipt?: unknown;
          } | null;
          if (
            !result ||
            result.commandId !== commandId ||
            result.method !== "library.command" ||
            result.admissionState !== "accepted" ||
            result.submissionUnknown !== false ||
            !isLibraryState(result.receipt)
          )
            throw new Error("资料库操作结果尚未确认，请刷新后核对");
          return { value: result.receipt };
        } catch (error) {
          const unknown = !(
            error &&
            typeof error === "object" &&
            "submissionUnknown" in error &&
            error.submissionUnknown === false
          );
          throw Object.assign(
            error instanceof Error ? error : new Error("资料库操作结果尚未确认"),
            { commandId, submissionUnknown: unknown },
          );
        }
      }
      if (name !== "analytics" || !domains.has("analytics") || !client.writable("analytics.read"))
        return undefined;
      const method = params.operation === "sync" ? "analytics.sync" : "analytics.read";
      try {
        await importDesktop().catch(() => {});
        return { value: await client.workbench(method) };
      } catch (error) {
        if (declined(error)) return undefined;
        throw error;
      }
    },
  };
}
