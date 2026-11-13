import { useEffect, useRef, useState } from "react";
import { DraftComposer } from "../DraftComposer.js";
import { Composer } from "../Composer.js";
import { Messages } from "../Messages.js";
import type { Action, Data } from "../services.js";

// 隔离界面驱动回执和权威快照的顺序，发送仍经过真实 Composer。
export function SendContinuityFixture() {
  const [turns, setTurns] = useState<Data[]>([]);
  const [sequence, setSequence] = useState(0);
  const [opened, setOpened] = useState(false);
  const [phase, setPhase] = useState("ready");
  const pending = useRef<
    { resolve: () => void; text: string; index: number; attachments: Data[] } | undefined
  >(undefined);
  const mediaRelease = useRef<(() => void) | undefined>(undefined);
  const mediaGate = useRef<Promise<void> | undefined>(undefined);
  if (!mediaGate.current)
    mediaGate.current = new Promise((resolve) => {
      mediaRelease.current = resolve;
    });
  useEffect(() => {
    let frame = 0;
    const samples: Data[] = [];
    const markers: Data[] = [];
    const mark = (event: Event) => {
      if (event.type === "keydown" && (event as KeyboardEvent).key !== "Enter") return;
      markers.push({
        type: event.type,
        time: performance.now(),
        target: (event.target as Element | null)?.getAttribute("data-testid"),
      });
      document
        .querySelector("[data-send-continuity]")
        ?.setAttribute("data-send-markers", JSON.stringify(markers));
    };
    document.addEventListener("click", mark, true);
    document.addEventListener("keydown", mark, true);
    const sample = () => {
      const root = document.querySelector("[data-send-continuity]");
      const reader = root?.querySelector(".messages");
      const pending = root?.querySelector('[data-testid="pending-message"]');
      const user = root?.querySelector(
        `[data-side-item-id="user-${root.getAttribute("data-sequence")}"]`,
      );
      const old = root?.querySelector('[data-side-item-id="answer-1"]');
      if (root) {
        const viewport = reader?.getBoundingClientRect();
        const bubble = pending?.querySelector(".user-bubble");
        const composer = root.querySelector(".composer-editor");
        const visible = (element: Element | null | undefined) => {
          const rect = element?.getBoundingClientRect();
          return !!rect && !!viewport && rect.bottom > viewport.top && rect.top < viewport.bottom;
        };
        samples.push({
          phase: root.getAttribute("data-send-continuity"),
          time: performance.now(),
          top: reader?.scrollTop,
          scrollHeight: reader?.scrollHeight,
          viewportY: viewport?.top,
          viewportHeight: viewport?.height,
          composerY: composer?.getBoundingClientRect().top,
          composerHeight: composer?.getBoundingClientRect().height,
          focus: document.activeElement?.getAttribute("data-testid"),
          pendingText: pending?.textContent,
          pendingHTML: bubble?.innerHTML,
          pendingParagraphWhiteSpace: bubble?.querySelector("p")
            ? getComputedStyle(bubble.querySelector("p")!).whiteSpace
            : undefined,
          pendingY: pending?.getBoundingClientRect().top,
          pendingBubbleY: bubble?.getBoundingClientRect().top,
          pendingBubbleHeight: bubble?.getBoundingClientRect().height,
          userY: user?.getBoundingClientRect().top,
          userBubbleY: user?.querySelector(".user-bubble")?.getBoundingClientRect().top,
          oldVisible: visible(old),
          userVisible: visible(user),
          pendingVisible: visible(pending),
        });
        if (samples.length > 1200) samples.shift();
        root.setAttribute("data-send-frames", JSON.stringify(samples));
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("click", mark, true);
      document.removeEventListener("keydown", mark, true);
    };
  }, []);
  const thread = { id: "send-continuity", turns };
  const config = {
    revision: 0,
    model: { providerId: "fixture", modelId: "model" },
    options: {},
    parameters: {},
  };
  const project = {
    id: "send-continuity-project",
    root: "/fixture",
    name: "Fixture",
    pending: [],
    outcomes: {},
    profiles: [],
    models: [
      {
        providerId: "fixture",
        providerRevision: 1,
        isDefault: true,
        modelId: "model",
        available: true,
        displayName: "Fixture",
      },
    ],
    configurations: { [thread.id]: config },
    state: { connected: true, threads: { [thread.id]: thread }, interactions: {}, queues: {} },
  };
  const action = (async (name: string, params: Data) => {
    if (name === "media" && params.operation === "upload")
      return { uri: "areal://blob/image", mimeType: "image/png" };
    if (name === "media" && params.operation === "read") {
      await mediaGate.current;
      return {
        mime: "image/png",
        bytes: Array.from(
          Uint8Array.from(
            atob(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXcAAAAASUVORK5CYII=",
            ),
            (c) => c.charCodeAt(0),
          ),
        ),
      };
    }
    if (name === "create") return { threadId: thread.id };
    if (name !== "send") return {};
    const index = sequence + 1;
    const text = params.text;
    setSequence(index);
    setPhase("sending");
    await new Promise<void>((resolve) => {
      pending.current = { resolve, text, index, attachments: params.attachments ?? [] };
    });
    setPhase("receipt");
    return { threadId: thread.id };
  }) as Action;
  const snapshot = () => {
    const request = pending.current;
    if (!request) return;
    setTurns((previous) => [
      ...previous,
      {
        id: `turn-${request.index}`,
        status: "inProgress",
        items: [
          {
            id: `user-${request.index}`,
            type: "userMessage",
            createdAt: 1793692800,
            content: [{ type: "text", text: request.text }, ...request.attachments],
          },
        ],
      },
    ]);
    setPhase("snapshot");
  };
  const complete = () =>
    setTurns((previous) =>
      previous.map((turn, index) =>
        index !== previous.length - 1
          ? turn
          : {
              ...turn,
              status: "completed",
              items: [
                ...turn.items,
                {
                  id: `answer-${sequence}`,
                  type: "agentMessage",
                  phase: "final_answer",
                  text: `ANSWER ${sequence} `.repeat(100),
                },
              ],
            },
      ),
    );
  return (
    <section data-send-continuity={phase} data-sequence={sequence}>
      <div>
        <button onClick={() => pending.current?.resolve()}>Release receipt</button>
        <button onClick={snapshot}>Deliver snapshot</button>
        <button onClick={complete}>Complete turn</button>
        <button onClick={() => mediaRelease.current?.()}>Release media</button>
      </div>
      <section
        className={`conversation-pane ${opened ? "" : "draft-pane"}`}
        style={{ height: 520 }}
      >
        {!opened && <div className="draft-greeting">Fixture</div>}
        {opened && (
          <Messages
            project={project}
            thread={thread}
            action={action}
            dark={false}
            readTurnReview={async () => ({})}
            onLink={() => {}}
            onFile={() => {}}
            onReview={() => {}}
          />
        )}
        <div className={opened ? "active-composer" : "draft-composer"}>
          {opened ? (
            <Composer
              project={project}
              thread={thread}
              action={action}
              executionBlocked={false}
              onPanel={() => {}}
              onNew={() => {}}
            />
          ) : (
            <DraftComposer
              project={project}
              action={action}
              readAction={action}
              backendReady
              modelCatalogReady
              onOpen={async () => setOpened(true)}
              onPanel={() => {}}
            />
          )}
        </div>
      </section>
    </section>
  );
}
