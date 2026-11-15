type Stage =
  | "selected"
  | "cache"
  | "request"
  | "response"
  | "baseline"
  | "projection"
  | "messagesCommitted"
  | "messagesPainted";

let sequence = 0;
let active: ReturnType<typeof createTiming> | undefined;

function createTiming(threadId: string) {
  const sample = ++sequence;
  const start = performance.now();
  const stages = new Set<Stage>();
  let cache: "hit" | "miss" | undefined;
  return {
    threadId,
    sample,
    has(stage: Stage) {
      return stages.has(stage);
    },
    mark(stage: Stage, hit?: boolean) {
      // 迟到的响应与绘制回调不能归入后来选中的会话；不记录消息、路径或连接地址。
      if (active?.sample !== sample || stages.has(stage)) return;
      if (hit !== undefined) cache = hit ? "hit" : "miss";
      stages.add(stage);
      performance.measure("areal.session-load", {
        start,
        end: performance.now(),
        detail: { sample, stage, cache },
      });
    },
  };
}

export function beginSessionLoad(threadId: string) {
  // User Timing 只保留最近一批选择，避免常驻客户端积累无界诊断数据。
  if (sequence % 32 === 0) performance.clearMeasures("areal.session-load");
  active = threadId ? createTiming(threadId) : undefined;
  active?.mark("selected");
}

export function sessionLoadTiming(threadId: string) {
  return active?.threadId === threadId ? active : undefined;
}
