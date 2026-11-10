import { browserAnnotationTitle } from "../browserAnnotations.js";
import { conversationUserState } from "./userStates.js";
import { imageAnnotationTitle } from "../imageAnnotations.js";
import type { Data } from "../services.js";

// 侧栏只列用户能认出的对话：没有标题、没有用户消息的空对话（创建后没发出第一条）不进列表，
// 当前打开的除外。判断只用摘要本身，项目未启动时与启动后结果一致。
export function conversationCatalog(
  projects: Data[],
  library: Data,
  open?: { projectId: string; threadId: string },
) {
  const title = (owner: Data, summary: Data) =>
    library.threads?.[`${owner.id}:${summary.id}`]?.title ||
    owner.state?.threads[summary.id]?.name ||
    summary.name ||
    imageAnnotationTitle(
      browserAnnotationTitle(
        owner.state?.threads[summary.id]?.turns
          ?.flatMap((t: Data) => t.items ?? [])
          .find((i: Data) => i.type === "userMessage")
          ?.content?.find((p: Data) => p.type === "text")?.text ||
          summary.preview ||
          "新对话",
      ),
    );
  return projects.flatMap((owner) => {
    const scheduledThreads = new Set(
      (Object.values(owner.state?.tasks ?? {}) as Data[])
        .filter((task) => task.mode === "scheduled")
        .flatMap((task) =>
          [task.threadId, ...task.runs.map((run: Data) => run.threadId)].filter(
            // 对话里建的任务接在来源对话里运行，来源对话仍是普通对话。
            (id) => id && id !== task.sourceThreadId,
          ),
        ),
    );
    const cached = library.projects?.[owner.id]?.navigationSummaries;
    const knownIds = Object.keys(library.threads ?? {}).filter((key) =>
      key.startsWith(`${owner.id}:`),
    );
    const navigation =
      owner.summariesLoaded === false
        ? Array.isArray(cached)
          ? cached
          : knownIds.map((key) => ({ id: key.slice(owner.id.length + 1) }))
        : (owner.summaries ?? []);
    const map = new Map<string, Data>(navigation.map((s: Data) => [s.id, s]));
    for (const t of Object.values(owner.state?.threads ?? {}) as Data[])
      if (!map.has(t.id)) map.set(t.id, t);
    return [...map.values()]
      .filter((summary) => {
        const live = owner.state?.threads[summary.id];
        const opened = open?.projectId === owner.id && open?.threadId === summary.id;
        const blank =
          !library.threads?.[`${owner.id}:${summary.id}`]?.title &&
          !summary.name &&
          !summary.preview &&
          !live?.name &&
          !live?.turns?.some((turn: Data) => turn.items?.length || turn.status === "inProgress");
        return (
          (opened || !blank) &&
          !scheduledThreads.has(summary.id) &&
          !(
            owner.configurations?.[summary.id]?.options?.appendInstructions ??
            live?.desktop?.configuration?.options?.appendInstructions
          )?.startsWith("AREAL_TASK_DRAFT_V1\n") &&
          !live?.parentThreadId &&
          !summary.parentThreadId &&
          live?.conversation?.kind !== "side" &&
          summary.conversation?.kind !== "side"
        );
      })
      .map((summary) => {
        const t = owner.state?.threads[summary.id];
        const status = conversationUserState(owner, summary.id, t);
        return {
          owner,
          summary,
          title: title(owner, summary),
          activityRank: (() => {
            const order = library.projects?.[owner.id]?.threadOrder ?? [];
            const rank = order.indexOf(summary.id);
            return rank < 0 ? order.length : rank;
          })(),
          updatedAt: Math.max(
            summary.updatedAt ?? summary.createdAt ?? 0,
            t?.updatedAt ?? t?.createdAt ?? 0,
          ),
          archived: t?.desktop?.archived || summary.desktop?.archived,
          pinned: !!library.threads?.[`${owner.id}:${summary.id}`]?.pinned,
          unread: !!library.threads?.[`${owner.id}:${summary.id}`]?.unread,
          // 未启动的项目没有在跑的东西，不画"加载中"；只有已连接但摘要还没到时才算待定。
          statePending: owner.state?.connected === true && owner.summariesLoaded === false,
          status,
          running: status.kind === "working",
          attention: status.kind === "needsYou",
        };
      });
  });
}
