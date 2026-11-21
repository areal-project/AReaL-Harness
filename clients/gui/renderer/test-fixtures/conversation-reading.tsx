import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Messages } from "../src/Messages";
import { ApplicationIntlProvider } from "../src/i18n/IntlProvider";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { PlatformReadProvider } from "../src/PlatformReadContext";
import { createHostReadServices } from "../src/host-services";
import type { Action, CommandName, Snapshot } from "../src/services";
import "../src/styles.css";
import "../src/workbench.css";

const clientId = crypto.randomUUID();
const projectId = "reading-project";
const threadId = "reading-thread";
const post = async (path: string, value: unknown) => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-reading-client": clientId },
    body: JSON.stringify(value),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error);
  return result;
};
const action = (async (name: CommandName) => {
  if (name === "feedback") return { enabled: false, connected: false, opted_in: false };
  throw Error(`Fixture rejects ${name}`);
}) as Action;
const noop = () => {};
const readReview = async () => ({});
type FixtureMetadata = { calls: number; revision: string };
const updates = new EventTarget();
let metadata: FixtureMetadata | undefined;
const services = createHostReadServices(undefined, {
  bootstrap: async () => {
    throw Error("Fixture uses the local test transport");
  },
  origin: location.origin,
  async transport({ signal, onEvent, onClose }) {
    const stream = new EventSource(`/__reading/events?clientId=${clientId}`);
    signal.addEventListener("abort", () => stream.close(), { once: true });
    await new Promise<void>((resolve, reject) => {
      stream.onopen = () => resolve();
      stream.onerror = () => reject(Error("Fixture event stream unavailable"));
    });
    stream.onmessage = (event) => onEvent(JSON.parse(event.data));
    stream.addEventListener("fixture", (event) => {
      if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
      metadata = JSON.parse(event.data);
      updates.dispatchEvent(new Event("fixture"));
    });
    stream.onerror = () => {
      stream.close();
      onClose();
    };
    return {
      identity: {
        hostId: "reading-host",
        hostGeneration: "reading-host-generation",
        connectionId: clientId,
        gatewayGeneration: "reading-gateway",
      },
      transport: {
        close: () => stream.close(),
        request: (method, params) => post("/__reading/host", { method, params }),
      },
    };
  },
});
const history = services.reads!;
type ReadingTrace = {
  operation: "retain" | "ensureAnchor";
  viewId: string;
  revision: number;
  settled: boolean;
  result?: string;
};
const trace: ReadingTrace[] = [];
Object.assign(window, { readingTrace: trace });
const reads: typeof history = {
  ...history,
  async retain(viewId, revision, ...args) {
    const entry = { operation: "retain" as const, viewId, revision, settled: false };
    trace.push(entry);
    await history.retain(viewId, revision, ...args);
    entry.settled = true;
  },
  async ensureAnchor(viewId, revision, ...args) {
    const entry: ReadingTrace = { operation: "ensureAnchor", viewId, revision, settled: false };
    trace.push(entry);
    const result = await history.ensureAnchor(viewId, revision, ...args);
    entry.result = result;
    entry.settled = true;
    return result;
  },
};
function Fixture() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [fixture, setFixture] = useState(metadata);
  const [committedView, setCommittedView] = useState<string>();
  const [shown, setShown] = useState(true);
  const [dark, setDark] = useState(false);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const receive = () => setFixture(metadata);
    updates.addEventListener("fixture", receive);
    receive();
    let selected = false;
    const accept = (state: Snapshot) => {
      setSnapshot(state);
      if (selected || !state.projects.some((project) => project.id === projectId)) return;
      selected = true;
      void reads.selectSession({ projectId, threadId });
    };
    const unsubscribe = services.onState(accept);
    void services.snapshot().then(accept);
    return () => {
      unsubscribe();
      updates.removeEventListener("fixture", receive);
    };
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  const project = snapshot?.projects.find((value) => value.id === projectId);
  const thread = project?.state?.threads?.[threadId];
  const viewGeneration = thread?.displayHistory?.viewGeneration;
  useEffect(() => {
    if (shown && viewGeneration) setCommittedView(viewGeneration);
  }, [shown, viewGeneration]);
  return (
    <ApplicationIntlProvider>
      <TooltipProvider>
        <main
          style={{
            height: "100vh",
            display: "flex",
            flexDirection: "column",
            maxWidth: narrow ? 620 : undefined,
            margin: "0 auto",
            background: "var(--color-background)",
            color: "var(--color-foreground)",
          }}
          data-fixture-revision={fixture?.revision}
          data-fixture-history={JSON.stringify(thread?.displayHistory)}
          data-fixture-history-calls={fixture?.calls ?? 0}
          data-fixture-history-ready={shown ? committedView : undefined}
        >
          <header style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: 8 }}>
            <button onClick={() => setShown((value) => !value)}>
              {shown ? "Leave conversation" : "Return to conversation"}
            </button>
            <button onClick={() => void post("/__reading/control", { operation: "reobserve" })}>
              Reobserve
            </button>
            <button onClick={() => void post("/__reading/control", { operation: "delta" })}>
              Append output
            </button>
            <button onClick={() => setNarrow((value) => !value)}>Toggle width</button>
            <button onClick={() => setDark((value) => !value)}>Toggle theme</button>
            <button onClick={() => void post("/__reading/control", { operation: "hold" })}>
              Hold pages
            </button>
            <output>History reads {fixture?.calls ?? 0}</output>
          </header>
          {shown && thread && project ? (
            <PlatformReadProvider reads={reads} readOnly>
              <Messages
                project={project}
                thread={thread}
                action={action}
                dark={dark}
                readOnly
                onLink={noop}
                onFile={noop}
                onReview={noop}
                readTurnReview={readReview}
              />
            </PlatformReadProvider>
          ) : (
            <p>Conversation is closed.</p>
          )}
        </main>
      </TooltipProvider>
    </ApplicationIntlProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
