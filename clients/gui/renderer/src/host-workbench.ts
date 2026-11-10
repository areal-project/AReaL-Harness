import type { HostClient } from "@areal/client";
import type { PlatformServices } from "./services.js";
import { isLibraryState } from "./services.js";
import { settingsNavigationGroups } from "./settings/settingsNavigation.js";

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

/**
 * 本机网页经 Host `desktop.command` 交给后台的桌面命令，与协议枚举一致。会话创建、发送、引导、停止与
 * 回答走 Host 写方法；窗口、系统与应用生命周期命令只在桌面窗口里有。
 */
export const DESKTOP_COMMANDS = new Set([
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
  "recovery",
  "reconcile",
  "remoteControl",
  "resources",
  "side",
  "tasks",
  "trajectory",
  "workspace",
]);
/** 只有桌面窗口才有的设置页：电脑控制要本机系统权限。 */
const DESKTOP_ONLY_SETTINGS = new Set(["电脑控制"]);

/** 本机网页的桌面命令通道；返回 undefined 表示该命令只能在桌面窗口里执行。 */
export function hostDesktopCommand(
  client: HostClient,
  failure: (name: string, params: Record<string, unknown>, error: unknown) => unknown,
  onSnapshot?: (snapshot: Record<string, unknown>) => void,
): PlatformServices["command"] {
  return async (name, params) => {
    if (!DESKTOP_COMMANDS.has(name) || !client.writable("desktop.command"))
      throw new Error("此功能需要桌面应用");
    try {
      const value = await client.workbench("desktop.command", {
        command: name,
        request: params as Parameters<HostClient["workbench"]>[1],
      });
      if (
        value &&
        typeof value === "object" &&
        "projects" in value &&
        Array.isArray((value as { projects?: unknown }).projects)
      ) {
        onSnapshot?.(value as Record<string, unknown>);
      }
      return { ok: true, value };
    } catch (error) {
      return {
        ok: false,
        error: failure(name, params as Record<string, unknown>, error),
      } as Awaited<ReturnType<PlatformServices["command"]>>;
    }
  };
}

type Run = (
  name: string,
  params: Record<string, unknown>,
) => ReturnType<PlatformServices["command"]>;

/**
 * 插件授权和 ChatGPT 登录返回授权页地址，由界面交给系统浏览器打开；桌面与网页同一处理。
 * 打不开 ChatGPT 登录页时取消这次登录，避免后台一直等回调。
 */
export function openingAuthorization(run: Run, open: (url: string) => Promise<void>): Run {
  return async (name, params) => {
    const result = await run(name, params);
    if (!result.ok) return result;
    const value = result.value as Record<string, unknown> | null;
    if (
      name === "manage" &&
      params.operation === "pluginAuth" &&
      params.authOperation === "start" &&
      value?.status === "pending" &&
      typeof value.authorizationUrl === "string"
    )
      await open(value.authorizationUrl);
    if (name === "chatgpt" && params.operation === "login" && typeof value?.authUrl === "string")
      try {
        await open(value.authUrl);
      } catch (error) {
        await run("chatgpt", { operation: "cancel", provider: params.provider });
        throw error;
      }
    return result;
  };
}

/**
 * 桌面窗口里这些后台操作仍走 Main：要系统文件框、系统权限或桌面持有的终端会话（desktopOperations），
 * 以及还由 Main 处理的过渡命令（mainCommands）。两份清单都在 shell-capabilities.cjs，由测试对齐。
 */
export function desktopKeepsCommand(name: string, params: Record<string, unknown>) {
  const operation = String(params.operation ?? "");
  if (name === "library")
    return (
      operation === "settings" &&
      ["computerControlEnabled", "computerControlProvider", "computerControlExecutable"].includes(
        String(params.key),
      )
    );
  if (name === "manage")
    return (
      operation.startsWith("process") ||
      ["pluginArchivePick", "pluginArchiveImport"].includes(operation)
    );
  return false;
}

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

/** Host 明确未受理（服务没起来、方法未开放、无权限），可以安全改走桌面原路径。 */
export function declinedCode(code: unknown) {
  return FALLBACK.has(String(code));
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
  events: Pick<Window, "addEventListener"> | undefined,
  document: Document | undefined,
  source: () => string | undefined,
): NonNullable<PlatformServices["workbench"]> {
  // 写操作不再带来源，但 Host 还没认定工作台后台时先挡住，免得落成“结果未确认”。
  const backendReady = () => {
    if (!source())
      throw Object.assign(new Error("工作台后台尚未就绪，请稍后再试"), {
        submissionUnknown: false,
      });
  };
  let lastInput = Date.now();
  for (const name of ["pointerdown", "pointermove", "keydown", "wheel"])
    events?.addEventListener(name, () => (lastInput = Date.now()), { passive: true });
  const report = () => {
    if (!client.writable("analytics.activity")) return;
    const focused = document
      ? document.hasFocus() && document.visibilityState === "visible"
      : false;
    const idleSeconds = Math.min(IDLE_CAP_SECONDS, Math.floor((Date.now() - lastInput) / 1000));
    void client.workbench("analytics.activity", { focused, idleSeconds }).catch(() => {});
  };
  setInterval(report, ACTIVITY_MS);
  for (const name of ["focus", "blur"]) events?.addEventListener(name, report);
  return {
    async call(name, params) {
      // 原生进程的连接租约归 Main；其薄适配仍经 Host 访问 Core。
      if (desktop && name === "manage" && String(params.operation).startsWith("process"))
        return undefined;
      if (name === "manage" && params.operation === "mcpApps") {
        if (!client.writable("pages.command")) return undefined;
        return {
          value: await client.workbench("pages.command", {
            operation: "catalog",
            projectId: params.projectId,
            ...(params.threadId ? { threadId: params.threadId } : {}),
          } as Parameters<HostClient["workbench"]>[1]),
        };
      }
      if (name === "tasks" && client.writable("tasks.read")) {
        return {
          value: await client.workbench(
            "tasks.read",
            params as Parameters<HostClient["workbench"]>[1],
          ),
        };
      }

      if (
        name === "workspace" ||
        name === "trajectory" ||
        name === "feedback" ||
        name === "manage" ||
        name === "providers"
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
        const payload = params as Parameters<HostClient["workbench"]>[1];
        if (read) return { value: await client.workbench(method, payload) };
        backendReady();
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
        (LIBRARY_OPERATIONS.has(String(params.operation)) ||
          (params.operation === "settings" && LIBRARY_SETTINGS.has(String(params.key)))) &&
        client.writable("library.command")
      ) {
        backendReady();
        const commandId = crypto.randomUUID();
        // 已派发的写操作不能退回 Main 再做一次；丢失回复保留原 commandId 供查询。
        try {
          const result = (await client.workbench(
            "library.command",
            params as Parameters<HostClient["workbench"]>[1],
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
      if (name !== "analytics" || !client.writable("analytics.read")) return undefined;
      const method = params.operation === "sync" ? "analytics.sync" : "analytics.read";
      try {
        return { value: await client.workbench(method) };
      } catch (error) {
        if (declined(error)) return undefined;
        throw error;
      }
    },
  };
}

export function hostPlatformCapabilities(
  client: HostClient,
  desktop: PlatformServices | undefined,
  librarySourceId: string | undefined,
): PlatformServices["capabilities"] {
  const available = (method: string) => !!librarySourceId && client.writable(method);
  const commands = desktop === undefined && !!librarySourceId && client.writable("desktop.command");
  return {
    mutations: desktop !== undefined || commands,
    conversationSubmit:
      desktop !== undefined ||
      (client.writable("session.send") && client.writable("session.control")),
    conversationCreate: desktop !== undefined || client.writable("session.create"),
    native: desktop !== undefined,
    pages:
      desktop !== undefined ||
      (client.writable("pages.command") && client.writable("pages.resource")),
    library: desktop !== undefined || available("library.command"),
    ...(desktop === undefined && {
      taskCatalog: available("tasks.read"),
      taskManage: available("manage.command"),
      settings: commands
        ? settingsNavigationGroups
            .flatMap((group) => group.items.map((item) => item.id))
            .filter((id) => !DESKTOP_ONLY_SETTINGS.has(id))
        : [
            ...(available("providers.read") ? ["模型服务"] : []),
            ...(available("worktree.read") ? ["Worktrees"] : []),
            ...(available("trajectory.read") ? ["数据飞轮"] : []),
            ...(client.writable("analytics.read") ? ["用量"] : []),
          ],
    }),
  };
}
