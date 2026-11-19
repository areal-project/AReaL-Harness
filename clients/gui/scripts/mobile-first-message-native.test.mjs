import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { on, once } from "node:events";
import { createRequire } from "node:module";
import { test } from "node:test";
import { nativeHostFixture, nativeCoreProject } from "./remote-native-host-fixture.mjs";
import { phone, pushRelay, runWithIsolatedCA, until } from "./remote-native-push-fixture.mjs";

if (!process.env.RC12_TLS_HOME) {
  test("mobile first-message recovery uses an isolated relay", () =>
    runWithIsolatedCA(import.meta.filename));
} else {
  test(
    "a reconnected phone recovers exactly one thread and first turn",
    { timeout: 180000 },
    async (t) => {
      const relay = await pushRelay(t);
      const host = await nativeHostFixture(t);
      const project = await nativeCoreProject(t, host);
      await host.remote.control({
        operation: "enable",
        relay: relay.origin,
        code: relay.enrollment(),
        confirmed: true,
      });
      await until(async () => (await host.remote.refresh()).connected, "Host connected to relay");
      const device = await phone(t, host.remote, project.alias, undefined, true);
      assert.equal(device.active.sessionCreateFirstMessage, true);
      const projectContext = { projectId: project.alias };
      const scoped = (peer) => ({
        ...projectContext,
        serviceGeneration: project.service.generation,
        gatewayGeneration: peer.active.gatewayGeneration,
        grantRevision: peer.active.grantRevision,
      });
      const commandId = randomUUID();
      const text = "First message " + commandId;
      const params = {
        firstMessage: { text, model: { providerId: "fixture", modelId: "fixture" } },
      };
      // 原连接只发不收；等 Core 保存确切消息后切断连接，手机凭原命令找回结果。
      device.send("session.create", params, commandId, scoped(device));
      const original = await until(async () => {
        const list = await project.core.call("thread/list", { limit: 10 });
        for (const { id } of list.data) {
          const { thread } = await project.core.call("thread/read", {
            threadId: id,
            includeTurns: true,
          });
          const turn = thread.turns.find((turn) =>
            turn.items.some(
              (item) =>
                item.type === "userMessage" && item.content.some((part) => part.text === text),
            ),
          );
          if (turn) return { threadId: id, turnId: turn.id };
        }
      }, "Core stored the exact first message");
      const disconnected = once(device.socket, "close");
      device.close();
      await disconnected;
      const successor = await phone(t, host.remote, project.alias, device.identity);
      const receipt = await successor.rpc("command.read", { commandId }, undefined, projectContext);
      assert.equal(receipt.result?.admissionState, "accepted", JSON.stringify(receipt));
      assert.deepEqual(receipt.result.target, {});
      assert.equal(receipt.result.threadId, original.threadId);
      assert.equal(receipt.result.turnId, original.turnId);
      const duplicate = await successor.rpc("session.create", params, commandId, scoped(successor));
      assert.equal(duplicate.result?.turnId, original.turnId, JSON.stringify(duplicate));
      assert.equal(duplicate.result.threadId, original.threadId);
      assert.equal(duplicate.result.operationId, receipt.result.operationId);
      const completed = await until(async () => {
        const { thread } = await project.core.call("thread/read", {
          threadId: original.threadId,
          includeTurns: true,
        });
        return thread.turns[0]?.status === "completed" && thread;
      }, "first turn completed");
      assert.equal(completed.turns.length, 1);
      assert.equal(completed.turns[0].id, original.turnId);
      assert.ok(
        completed.turns[0].items.some(
          (item) => item.type === "agentMessage" && item.text === "NATIVE_REMOTE_FIXTURE",
        ),
      );
      assert.deepEqual(
        (await project.core.call("thread/list", { limit: 10 })).data.map((row) => row.id),
        [original.threadId],
      );
    },
  );
  test(
    "phone opens the original turn after the desktop disconnects during send",
    {
      timeout: 120000,
    },
    async (t) => {
      const relay = await pushRelay(t);
      const host = await nativeHostFixture(t);
      const project = await nativeCoreProject(t, host, { holdModel: true });
      await host.remote.control({
        operation: "enable",
        relay: relay.origin,
        code: relay.enrollment(),
        confirmed: true,
      });
      await until(async () => (await host.remote.refresh()).connected, "relay ready");
      const device = await phone(t, host.remote, project.alias, undefined, true);
      const created = await project.core.call("areal/thread/start", {
        requestId: randomUUID(),
        cwd: project.workspace,
        agentProfile: { id: "fixture", revision: "v1" },
      });
      const threadId = created.thread.id;
      const endpoint = await host.client.request("web.endpoint", {});
      const ticket = await host.client.request("web.ticket", {
        origin: "areal-ui://app",
        expectedGeneration: endpoint.generation,
      });
      const require = createRequire(new URL("../app/package.json", import.meta.url));
      const Socket = require("ws");
      const desktop = new Socket(ticket.websocketUrl, { origin: ticket.origin });
      t.after(() => desktop.terminate());
      const messages = on(desktop, "message");
      await once(desktop, "open");
      desktop.send(
        JSON.stringify({
          version: 1,
          id: "hello",
          method: "hello",
          params: {
            protocolVersions: [1],
            capabilities: ["gui-read-v1", "gui-write-v1"],
            ticket: ticket.ticket,
            expectedGeneration: ticket.generation,
          },
        }),
      );
      const hello = JSON.parse((await messages.next()).value[0]);
      assert.ok(hello.result?.writeMethods.includes("session.send"), JSON.stringify(hello.error));
      const text = "Desktop handoff " + randomUUID();
      desktop.send(
        JSON.stringify({
          version: 1,
          id: "send",
          method: "session.send",
          commandId: randomUUID(),
          context: {
            projectId: project.projectId,
            serviceGeneration: project.service.generation,
            gatewayGeneration: ticket.generation,
            grantRevision: 0,
          },
          params: { threadId, text, expectedConfigRevision: 1 },
        }),
      );
      const held = await project.waitForModel(text);
      const disconnected = once(desktop, "close");
      desktop.terminate();
      await disconnected;
      const openPhone = async () => {
        const reply = await device.rpc("session.open", { threadId }, undefined, {
          projectId: project.alias,
        });
        assert.equal(reply.error, undefined, JSON.stringify(reply.error));
        return reply.result.snapshot;
      };
      const active = await openPhone();
      assert.equal(active.threadId, threadId);
      assert.equal(active.turns.length, 1);
      assert.ok(active.activeTurnId);
      held.release();
      const completed = await until(async () => {
        const { thread } = await project.core.call("thread/read", { threadId, includeTurns: true });
        return thread.turns[0]?.status === "completed" && thread.turns;
      }, "original desktop turn completed once");
      const snapshot = await openPhone();
      assert.deepEqual(
        completed.map((turn) => turn.id),
        [active.activeTurnId],
      );
      assert.deepEqual(
        snapshot.turns.map((turn) => turn.id),
        [active.activeTurnId],
      );
      assert.equal(snapshot.turns[0].status, "completed");
      const items = snapshot.turns[0].items;
      assert.deepEqual(
        items.filter((item) => item.type === "userMessage").map((item) => item.preview),
        [text],
      );
      assert.deepEqual(
        items.filter((item) => item.type === "agentMessage").map((item) => item.preview),
        ["NATIVE_REMOTE_FIXTURE"],
      );
    },
  );
}
