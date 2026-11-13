import type { DesktopBridge } from "../src/desktop-services";
import type { Snapshot } from "../src/services";
import { readFields } from "../src/desktop-response";

const threadId = "synthetic-history";
const project: Snapshot["projects"][number] = {
  id: "restore-fixture",
  root: "/isolated/workspace",
  state: { connected: false, threads: {}, queues: {}, interactions: {} },
  models: [],
  profiles: [],
  pending: [],
  summaries: [{ id: threadId, name: "Synthetic history restoration", status: "idle" }],
  configurations: {},
  outcomes: {},
  core: {},
};
const second = {
  ...structuredClone(project),
  id: "second-fixture",
  root: "/isolated/second",
  summariesLoaded: false,
  summaries: [],
};
const snapshot: Snapshot = {
  revision: 1,
  projects: [project, second],
  connection: { state: "ready" },
  library: {
    projects: {
      "second-fixture": {
        navigationSummaries: [
          { id: "second-history", preview: "Second cached history", status: "idle" },
        ],
      },
    },
    threads: {},
    settings: {},
    projectOrder: [],
  },
};
let projectionListener: (value: unknown) => void = () => {
  throw new Error("Projection listener is not installed");
};
let sequence = 0;
const publish = () => {
  snapshot.revision = (snapshot.revision ?? 0) + 1;
  projectionListener({
    frame: {
      projection: 1,
      stream: "navigation-fixture",
      sequence: ++sequence,
      kind: "full",
      snapshot: structuredClone(snapshot),
    },
  });
};
const history = (id: string) => ({
  id,
  status: "idle",
  turns: [
    {
      id: id + "-turn",
      status: "completed",
      items: [
        {
          id: id + "-reply",
          type: "agentMessage",
          phase: "final_answer",
          text: id === threadId ? "RESTORED_HISTORY_SENTINEL" : "SECOND_HISTORY_SENTINEL",
        },
      ],
    },
  ],
});
const fixture = Object.assign(window, {
  calls: [] as { name: unknown; params: Record<string, unknown> }[],
  fixture: () => structuredClone(snapshot),
  creationPending(method: string, requestId: string) {
    project.pending.push({
      method,
      operation: { requestId, method, target: { kind: "project" } },
      params: { requestId, sourceThreadId: threadId },
    });
    publish();
  },
});
localStorage.setItem("areal-gui:project", project.id);
localStorage.removeItem("areal-gui:thread:" + project.id);
const bridge: DesktopBridge = {
  snapshot: async () => structuredClone(snapshot),
  onProjection: (callback) => {
    projectionListener = callback;
    return () => {};
  },
  requestProjection: (requestId) =>
    projectionListener({
      requestId,
      frame: {
        projection: 1,
        stream: "navigation-fixture",
        sequence: ++sequence,
        kind: "full",
        snapshot: structuredClone(snapshot),
      },
    }),
  setInterfaceLocale: () => {},
  theme: async () => ({ platform: "darwin", dark: false, id: "light" }),
  onTheme: () => () => {},
  onPreviewEvent: () => () => {},
  onUpdate: () => () => {},
  onQuitProgress: () => () => {},
  onQuitRequested: () => () => {},
  onWindowClosing: () => () => {},
  onWindowOpened: () => () => {},
  onNotificationOpen: () => () => {},
  onMcpAppDeepLink: () => () => {},
  updateState: async () => ({ state: "idle" }),
  downloadUpdate: async () => ({ state: "idle" }),
  recoverUpdateResources: async () => ({ state: "idle" }),
  chooseProject: async () => null,
  chooseProjectlessDirectory: async () => null,
  chooseTaskDirectory: async () => null,
  fileOpen: async () => null,
  installCommandLineTools: async () => ({}),
  mcpApp: async () => ({}),
  mcpFormResource: async () => ({}),
  onMcpAppEvent: () => () => {},
  presentReady: async () => {},
  preview: async () => ({}),
  command: async (name, raw) => {
    const params = readFields(raw);
    fixture.calls.push({ name, params });
    if (name === "workspace") return { ok: true, value: { git: true, branch: "main" } };
    if (name === "trajectory")
      return { ok: true, value: { enabled: false, state: "disabled", queue: {}, records: [] } };
    if (name !== "connect" && name !== "open" && name !== "reconcile" && name !== "queue")
      return { ok: true, value: { data: [] } };
    const owner = snapshot.projects.find((item) => item.id === params.projectId);
    if (!owner) throw new Error("Unknown fixture project");
    if (name === "connect") {
      owner.state.connected = true;
      owner.core = { connectionGeneration: 1 };
      publish();
      return { ok: true, value: { data: [] } };
    }
    if (name === "reconcile")
      return { ok: true, value: { outcomes: structuredClone(owner.outcomes) } };
    if (typeof params.threadId !== "string") throw new Error("Missing fixture thread");
    if (name === "open") {
      owner.state.threads[params.threadId] = history(params.threadId);
      publish();
      return { ok: true, value: { data: [] } };
    }
    return { ok: true, value: owner.state.queues[params.threadId] };
  },
};
Object.assign(window, { arealDesktop: bridge });
