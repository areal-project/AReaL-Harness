import { useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.js";
import type { Action, Data } from "./services.js";
import "./RsiGoal.css";

export type RsiCandidate = {
    id: string;
    label: string;
    harness: string;
    parentCandidateId?: string | null;
    round?: number;
    hypothesis?: string;
    feedback?: string;
    evaluations?: {
        rubricId: string;
        evaluator: string;
        taskId: string;
        artifactSha256: string;
        score?: number | null;
        checks: Record<string, boolean>;
        feedback: string;
        evidence: string[];
    }[];
    status: "queued" | "running" | "completed" | "failed" | "selected";
    workspaceMode: string;
    workspacePath: string | null;
    artifactPath: string | null;
    artifactSummary: string | null;
    runId: string;
    taskId: string;
    error: string | null;
    startedAt: number | null;
    finishedAt: number | null;
};
export type RsiState = {
    phase: "running" | "awaitingSelection" | "selected" | "failed";
    outputFormat?: string;
    candidates: RsiCandidate[];
    selectedCandidateId: string | null;
};
const statuses = {
    queued: "等待运行",
    running: "运行中",
    completed: "产物已就绪",
    failed: "失败",
    selected: "已选为 winner",
};
const phases = {
    running: "候选运行中",
    awaitingSelection: "请选择最佳产物",
    selected: "已保存 winner",
    failed: "全部候选失败",
};

export function RsiCandidateCard({
    candidate,
    goalId,
    project,
    thread,
    action,
    selectable,
    disabled,
    onSelect,
    onControl,
}: {
    candidate: RsiCandidate;
    goalId: string;
    project: Data;
    thread: Data;
    action: Action;
    selectable: boolean;
    disabled: boolean;
    onSelect: () => void;
    onControl: (operation: string, candidateId: string, extra?: Data) => Promise<void>;
}) {
    const [content, setContent] = useState<Uint8Array>(new Uint8Array());
    const [complete, setComplete] = useState(false),
        [busy, setBusy] = useState(false),
        [error, setError] = useState("");
    const [feedback, setFeedback] = useState("");
    const [hypothesis, setHypothesis] = useState("");
    const [harness, setHarness] = useState(candidate.harness);
    const [sha, setSha] = useState("");
    const [budgetExtension, setBudgetExtension] = useState("");
    const reading = useRef(false);
    const load = async () => {
        if (reading.current) return;
        reading.current = true;
        setBusy(true);
        setError("");
        try {
            const page = await action("manage", {
                projectId: project.id,
                threadId: thread.id,
                operation: "goalCandidateArtifact",
                goalId,
                candidateId: candidate.id,
                offset: content.length,
            });
            setSha(page.sha256);
            const chunk = Uint8Array.from(atob(page.dataBase64), (c) => c.charCodeAt(0));
            const next = new Uint8Array(content.length + chunk.length);
            next.set(content);
            next.set(chunk, content.length);
            setContent(next);
            setComplete(page.complete === true);
        } catch (cause) {
            setError((cause as Error).message);
        } finally {
            reading.current = false;
            setBusy(false);
        }
    };
    const ready = candidate.status === "completed" || candidate.status === "selected";
    return (
        <article
            id={`rsi-${candidate.id}`}
            className="rsi-candidate"
            data-status={candidate.status}
            aria-label={`${candidate.id} ${candidate.label}`}
        >
            <header>
                <strong>{candidate.label}</strong>
                <span role="status">{statuses[candidate.status]}</span>
            </header>
            <p className="rsi-id">
                {candidate.id} · {candidate.workspaceMode}
            </p>
            <details>
                <summary>Harness 与运行信息</summary>
                <p>{candidate.harness}</p>
                <dl>
                    <dt>Run</dt>
                    <dd>{candidate.runId}</dd>
                    <dt>Task</dt>
                    <dd>{candidate.taskId}</dd>
                    <dt>工作区</dt>
                    <dd>{candidate.workspacePath ?? "尚未分配"}</dd>
                    <dt>产物</dt>
                    <dd>{candidate.artifactPath ?? "尚未生成"}</dd>
                    <dt>开始 / 结束</dt>
                    <dd>
                        {candidate.startedAt == null
                            ? "—"
                            : new Date(candidate.startedAt * 1000).toLocaleString()}{" "}
                        /{" "}
                        {candidate.finishedAt == null
                            ? "—"
                            : new Date(candidate.finishedAt * 1000).toLocaleString()}
                    </dd>
                </dl>
            </details>
            {candidate.hypothesis && <p className="rsi-hypothesis">假设：{candidate.hypothesis}</p>}
            {!!candidate.evaluations?.length && (
                <details>
                    <summary>评测回执（{candidate.evaluations.length}）</summary>
                    {candidate.evaluations.map((evaluation, i) => (
                        <div className="rsi-evaluation" key={i}>
                            <strong>
                                {evaluation.rubricId} ·{" "}
                                {evaluation.score == null ? "定性反馈" : `${evaluation.score}/100`}
                            </strong>
                            <p>
                                {evaluation.evaluator} · {evaluation.taskId}
                            </p>
                            <p>{evaluation.feedback}</p>
                            <p>
                                {Object.entries(evaluation.checks)
                                    .map(([key, value]) => `${value ? "✓" : "✕"} ${key}`)
                                    .join(" · ")}
                            </p>
                            <code title={evaluation.artifactSha256}>
                                SHA256 {evaluation.artifactSha256.slice(0, 16)}…
                            </code>
                            <p>{evaluation.evidence.join("\n")}</p>
                        </div>
                    ))}
                </details>
            )}
            {candidate.error && (
                <p role="alert" className="text-destructive">
                    {candidate.error}
                </p>
            )}
            {ready && (
                <>
                    {content.length > 0 ? (
                        <pre className="rsi-artifact" aria-label={`${candidate.id} 产物内容`}>
                            {new TextDecoder().decode(content)}
                        </pre>
                    ) : (
                        candidate.artifactSummary && (
                            <pre className="rsi-artifact">{candidate.artifactSummary}</pre>
                        )
                    )}
                    <div className="rsi-actions">
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={busy || complete || !project.state?.connected}
                            onClick={() => void load()}
                        >
                            {busy
                                ? "读取中…"
                                : content.length
                                  ? complete
                                      ? "已读取全部产物"
                                      : "继续读取"
                                  : "查看产物"}
                        </Button>
                        <Button size="sm" disabled={disabled || !selectable} onClick={onSelect}>
                            {candidate.status === "selected"
                                ? selectable
                                    ? "保留 incumbent"
                                    : "已保存 winner"
                                : "选择此产物"}
                        </Button>
                    </div>
                </>
            )}
            {(ready || candidate.status === "failed") && (
                <details className="rsi-evolve-form">
                    <summary>评测反馈与版本分叉</summary>
                    <p>
                        {candidate.status === "failed"
                            ? "以执行错误为反馈修改 Harness；预算不足时可显式追加累计上限。"
                            : "先读取产物并记录评测，再修改 Harness。"}
                        新版本从冻结输入重新执行。
                    </p>
                    <label>
                        评测反馈
                        <textarea
                            aria-label={`${candidate.id} 评测反馈`}
                            value={feedback}
                            onChange={(e) => setFeedback(e.target.value)}
                            maxLength={8000}
                        />
                    </label>
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={disabled || !sha || !feedback.trim()}
                        onClick={() =>
                            void onControl("goalEvaluateCandidate", candidate.id, {
                                evaluation: {
                                    rubricId: "human-feedback-v1",
                                    evaluator: "human",
                                    taskId: goalId,
                                    artifactSha256: sha,
                                    checks: {},
                                    score: null,
                                    feedback,
                                    evidence: [],
                                },
                            })
                        }
                    >
                        记录评测
                    </Button>
                    <label>
                        追加累计 token 上限（可选）
                        <input
                            type="number"
                            min="1"
                            aria-label={`${candidate.id} token 上限`}
                            value={budgetExtension}
                            onChange={(e) => setBudgetExtension(e.target.value)}
                        />
                    </label>
                    <label>
                        改动假设
                        <textarea
                            aria-label={`${candidate.id} 改动假设`}
                            value={hypothesis}
                            onChange={(e) => setHypothesis(e.target.value)}
                            maxLength={2000}
                        />
                    </label>
                    <label>
                        新版 Harness
                        <textarea
                            aria-label={`${candidate.id} 新版 Harness`}
                            value={harness}
                            onChange={(e) => setHarness(e.target.value)}
                            maxLength={16000}
                        />
                    </label>
                    <Button
                        size="sm"
                        disabled={
                            disabled ||
                            (!candidate.evaluations?.length && candidate.status !== "failed") ||
                            !hypothesis.trim() ||
                            !feedback.trim() ||
                            harness.trim() === candidate.harness.trim() ||
                            (candidate.round ?? 0) >= 3
                        }
                        onClick={() =>
                            void onControl("goalEvolve", candidate.id, {
                                parentCandidateId: candidate.id,
                                ...(budgetExtension
                                    ? { tokenBudget: Number(budgetExtension) }
                                    : {}),
                                feedback,
                                variants: [
                                    {
                                        label: `revision-${(candidate.round ?? 0) + 1}`,
                                        hypothesis,
                                        harness,
                                    },
                                ],
                            })
                        }
                    >
                        从此版本分叉
                    </Button>
                </details>
            )}
            {error && (
                <p role="alert" className="text-destructive">
                    {error}
                </p>
            )}
        </article>
    );
}

export function RsiVersionTree({ rsi }: { rsi: RsiState }) {
    const nodes = (parent: string | null) =>
        rsi.candidates
            .filter((c) => (c.parentCandidateId ?? null) === parent)
            .map((c) => (
                <li key={c.id} role="treeitem" aria-label={`${c.id} ${c.label}`}>
                    <a href={`#rsi-${c.id}`}>
                        <code>{c.id}</code> <strong>{c.label}</strong>{" "}
                        <span>
                            R{c.round ?? 0} · {statuses[c.status]}
                            {rsi.selectedCandidateId === c.id ? " · incumbent" : ""}
                        </span>
                    </a>
                    {c.hypothesis && <p>{c.hypothesis}</p>}
                    {!!c.evaluations?.length && (
                        <small>
                            {c.evaluations.at(-1)?.rubricId} ·{" "}
                            {c.evaluations.at(-1)?.score == null
                                ? "已有评测"
                                : `${c.evaluations.at(-1)?.score}/100`}
                        </small>
                    )}
                    {rsi.candidates.some((child) => child.parentCandidateId === c.id) && (
                        <ul role="group">{nodes(c.id)}</ul>
                    )}
                </li>
            ));
    return (
        <nav className="rsi-version-tree" aria-label="Harness 版本探索树">
            <p>Harness 版本探索树 · {rsi.candidates.length}/12</p>
            <ul role="tree">{nodes(null)}</ul>
        </nav>
    );
}

export function RsiGoal({
    project,
    thread,
    action,
}: {
    project: Data;
    thread: Data;
    action: Action;
}) {
    const goal = thread.goals?.goal;
    const rsi = goal?.rsi as RsiState | undefined;
    const [busy, setBusy] = useState(false),
        [error, setError] = useState("");
    const locked = useRef(false);
    useEffect(() => {
        if (rsi?.phase !== "running") return;
        let cancelled = false,
            reading = false;
        const refresh = async () => {
            if (reading || cancelled) return;
            reading = true;
            try {
                await action("manage", {
                    projectId: project.id,
                    threadId: thread.id,
                    operation: "goal",
                });
            } catch {
                /* 连接错误由项目重连界面展示。 */
            } finally {
                reading = false;
            }
        };
        void refresh();
        const timer = window.setInterval(() => void refresh(), 1000);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
        };
    }, [action, project.id, thread.id, rsi?.phase]);
    if (!goal || !rsi) return null;
    const disabled =
        busy ||
        goal.settling ||
        !project.state?.connected ||
        thread.desktop?.archived ||
        project.pending?.some((p: Data) => p.params?.threadId === thread.id);
    const control = async (operation: string, candidateId?: string, extra: Data = {}) => {
        if (locked.current || disabled) return;
        locked.current = true;
        setBusy(true);
        setError("");
        try {
            await action("manage", {
                projectId: project.id,
                threadId: thread.id,
                operation,
                goalId: goal.id,
                expectedRevision: thread.goals.revision,
                ...(candidateId ? { candidateId } : {}),
                ...extra,
            });
        } catch (cause) {
            setError(`操作未确认，请刷新核对后重试。${(cause as Error).message}`);
        } finally {
            locked.current = false;
            setBusy(false);
        }
    };
    return (
        <section className="rsi-goal" data-testid="rsi-goal" aria-label="RSI 产物对比">
            <header>
                <strong>RSI 产物对比</strong>
                <span role="status">{phases[rsi.phase]}</span>
            </header>
            <p>{goal.objective}</p>
            <p className="rsi-notice">
                冻结输入 · 反馈分叉 · 最多 12 个版本 / 深度 3 · 评测由调用方提供
            </p>
            <RsiVersionTree rsi={rsi} />
            <div className="rsi-candidates">
                {rsi.candidates.map((candidate) => (
                    <RsiCandidateCard
                        key={`${goal.id}:${candidate.id}`}
                        candidate={candidate}
                        goalId={goal.id}
                        project={project}
                        thread={thread}
                        action={action}
                        disabled={disabled || rsi.phase === "running"}
                        onControl={control}
                        selectable={rsi.phase === "awaitingSelection"}
                        onSelect={() => void control("goalSelectCandidate", candidate.id)}
                    />
                ))}
            </div>
            {rsi.selectedCandidateId && (
                <p role="status">
                    Winner：{rsi.selectedCandidateId}。产物与运行记录已保存，可继续查看。
                </p>
            )}
            {error && (
                <p role="alert" className="text-destructive">
                    {error}
                </p>
            )}
            <footer>
                <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => void control("goal")}
                >
                    刷新状态
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled || rsi.phase === "running"}
                    onClick={() => void control("goalClear")}
                >
                    清除目标
                </Button>
            </footer>
        </section>
    );
}
