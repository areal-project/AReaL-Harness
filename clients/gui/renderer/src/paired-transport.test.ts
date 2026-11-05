import { describe, expect, it } from "vite-plus/test";
import { pairedTransport, type PairedConnection } from "./paired-transport.js";

const ready = {
  negotiatedCapabilities: ["gui-read-v1", "gui-write-v1"],
  authorityHostId: "host",
  hostGeneration: "g1",
  connectionId: "c1",
  gatewayGeneration: "gw",
  grantRevision: 3,
  methods: ["session.send", "turn.stop"],
  writeLimits: { textBytes: 65536 },
};

function fakeClient() {
  const listeners = new Set<() => void>();
  const sent: unknown[] = [];
  const client = {
    state: { kind: "connecting" } as { kind: string },
    connection: null as null | { ready: unknown },
    onSession: (_message: unknown) => {},
    snapshot: () => client.state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request: async (envelope: unknown) => {
      sent.push(envelope);
      return {};
    },
    set(kind: string, connection: null | { ready: unknown }) {
      client.state = { kind };
      client.connection = connection;
      for (const listener of listeners) listener();
    },
  };
  return { client, sent, listeners };
}

function lifecycle() {
  const events: unknown[] = [];
  let closed = 0;
  const abort = new AbortController();
  return {
    events,
    closed: () => closed,
    abort,
    value: {
      signal: abort.signal,
      current: () => true,
      onEvent: (event: unknown) => events.push(event),
      onClose: () => closed++,
    },
  };
}

describe("paired connection transport", () => {
  it("waits for the paired connection and writes with the device grant revision", async () => {
    const { client, sent } = fakeClient();
    const life = lifecycle();
    const pending = pairedTransport(client as unknown as PairedConnection)(life.value);
    client.set("connected", { ready });
    const connection = await pending;
    expect(connection.identity.writeMethods).toEqual(["session.send", "turn.stop"]);
    await connection.transport.write?.(
      "turn.stop",
      { turnId: "t" },
      { projectId: "p", serviceGeneration: "s" },
      "cmd",
    );
    expect(sent[0]).toEqual({
      method: "turn.stop",
      params: { turnId: "t" },
      context: {
        projectId: "p",
        serviceGeneration: "s",
        gatewayGeneration: "gw",
        grantRevision: 3,
      },
      commandId: "cmd",
    });
    client.onSession({ event: "shell.changed" });
    expect(life.events).toEqual([{ event: "shell.changed" }]);
  });

  it("reports a close once when the paired connection drops and stops forwarding events", async () => {
    const { client, listeners } = fakeClient();
    client.set("connected", { ready });
    const life = lifecycle();
    await pairedTransport(client as unknown as PairedConnection)(life.value);
    client.set("offline", null);
    client.set("connected", { ready });
    expect(life.closed()).toBe(1);
    expect(listeners.size).toBe(0);
    client.onSession({ event: "late" });
    expect(life.events).toEqual([]);
  });

  it("has no write path when the Host did not grant gui-write-v1", async () => {
    const { client } = fakeClient();
    client.set("connected", {
      ready: { ...ready, negotiatedCapabilities: ["gui-read-v1"] },
    });
    const connection = await pairedTransport(client as unknown as PairedConnection)(
      lifecycle().value,
    );
    expect(connection.transport.write).toBeUndefined();
    expect(connection.identity.writeMethods).toBeUndefined();
  });
});
