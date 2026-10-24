import { ComposerActionButton } from "@areal/ui/wip";
import { useCallback, useEffect, useRef, useState } from "react";
import { Messages } from "../Messages.js";
import { ConversationComposer } from "../ConversationComposer.js";
import { AgentConversationPane } from "../AgentConversationPane.js";
import { Button } from "../components/ui/button.js";
import { CloseIcon, StopIcon } from "../interfaceIcons.js";
import type { LexicalChatInputHandle } from "../LexicalChatInput.js";
import type { Action, Data } from "../services.js";
import {
    childId,
    history,
    imageSvg,
    imageUri,
    lastStep,
    scenarioProjection,
    scenarioPrompt,
    stages,
} from "./conversationScenario.js";

/** Only fixture arrival and panel selection live here. Production components own
 * process projection, child rendering, image dialogs, disclosure and reading. */
export function ConversationFlowExercise({ dark }: { dark: boolean }) {
    const [generation, setGeneration] = useState(0);
    const [step, setStep] = useState(0);
    const [startedAt, setStartedAt] = useState(0);
    const [prompt, setPrompt] = useState(scenarioPrompt);
    const [draft, setDraft] = useState(scenarioPrompt);
    const [exception, setException] = useState("");
    const [playing, setPlaying] = useState(true);
    const [stopped, setStopped] = useState(false);
    const [panel, setPanel] = useState("");
    const [calls, setCalls] = useState<string[]>([]);
    const api = useRef<LexicalChatInputHandle | null>(null);
    const threadId = `flow-preview-${generation}`;
    const running = step > 0 && step < lastStep && !exception && !stopped;
    const { turn, child } = scenarioProjection(step, threadId, prompt, startedAt, exception);
    if (stopped) {
        turn.status = "interrupted";
        child.turns[0].status = "interrupted";
    }
    const thread = { id: threadId, turns: step ? [history, turn] : [history] };
    const project = {
        id: "flow-project",
        root: "/validation/zeebo-bot",
        models: [{ providerId: "preview", modelId: "scenario", displayName: "本地场景" }],
        configurations: {},
        state: {
            connected: true,
            threads: step >= 2 ? { [childId]: child } : {},
            interactions: {},
            queues: {},
        },
    };
    const action = useCallback(
        (async (name: string, params: Data) => {
            if (name === "feedback" && params.operation === "status") {
                setCalls((previous) => [...previous, "feedback:status"]);
                return { enabled: false, connected: false, opted_in: false };
            }
            setCalls((previous) => [...previous, `${name}:${params.threadId ?? ""}`]);
            if (name === "media" && params.operation === "read" && params.uri === imageUri)
                return { bytes: new TextEncoder().encode(imageSvg), mime: "image/svg+xml" };
            if (name === "open" && params.threadId === childId) return {};
            throw Error("本地演示不连接Core；保留原状态，不执行或重放。");
        }) as Action,
        [],
    );
    useEffect(() => {
        if (!running || !playing) return;
        const timer = setTimeout(
            () => setStep((value) => Math.min(lastStep, value + 1)),
            step >= 7 ? 1400 : 3200,
        );
        return () => clearTimeout(timer);
    }, [step, running, playing]);
    const reset = () => {
        setGeneration((value) => value + 1);
        setStep(0);
        setException("");
        setStopped(false);
        setPanel("");
        setDraft(scenarioPrompt);
        setCalls([]);
        api.current?.setText(scenarioPrompt);
    };
    const openAgent = (id: string) => {
        if (id === childId) setPanel(id);
    };
    return (
        <section
            id="conversation-flow-exercise"
            className="design-preview-panel design-preview-flow-panel"
            aria-label="动态信息流题"
            data-scenario-step={step}
            data-playing={playing}
        >
            <h2>动态信息流 · 复合任务</h2>
            <p>
                本地演示：读取清单、命令增量、并行子代理、图片查看和最终汇总。发送后自动推进，可暂停逐状态检查。
            </p>
            <div className="design-preview-actions">
                <Button variant="outline" onClick={reset}>
                    重置题目
                </Button>
                <Button variant="outline" onClick={() => setPlaying((value) => !value)}>
                    {playing ? "暂停演示" : "继续演示"}
                </Button>
                <Button
                    variant="outline"
                    disabled={!running}
                    onClick={() => setStep((value) => Math.min(lastStep, value + 1))}
                >
                    下一事件
                </Button>
                <Button variant="ghost" disabled={!running} onClick={() => setStep(lastStep)}>
                    投影完成
                </Button>
            </div>
            <p role="status" aria-label="演示阶段">
                {stopped
                    ? "演示已停止；重置后可重新开始"
                    : exception
                      ? `${exception}反例`
                      : `${step} / ${lastStep} · ${stages[step]}`}
            </p>
            <div className="design-preview-flow-workspace" data-panel-open={!!panel}>
                <div className="design-preview-flow-chat" aria-label="主对话">
                    <div className="design-preview-flow-toolbar">
                        <span>只读验证 · zeebo-bot</span>
                        {step >= 2 && (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => openAgent(childId)}
                                aria-label="打开子代理面板"
                            >
                                子代理 · 1 {stopped ? "已中断" : step >= 6 ? "已完成" : "执行中"}
                            </Button>
                        )}
                    </div>
                    <Messages
                        key={threadId}
                        project={project}
                        thread={thread}
                        action={action}
                        dark={dark}
                        onLink={() => {}}
                        onFile={() => {}}
                        onReview={() => {}}
                        onAgent={openAgent}
                        readTurnReview={async () => ({})}
                    />
                    <div className="composer-dock">
                        <ConversationComposer
                            project={project}
                            modelConfig={{ model: { providerId: "preview", modelId: "scenario" } }}
                            modelDisabled
                            onConfigureModel={() => {}}
                            initialValue={draft}
                            inputApiRef={api}
                            inputTestId="flow-composer"
                            taskId={threadId}
                            workspacePath="/validation/zeebo-bot"
                            placeholder={stopped ? "重置题目以重新开始" : "输入验证任务"}
                            submitLabel="发送"
                            disabled={running || stopped}
                            submitDisabled={running || stopped || !draft.trim()}
                            enableMentionPanel={false}
                            enterSubmits
                            onChange={setDraft}
                            submitControl={
                                running ? (
                                    <ComposerActionButton
                                        type="button"
                                        size="icon"
                                        aria-label="停止演示任务"
                                        onClick={() => {
                                            setStopped(true);
                                            setPlaying(false);
                                        }}
                                    >
                                        <StopIcon />
                                    </ComposerActionButton>
                                ) : undefined
                            }
                            onSubmit={(value) => {
                                if (running || stopped || !value.trim()) return false;
                                if (step) {
                                    setGeneration((n) => n + 1);
                                    setPanel("");
                                    setException("");
                                    setCalls([]);
                                }
                                setPrompt(value);
                                setStartedAt(Math.floor(Date.now() / 1000));
                                setStep(1);
                                setDraft("");
                                api.current?.setText("");
                            }}
                        />
                    </div>
                </div>
                {panel && (
                    <aside className="design-preview-flow-context" aria-label="子代理面板">
                        <div className="design-preview-flow-toolbar">
                            <span>子代理</span>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label="返回主对话"
                                onClick={() => setPanel("")}
                            >
                                <CloseIcon />
                            </Button>
                        </div>
                        <AgentConversationPane
                            key={`${threadId}:${panel}`}
                            project={project}
                            parentId={threadId}
                            childId={panel}
                            action={action}
                            dark={dark}
                            onLink={() => {}}
                            onFile={() => {}}
                            onReview={() => {}}
                            onAgent={openAgent}
                        />
                    </aside>
                )}
            </div>
            <details className="design-preview-flow-diagnostics">
                <summary>反例与本地记录</summary>
                <div className="design-preview-actions">
                    {["失败", "未知", "未结算"].map((value) => (
                        <Button
                            key={value}
                            variant="ghost"
                            onClick={() => {
                                setGeneration((n) => n + 1);
                                setException(value);
                                setStopped(false);
                                setPanel("");
                                setStep(lastStep);
                                setCalls([]);
                            }}
                        >
                            {value}反例
                        </Button>
                    ))}
                </div>
                <output aria-label="本地调用记录">{calls.join(", ") || "无Core调用"}</output>
            </details>
        </section>
    );
}
