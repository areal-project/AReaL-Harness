import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Messages } from "../src/Messages";
import { ApplicationIntlProvider } from "../src/i18n/IntlProvider";
import { TooltipProvider } from "../src/components/ui/tooltip";
import type { Action, Data } from "../src/services";
import "../src/styles.css";
import "../src/workbench.css";

const post = async (path: string, value: unknown) => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error);
  return result;
};
const action = (async (name: string, params: Data) => {
  if (name === "history") return post("/__reading/history", params);
  if (name === "feedback") return { enabled: false, connected: false, opted_in: false };
  throw Error(`Fixture rejects ${name}`);
}) as Action;
const noop = () => {};
const readReview = async () => ({});
const project = {
  id: "reading-project",
  root: "/isolated/reading",
  configurations: {},
  core: { instanceId: "fixture", connectionGeneration: 1 },
  state: { connected: true },
};
function Fixture() {
  const [state, setState] = useState<Data>();
  const [committedView, setCommittedView] = useState<string>();
  const [shown, setShown] = useState(true);
  const [dark, setDark] = useState(false);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const stream = new EventSource("/__reading/events");
    stream.onmessage = (event) => setState(JSON.parse(event.data));
    return () => stream.close();
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  const viewGeneration = state?.thread?.displayHistory?.viewGeneration;
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
          data-fixture-revision={state?.revision}
          data-fixture-history={JSON.stringify(state?.thread?.displayHistory)}
          data-fixture-history-calls={state?.calls ?? 0}
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
            <button
              onClick={() => void post("/__reading/control", { operation: "delay", value: 400 })}
            >
              Delay pages
            </button>
            <output>History reads {state?.calls ?? 0}</output>
          </header>
          {shown && state?.thread ? (
            <Messages
              project={project}
              thread={state.thread}
              action={action}
              dark={dark}
              readOnly
              onLink={noop}
              onFile={noop}
              onReview={noop}
              readTurnReview={readReview}
            />
          ) : (
            <p>Conversation is closed.</p>
          )}
        </main>
      </TooltipProvider>
    </ApplicationIntlProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
