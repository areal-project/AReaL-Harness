import { describe, expect, it, vi } from "vite-plus/test";
import type { HostClient } from "@areal/client";
import { createHostBots, type BotEventNotification } from "./host-bots.js";

function createMockClient() {
  const botListeners = new Set<(notification: unknown) => void>();
  const workbench = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  const unsubscribe = vi.fn(() => {
    botListeners.clear();
  });
  const subscribeBotEvents = vi.fn((listener: (notification: unknown) => void) => {
    botListeners.add(listener);
    return () => {
      botListeners.delete(listener);
      unsubscribe();
    };
  });
  const client = {
    workbench,
    subscribeBotEvents,
  } as unknown as HostClient;
  return {
    client,
    workbench,
    subscribeBotEvents,
    unsubscribe,
    emit: (payload: unknown) => {
      for (const listener of botListeners) listener(payload);
    },
  };
}

describe("createHostBots", () => {
  it("routes read and command calls through unified Host workbench methods", async () => {
    const mock = createMockClient();
    mock.workbench.mockResolvedValueOnce({ revision: 3, bots: [] }).mockResolvedValueOnce({
      commandId: "cmd-1",
      method: "bots.command",
      admissionState: "accepted",
      submissionUnknown: false,
      receipt: {
        bot: {
          id: "bot_1",
          name: "Weekly Digest",
          avatar: "📝",
          description: "",
          workspace: "bot-weekly",
          starterPrompts: [],
          systemPromptMode: "personalAgent",
          preferences: "",
          preferencesRevision: 1,
          syncedPreferencesRevision: 0,
          providerSyncMode: "auto",
          createdAt: 1,
          updatedAt: 1,
          lastActiveAt: 1,
          lastMessagePreview: "",
          connectionState: { kind: "sleeping" },
        },
        revision: 4,
      },
    });

    const { bots, dispose } = createHostBots(mock.client);
    const listed = await bots.list();
    expect(listed.revision).toBe(3);
    expect(mock.workbench).toHaveBeenNthCalledWith(1, "bots.read", { operation: "list" });

    const created = await bots.create({ name: "Weekly Digest" });
    expect(created.bot.id).toBe("bot_1");
    expect(created.revision).toBe(4);
    expect(mock.workbench).toHaveBeenNthCalledWith(
      2,
      "bots.command",
      {
        operation: "create",
        name: "Weekly Digest",
      },
      expect.any(String),
    );
    dispose();
  });

  it("preserves unconfirmed send outcomes instead of masking them as accepted", async () => {
    const mock = createMockClient();
    mock.workbench.mockResolvedValueOnce({
      commandId: "cmd-send-1",
      method: "bots.command",
      admissionState: "unknown",
      submissionUnknown: true,
      receipt: {
        bot: {
          id: "bot_1",
          pendingSubmission: {
            requestId: "cmd-send-1",
            threadId: "thread-1",
            digest: "fixture",
            preview: "hello",
            createdAt: 100,
          },
        },
      },
    });

    const { bots, dispose } = createHostBots(mock.client);
    const result = await bots.send("bot_1", "hello");
    expect(result.admissionState).toBe("unknown");
    expect(result.submissionUnknown).toBe(true);
    expect(result.bot?.pendingSubmission?.requestId).toBe("cmd-send-1");
    dispose();
  });

  it("forwards bots.event notifications to subscribers and cleans up on dispose", () => {
    const mock = createMockClient();
    const { bots, dispose } = createHostBots(mock.client);
    const received: BotEventNotification[] = [];
    const off = bots.onEvent((event) => received.push(event));

    mock.emit({
      event: "bots.event",
      connectionId: "conn-1",
      gatewayGeneration: "gen-1",
      notification: {
        kind: "messageDelta",
        botId: "bot_1",
        turnId: "turn_1",
        itemId: "item_1",
        delta: "Hello",
      },
    });
    mock.emit("invalid-non-object-event");
    mock.emit({ event: "other.event", notification: { kind: "ignored" } });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ kind: "messageDelta", botId: "bot_1", delta: "Hello" });

    off();
    mock.emit({
      event: "bots.event",
      connectionId: "conn-1",
      gatewayGeneration: "gen-1",
      notification: { kind: "registryChanged", revision: 5 },
    });
    expect(received).toHaveLength(1);

    dispose();
    expect(mock.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
