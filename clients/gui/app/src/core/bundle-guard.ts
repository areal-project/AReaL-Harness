import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const BUILD_IDENTITY_PATTERN = /^[a-f0-9]{64}$/;

export function readBuildIdentity(
  manifestPath: string,
  readText: (path: string, encoding: "utf8") => string = readFileSync,
): string | null {
  try {
    const parsed = JSON.parse(readText(manifestPath, "utf8")) as {
      version?: unknown;
      identity?: unknown;
    };
    if (parsed?.version !== 1 || typeof parsed.identity !== "string") return null;
    return BUILD_IDENTITY_PATTERN.test(parsed.identity) ? parsed.identity : null;
  } catch {
    return null;
  }
}

export interface BundleGuardOptions {
  isPackaged: boolean;
  resourcesPath: string;
  execPath?: string;
  platform?: string;
  readText?: (path: string, encoding: "utf8") => string;
  pathExists?: (path: string) => boolean;
}

export interface BundleReplacementCheck {
  replaced: boolean;
  transient: boolean;
  execPath?: string;
  reason: string;
}

/**
 * 监控已打包桌面应用在磁盘上是否已被新版完整覆盖替换。
 * 只有在读到有效的新指纹且确认新可执行文件已在磁盘就绪时才允许进入重拉流程，
 * 覆盖过程中的短暂缺文件视为可重试态，不会提前退出旧进程。
 */
export function createBundleGuard(options: BundleGuardOptions) {
  const readText = options.readText ?? readFileSync;
  const pathExists = options.pathExists ?? existsSync;
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const manifestPath = join(options.resourcesPath, "desktop-build.json");
  const initialIdentity = options.isPackaged ? readBuildIdentity(manifestPath, readText) : null;
  let activeRelaunch: Promise<unknown> | null = null;

  function resolveRelaunchExecPath(): string | undefined {
    if (platform === "darwin") {
      // macOS 原地替换 .app 后，旧进程 process.execPath 可能指向已移走的备份路径；
      // 优先按原安装位置的 resourcesPath 定位新包内可执行文件。
      const candidate = resolve(options.resourcesPath, "..", "MacOS", basename(execPath));
      return pathExists(candidate) ? candidate : undefined;
    }
    return pathExists(execPath) ? execPath : undefined;
  }

  function checkReplaced(): BundleReplacementCheck {
    if (!options.isPackaged || !initialIdentity) {
      return { replaced: false, transient: false, reason: "" };
    }
    const current = readBuildIdentity(manifestPath, readText);
    if (!current) {
      // 覆盖安装过程中文件可能短暂缺失或正在写入，作为可重试态不触发提前退出。
      return {
        replaced: false,
        transient: true,
        reason: "desktop-build.json temporarily missing or unreadable",
      };
    }
    if (current === initialIdentity) {
      return { replaced: false, transient: false, reason: "" };
    }
    const nextExecPath = resolveRelaunchExecPath();
    if (!nextExecPath) {
      return {
        replaced: false,
        transient: true,
        reason: "replacement executable is not yet present on disk",
      };
    }
    return {
      replaced: true,
      transient: false,
      execPath: nextExecPath,
      reason: "desktop-build.json identity changed on disk",
    };
  }

  function triggerRelaunchIfReplaced(hooks: {
    isBusy: () => boolean;
    requestRelaunchQuit: (execPath: string) => Promise<unknown>;
  }): boolean {
    const check = checkReplaced();
    if (!check.replaced || !check.execPath) return false;
    if (activeRelaunch || hooks.isBusy()) return true;
    const pending = hooks
      .requestRelaunchQuit(check.execPath)
      .catch((error) => {
        console.error("Failed to cleanly stop stale desktop bundle before relaunch", error);
      })
      .finally(() => {
        // 若用户取消或清理失败（进程未退出），释放重拉占位以便后续重试。
        if (activeRelaunch === pending) activeRelaunch = null;
      });
    activeRelaunch = pending;
    return true;
  }

  /**
   * 首次加载失败时，消费 guard 与协调器的结果，避免启动层 catch 先于重拉清理调用 app.exit(1)。
   */
  async function recoverStartupLoadFailure(
    hooks: {
      isBusy: () => boolean;
      isExitReady: () => boolean;
      getPendingQuit: () => Promise<unknown> | null;
      requestRelaunchQuit: (execPath: string) => Promise<unknown>;
    },
    retryOptions?: { maxAttempts?: number; retryDelayMs?: number },
  ): Promise<"handled" | "retry" | "unhandled"> {
    const maxAttempts = retryOptions?.maxAttempts ?? 15;
    const retryDelayMs = retryOptions?.retryDelayMs ?? 200;

    const awaitActiveQuit = async (): Promise<boolean> => {
      const pending = activeRelaunch ?? hooks.getPendingQuit();
      if (pending) {
        await pending.catch(() => {});
      }
      return hooks.isExitReady();
    };

    if (activeRelaunch || hooks.isBusy()) {
      return (await awaitActiveQuit()) ? "handled" : "unhandled";
    }

    let sawTransient = false;
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      const check = checkReplaced();
      if (check.replaced && check.execPath) {
        triggerRelaunchIfReplaced(hooks);
        if (await awaitActiveQuit()) return "handled";
        return "unhandled";
      }
      if (!check.transient) {
        return sawTransient ? "retry" : "unhandled";
      }
      sawTransient = true;
      if (attempt < maxAttempts) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelayMs));
      }
    }
    return "unhandled";
  }

  return {
    initialIdentity,
    manifestPath,
    checkReplaced,
    resolveRelaunchExecPath,
    triggerRelaunchIfReplaced,
    recoverStartupLoadFailure,
  };
}
