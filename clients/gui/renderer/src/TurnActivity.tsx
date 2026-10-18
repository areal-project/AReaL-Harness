import { useEffect, useState } from "react";
import { activityLabel } from "./conversationPresentation.js";
import type { Data } from "./services.js";
/** Elapsed time measures this mounted view, not hidden model reasoning or server duration. */
export function TurnActivity({
  project,
  threadId,
  turn,
}: {
  project: Data;
  threadId: string;
  turn: Data;
}) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [turn.id]);
  const label = activityLabel(project, threadId, turn);
  return (
    <div className="turn-activity" data-testid="turn-activity">
      <span
        role="status"
        aria-live="polite"
        className={project.state?.connected && !project.state?.interactions?.[threadId]?.data?.some((item: Data) => item.status === "pending") ? "turn-thinking" : undefined}
      >
        {label}
      </span>
      {seconds >= 5 && (
        <span className="activity-elapsed" title="从打开本次执行视图起计时">
          {seconds} 秒
        </span>
      )}
    </div>
  );
}
