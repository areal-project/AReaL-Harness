import { browserAnnotationTitle } from "../browserAnnotations.js";
import { imageAnnotationTitle } from "../imageAnnotations.js";
import type { Data } from "../services.js";

export function conversationCatalog(projects: Data[], library: Data) {
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
          : knownIds.map((key) => ({ id: key.slice(owner.id.length + 1), preview: "未加载的任务" }))
        : (owner.summaries ?? []);
    const map = new Map<string, Data>(navigation.map((s: Data) => [s.id, s]));
    for (const t of Object.values(owner.state?.threads ?? {}) as Data[])
      if (!map.has(t.id)) map.set(t.id, t);
    return [...map.values()]
      .filter((summary) => {
        const live = owner.state?.threads[summary.id];
        return (
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
          statePending: owner.summariesLoaded === false || owner.state?.connected === false,
          running: owner.state?.connected && t?.turns?.some((t: Data) => t.status === "inProgress"),
          attention:
            owner.state?.connected &&
            owner.state?.interactions[summary.id]?.data?.some((i: Data) => i.status === "pending"),
        };
      });
  });
}
