import { usePlatformReads } from "./PlatformReadContext.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.js";
import type { Action, Data } from "./services.js";
import { useI18n } from "./i18n/IntlProvider.js";
import type { ReadingAnchor } from "./readingViews.js";
import type { ReadingBlock } from "./conversationReading.js";

/** 阅读视图只持有显示缓存；关闭或切换不发送停止、继续或任何任务写入。 */
export function useConversationHistory(projectId: string, thread: Data, action: Action) {
  const { t } = useI18n();
  const platformReads = usePlatformReads();
  const reads = thread.displayHistory?.owner === "workbench" ? undefined : platformReads;
  const [viewId] = useState(() => crypto.randomUUID());
  const owner = `${projectId}:${thread.id}`;
  const generation = `${owner}:${reads ? "host" : "workbench"}:${thread.displayHistory?.viewGeneration ?? ""}`;
  const current = useRef<string | undefined>(generation);
  current.current = generation;
  const releaseGenerations = useRef(new Map<string, string>());
  if (reads) releaseGenerations.current.set(owner, String(thread.displayHistory?.viewGeneration));
  const supported = thread.displayHistory?.supported === true;
  const [failure, setFailure] = useState<{
    generation: string;
    itemId?: string;
    message: string;
  }>();
  const registration = useRef<{ generation: string; promise: Promise<unknown> } | undefined>(
    undefined,
  );
  const register = useCallback(() => {
    if (registration.current?.generation !== generation) {
      const promise = reads
        ? reads.acquire(viewId, String(thread.displayHistory?.viewGeneration))
        : action("history", {
            projectId,
            threadId: thread.id,
            viewId,
            operation: "acquire",
          });
      registration.current = { generation, promise };
      void promise.catch(() => {
        if (registration.current?.promise === promise) registration.current = undefined;
      });
    }
    return registration.current.promise;
  }, [action, reads, generation, projectId, thread.id, viewId]);
  useEffect(() => {
    if (!supported) return;
    const request = { projectId, threadId: thread.id, viewId };

    return () => {
      if (current.current === generation) current.current = undefined;
      registration.current = undefined;
      if (reads) {
        const released = releaseGenerations.current.get(owner);
        releaseGenerations.current.delete(owner);
        if (released) void reads.release(viewId, released).catch(() => {});
      } else void action("history", { ...request, operation: "release" }).catch(() => {});
    };
  }, [action, reads, owner, projectId, supported, thread.id, viewId]);
  // 重新观察会换新的历史窗口（viewGeneration 变化），视图登记随窗口沿用。这里只重新登记，
  // 不先释放：释放会清空已加载页并中断补全，随后再补回，顶部内容会反复消失、出现。
  useEffect(() => {
    if (!supported) return;
    current.current = generation;
    let active = true;
    void register().then(
      () => {
        if (active && current.current === generation) setFailure(undefined);
      },
      () => {
        if (active && current.current === generation)
          setFailure({ generation, message: t("chat.history.loadFailed") });
      },
    );
    return () => {
      active = false;
    };
  }, [generation, supported, register, t]);
  const load = useCallback(
    async (itemId?: string, pageId?: string) => {
      setFailure(undefined);
      try {
        if (reads) {
          if (itemId) await reads.loadItem(itemId, { projectId, threadId: thread.id });
          else await reads.loadOlder(pageId);
          return true;
        }
        await action("history", {
          projectId,
          threadId: thread.id,
          viewId,
          ...(itemId
            ? { operation: "loadItem", itemId }
            : { operation: "loadOlder", ...(pageId ? { pageId } : {}) }),
        });
        return true;
      } catch {
        if (current.current === generation)
          setFailure({
            generation,
            itemId,
            message: t("chat.history.loadFailed"),
          });
        return false;
      }
    },
    [action, reads, generation, projectId, thread.id, viewId, t],
  );
  const retain = useCallback(
    async (revision: number, anchor: ReadingAnchor | null) => {
      if (!supported) return;
      await register();
      if (current.current !== generation) return;
      if (reads)
        return reads.retain(
          viewId,
          revision,
          anchor,
          String(thread.displayHistory?.viewGeneration),
        );
      await action("history", {
        projectId,
        threadId: thread.id,
        viewId,
        operation: "retain",
        revision,
        anchor: anchor && { turnId: anchor.turnId, itemId: anchor.itemId },
      });
    },
    [action, reads, generation, projectId, thread.id, viewId, supported, register],
  );
  const ensure = useCallback(
    async (revision: number, anchor: ReadingAnchor): Promise<"ready" | ReadingBlock> => {
      if (!supported) return "unsupported";
      try {
        await register().catch(() => {});
        if (current.current !== generation) return "cancelled";
        if (reads) {
          const result = await reads.ensureAnchor(
            viewId,
            revision,
            anchor,
            String(thread.displayHistory?.viewGeneration),
          );
          return current.current === generation ? result : "cancelled";
        }
        const result = await action("history", {
          projectId,
          threadId: thread.id,
          viewId,
          operation: "ensureAnchor",
          revision,
          anchor: { turnId: anchor.turnId, itemId: anchor.itemId },
        });
        if (current.current !== generation) return "cancelled";
        if (result.supported && result.viewGeneration !== thread.displayHistory?.viewGeneration)
          return "cancelled";
        return result.supported ? result.kind : "unsupported";
      } catch {
        return current.current === generation ? "limited" : "cancelled";
      }
    },
    [action, reads, generation, projectId, thread.id, viewId, supported, register],
  );
  return {
    load,
    retain,
    ensure,
    generation,
    failure: failure?.generation === generation ? failure : undefined,
  };
}

export function DeferredHistoryItem({
  item,
  loading,
  error,
  onLoad,
}: {
  item: Data;
  loading?: { bytes: number; totalBytes: number };
  error?: string;
  onLoad: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="notice" data-history-item-id={item.id}>
      <p role="status">
        {loading
          ? t("chat.history.loadingFull", {
              progress: Math.floor((loading.bytes / loading.totalBytes) * 100),
            })
          : t("chat.history.deferred", {
              kind: item.originalType,
              size: Math.ceil(item.totalBytes / 1048576),
            })}
      </p>
      {error && <p role="alert">{error}</p>}
      <Button type="button" variant="ghost" size="sm" disabled={!!loading} onClick={onLoad}>
        {t("chat.history.loadFull")}
      </Button>
    </div>
  );
}
