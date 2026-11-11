import type { Data } from "./services.js";

export function composerPending(
  entries: Data[],
  threadId: string,
  configurationRequestId: string | null,
) {
  const owned = entries.filter((entry) => entry.params?.threadId === threadId);
  // 回执与投影可能交错；已知在途的配置只锁提交，未知结果仍阻塞编辑。
  const saving = (entry: Data) =>
    entry.method === "areal/thread/configure" && entry.awaitingResponse === true;
  return {
    configuring: configurationRequestId !== null || owned.some(saving),
    // 查不到回执不能证明未受理，仍保留同一会话的提交屏障。
    pending: owned.some(
      (entry) => entry.params?.requestId !== configurationRequestId && !saving(entry),
    ),
  };
}
