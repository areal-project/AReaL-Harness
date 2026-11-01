import type { Data } from "./services.js";

export type RetryProgress = {
  id: string;
  attempts: number;
  state: "waiting" | "retrying" | "recovered" | "exhausted" | "stopped";
  delayMs?: number;
};

export function retryProgress(turn: Data): RetryProgress[] {
  const requests = new Map<string, Data[]>();
  for (const activity of turn.trace?.activities ?? []) {
    if (!activity.logicalId || !["model", "retryWait"].includes(activity.kind)) continue;
    const entries = requests.get(activity.logicalId) ?? [];
    entries.push(activity);
    requests.set(activity.logicalId, entries);
  }
  return [...requests].flatMap(([id, entries]) => {
    const models = entries.filter((entry) => entry.kind === "model");
    const last = entries.at(-1)!;
    const model = models.at(-1);
    if (
      !entries.some((entry) => entry.kind === "retryWait" || entry.retryDisposition === "exhausted")
    )
      return [];
    const state =
      model?.status === "completed" && last === model
        ? "recovered"
        : last.retryDisposition === "exhausted" && turn.status !== "inProgress"
          ? "exhausted"
          : turn.status !== "inProgress"
            ? "stopped"
            : last.kind === "retryWait" && last.status === "running"
              ? "waiting"
              : "retrying";
    return [{ id, attempts: models.length, state, delayMs: last.retryDelayMs }];
  });
}
