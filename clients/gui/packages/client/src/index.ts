import type { HostStatus } from "./protocol.js";
import { readHostBootstrap, record, type HostBootstrap } from "./bootstrap.js";
export { readHostBootstrap, type HostBootstrap } from "./bootstrap.js";

export type HostReadState =
  | {
      connection: "connecting" | "offline";
      freshness: "unavailable" | "stale";
      previous?: HostStatus;
    }
  | { connection: "ready"; freshness: "fresh"; value: HostStatus };

export interface HostClientOptions {
  bootstrap(): Promise<unknown>;
  origin: string;
  events?: Pick<Window, "addEventListener" | "removeEventListener">;
}

export class HostClient {
  #state: HostReadState = { connection: "offline", freshness: "unavailable" };
  #listeners = new Set<() => void>();
  #epoch = 0;
  #closed = false;
  #socket?: WebSocket;
  #timer?: ReturnType<typeof setTimeout>;
  #attempt = 0;
  #wake = () => this.retry();
  constructor(private readonly options: HostClientOptions) {
    options.events?.addEventListener("online", this.#wake);
    options.events?.addEventListener("focus", this.#wake);
  }
  snapshot = (): HostReadState => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #publish(state: HostReadState) {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
  retry() {
    if (this.#closed) return;
    clearTimeout(this.#timer);
    const epoch = ++this.#epoch;
    this.#socket?.close();
    this.#socket = undefined;
    const previous = this.#state.connection === "ready" ? this.#state.value : this.#state.previous;
    this.#publish({
      connection: "connecting",
      freshness: previous ? "stale" : "unavailable",
      previous,
    });
    void this.#connect(epoch).catch(() => {
      if (this.#closed || epoch !== this.#epoch) return;
      this.#socket?.close();
      this.#publish({
        connection: "offline",
        freshness: previous ? "stale" : "unavailable",
        previous,
      });
      const delay = Math.min(30_000, 500 * 2 ** Math.min(this.#attempt++, 6));
      this.#timer = setTimeout(() => this.retry(), delay * (0.75 + Math.random() * 0.5));
    });
  }
  async #connect(epoch: number) {
    let bootstrap: HostBootstrap | undefined = readHostBootstrap(await this.options.bootstrap());
    if (bootstrap.origin !== this.options.origin) throw new Error("Host origin mismatch");
    if (this.#closed || epoch !== this.#epoch) return;
    const { hostId, generation } = bootstrap;
    const socket = (this.#socket = new WebSocket(bootstrap.websocketUrl));
    await new Promise<void>((resolve, reject) => {
      let phase: "hello" | "status" | "ready" = "hello";
      const deadline = setTimeout(() => fail(), 15_000);
      const fail = () => {
        clearTimeout(deadline);
        bootstrap = undefined;
        reject(new Error("Host connection unavailable"));
      };
      const current = () => !this.#closed && epoch === this.#epoch;
      socket.onopen = () => {
        if (!current() || !bootstrap) {
          socket.close();
          return;
        }
        socket.send(
          JSON.stringify({
            version: 1,
            id: "hello",
            method: "hello",
            params: {
              protocolVersions: [1],
              capabilities: [],
              ticket: bootstrap.ticket,
              expectedGeneration: generation,
            },
          }),
        );
        bootstrap = undefined;
      };
      socket.onerror = fail;
      socket.onclose = () => {
        fail();
        if (phase === "ready" && current()) this.retry();
      };
      socket.onmessage = (event) => {
        if (!current()) return;
        try {
          if (
            typeof event.data !== "string" ||
            new TextEncoder().encode(event.data).length > 1024 * 1024
          )
            throw new Error("Invalid Host frame");
          const response: unknown = JSON.parse(event.data);
          if (
            !record(response) ||
            response.version !== 1 ||
            "error" in response ||
            !record(response.result)
          )
            throw new Error("Invalid Host response");
          const value = response.result;
          if (value.hostId !== hostId || value.generation !== generation)
            throw new Error("Host identity changed");
          if (phase === "hello" && response.id === "hello") {
            if (value.version !== 1 || !Array.isArray(value.capabilities))
              throw new Error("Invalid Host hello");
            phase = "status";
            socket.send(
              JSON.stringify({ version: 1, id: "status", method: "host.status", params: {} }),
            );
          } else if (phase === "status" && response.id === "status") {
            const status = readStatus(value);
            phase = "ready";
            clearTimeout(deadline);
            this.#attempt = 0;
            this.#publish({ connection: "ready", freshness: "fresh", value: status });
            resolve();
          } else throw new Error("Unexpected Host response");
        } catch {
          fail();
          socket.close();
        }
      };
    });
  }
  close() {
    this.#closed = true;
    ++this.#epoch;
    clearTimeout(this.#timer);
    this.options.events?.removeEventListener("online", this.#wake);
    this.options.events?.removeEventListener("focus", this.#wake);
    this.#socket?.close();
    this.#listeners.clear();
  }
}

function readStatus(value: Record<string, unknown>): HostStatus {
  if (
    typeof value.state !== "string" ||
    typeof value.restartPending !== "boolean" ||
    typeof value.stopIntent !== "boolean" ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every((item) => typeof item === "string") ||
    !Array.isArray(value.projects)
  )
    throw new Error("Invalid Host status");
  for (const project of value.projects) {
    if (
      !record(project) ||
      typeof project.state !== "string" ||
      !record(project.registration) ||
      typeof project.registration.projectId !== "string"
    )
      throw new Error("Invalid Host project status");
  }
  return value as unknown as HostStatus;
}
