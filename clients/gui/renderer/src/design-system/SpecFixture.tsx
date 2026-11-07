import { useLayoutEffect, useMemo, useState } from "react";
import fixture from "../../../../../design/spec/fixtures/send-run-stop.json";
import { Composer } from "../Composer.js";
import { ConversationDraftEmptyState } from "../ConversationDraftEmptyState.js";
import { DraftComposer } from "../DraftComposer.js";
import { Messages } from "../Messages.js";
import type { Action, Data } from "../services.js";
import { useAppearance } from "../settings/applicationPreferences.js";

// design/spec 的复现入口：?spec&state=<flow 状态>&theme=light|dark。示例数据只在这里翻译成本仓库的数据形状。
type Conversation = (typeof fixture.conversations)[keyof typeof fixture.conversations];
type FixtureTurn = Conversation["turns"][number] & { answer?: string };

const projectId = "spec-project";
const threadId = "spec-thread";
const STATUS: Record<string, string> = {
  running: "inProgress",
  completed: "completed",
  stopped: "interrupted",
};

function turn(source: FixtureTurn, index: number): Data {
  const items: Data[] = [
    {
      id: `user-${index}`,
      type: "userMessage",
      createdAt: 1793692800 + index,
      content: [{ type: "text", text: source.user }],
    },
    ...source.process.map((text, step) => ({
      id: `step-${index}-${step}`,
      type: "agentMessage",
      phase: "commentary",
      text,
    })),
  ];
  if (source.answer)
    items.push({
      id: `answer-${index}`,
      type: "agentMessage",
      phase: "final_answer",
      text: source.answer,
    });
  return {
    id: `turn-${index}`,
    status: STATUS[source.status],
    ...(source.status === "stopped" ? { interruption: "userPause" } : {}),
    items,
  };
}

function project(turns: Data[], queue: string[]): Data {
  const thread = { id: threadId, title: "", turns };
  return {
    id: projectId,
    root: `/${fixture.project.name}`,
    name: fixture.project.name,
    core: { instanceId: "spec", connectionGeneration: 1, features: { permissionPresets: true } },
    pending: [],
    outcomes: {},
    profiles: [],
    models: [
      {
        providerId: "spec",
        providerRevision: 1,
        isDefault: true,
        modelId: "model",
        available: true,
        displayName: fixture.project.model,
      },
    ],
    configurations: {
      [threadId]: {
        revision: 0,
        model: { providerId: "spec", modelId: "model" },
        options: {},
        parameters: {},
      },
    },
    state: {
      connected: true,
      threads: { [threadId]: thread },
      interactions: {},
      queues: {
        [threadId]: {
          revision: 0,
          items: queue.map((text, index) => ({
            id: `queued-${index}`,
            status: "pending",
            input: [{ type: "text", text }],
          })),
        },
      },
    },
  };
}

export function SpecFixture() {
  const params = new URLSearchParams(window.location.search);
  const dark = params.get("theme") === "dark";
  const start =
    fixture.states[(params.get("state") ?? "home.empty") as keyof typeof fixture.states] ??
    fixture.states["home.empty"];
  const initial =
    "conversation" in start
      ? fixture.conversations[start.conversation as keyof typeof fixture.conversations]
      : undefined;
  useState(() => {
    if (start.draft) localStorage.setItem(`areal-gui:draft:${projectId}:new`, start.draft);
  });
  const [opened, setOpened] = useState(start.screen === "thread");
  const [turns, setTurns] = useState<Data[]>(() => (initial?.turns ?? []).map(turn));
  const [queue, setQueue] = useState<string[]>(() => ("queue" in start ? start.queue : []));
  useAppearance(dark);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.classList.toggle("theme-areal-light", !dark);
    root.classList.toggle("theme-areal-dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
  }, [dark]);
  const data = useMemo(() => project(turns, queue), [turns, queue]);
  const thread = data.state.threads[threadId];
  const action = (async (name: string, request: Data) => {
    const reject = (fixture.agent.rejects as Record<string, string>)[request?.text?.trim()];
    if (reject && (name === "send" || name === "create")) throw new Error(reject);
    if (name === "create") return { threadId };
    if (name === "send" && request.enqueue) {
      setQueue((items) => [...items, request.text]);
      return { threadId };
    }
    if (name === "send" || name === "continue") {
      setTurns((items) => [
        ...items,
        turn(
          {
            status: "running",
            user: name === "send" ? request.text : (items.at(-1)?.items[0].content[0].text ?? ""),
            process: [fixture.agent.firstStep],
          },
          items.length,
        ),
      ]);
      return { threadId };
    }
    if (name === "stop") {
      setTurns((items) =>
        items.map((item) =>
          item.status === "inProgress"
            ? { ...item, status: "interrupted", interruption: "userPause" }
            : item,
        ),
      );
      return {};
    }
    if (name === "manage" && request.operation === "context") {
      const { usedTokens, windowTokens } = fixture.project.context;
      const basis = {
        provider: "spec",
        model: "model",
        configurationRevision: 0,
        defaultModelRevision: null,
        turnId: null,
      };
      return {
        threadId,
        contextUsage: {
          kind: "ready",
          basis,
          budget: {
            windowTokens,
            outputReserveTokens: 0,
            inputLimitTokens: windowTokens,
            windowSource: "model",
          },
          scope: { kind: "recordedHistory" },
          estimate: {
            tokens: usedTokens,
            parts: [{ kind: "conversation", name: "对话", estimatedTokens: usedTokens }],
          },
        },
        sessionUsage: {
          usage: null,
          generation: {
            outputTokens: 0,
            durationMs: 0,
            measuredRequests: 0,
            unmeasuredRequests: 0,
            usageRequests: 0,
            missingUsageRequests: 0,
          },
          knownTurns: 0,
          unknownTurns: 0,
          partialTurns: 0,
          scope: "ownTurns",
        },
      };
    }
    if (name === "queue") return data.state.queues[threadId];
    if (name === "tasks") return { tasks: [] };
    return {};
  }) as Action;
  return (
    <div className="workspace-content" data-spec-fixture style={{ height: "100dvh" }}>
      <div className="conversation-column">
        <section className={`conversation-pane ${opened ? "" : "draft-pane"}`}>
          {opened ? (
            <>
              <Messages
                project={data}
                thread={thread}
                action={action}
                dark={dark}
                decisionShown
                readTurnReview={async () => ({})}
                onLink={() => {}}
                onFile={() => {}}
                onReview={() => {}}
              />
              <div className="active-composer">
                <Composer
                  project={data}
                  thread={thread}
                  action={action}
                  readAction={action}
                  executionBlocked={false}
                  onPanel={() => {}}
                  onNew={() => {}}
                />
              </div>
            </>
          ) : (
            <>
              <div className="draft-greeting">
                <ConversationDraftEmptyState projectName={fixture.project.name} />
              </div>
              <div className="draft-composer">
                <DraftComposer
                  project={data}
                  action={action}
                  readAction={action}
                  backendReady
                  modelCatalogReady
                  onOpen={async () => setOpened(true)}
                  onPanel={() => {}}
                />
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
