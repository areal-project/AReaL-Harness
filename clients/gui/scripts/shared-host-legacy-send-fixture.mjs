import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createIdentity, identityId, secureChannel } from "../packages/remote/src/channel.mjs";
import { createRemoteWire } from "../packages/remote/src/wire.mjs";
import { respondToSessionName } from "../../../scripts/model-fixture.mjs";

const require = createRequire(new URL("../app/package.json", import.meta.url));
const WebSocket = require("ws");

export async function legacySendModel() {
  const acceptedMarker = `H2_ACCEPTED_SEND_${randomUUID()}`;
  const pendingMarker = `H2_PENDING_SEND_${randomUUID()}`;
  const requests = [];
  let releasePending;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (respondToSessionName(body, response)) return;
    const input = JSON.stringify(
      (body.messages ?? []).findLast((row) => row.role === "user")?.content ?? null,
    );
    const kind = input.includes(pendingMarker)
      ? "pending"
      : input.includes(acceptedMarker)
        ? "accepted"
        : "other";
    const record = { kind, closed: false };
    requests.push(record);
    response.once("close", () => {
      record.closed = true;
    });
    const complete = () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "LEGACY_LOCAL_COMPLETED" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    };
    if (kind === "pending") releasePending = complete;
    else complete();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    acceptedMarker,
    pendingMarker,
    requests,
    release() {
      assert(releasePending, "the original pending HTTP response is held");
      releasePending();
      releasePending = undefined;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function directLegacyPhone({
  origin,
  hostPeer,
  identity,
  invite,
  approve,
  onResponse,
}) {
  identity ??= await createIdentity();
  const socket = new WebSocket(origin.replace(/^http/, "ws") + "/remote/socket", { origin });
  const { wire, ready } = createRemoteWire(socket, { room: null });
  const bounded = async (work, label, deadline = Date.now() + 30000) => {
    let timer;
    try {
      return await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Legacy source phone ${label} deadline`)),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const next = async (messages, deadline) => {
    const result = await bounded(messages.next(), "reply", deadline);
    assert.equal(result.done, false, "the original authenticated phone connection remains open");
    return result.value;
  };
  try {
    await bounded(ready, "connection");
    const secure = await bounded(secureChannel(wire, identity, hostPeer), "Noise handshake");
    const messages = secure.messages();
    secure.send({
      method: "hello",
      apiVersion: "areal.remote.v2",
      clientVersion: "source-import-fixture",
      displayName: "Original source phone",
      clientKind: "ios",
      ...(invite ? { inviteSecret: invite } : {}),
    });
    let active = await next(messages);
    if (invite) {
      assert.equal(active.event, "pairing");
      await bounded(approve(identityId(identity)), "approval");
      active = await next(messages);
    }
    assert.equal(active.event, "ready");
    return {
      identity,
      peer: identityId(identity),
      active,
      close: () => socket.terminate(),
      async rpc(method, params, context, commandId) {
        const deadline = Date.now() + 30000;
        const id = randomUUID();
        const request = {
          id,
          method,
          params,
          ...(context ? { context } : {}),
          ...(commandId ? { commandId } : {}),
        };
        secure.send(request);
        for (;;) {
          const result = await next(messages, deadline);
          if (result.id === id) {
            if (onResponse && ["session.create", "session.send", "command.read"].includes(method))
              await onResponse({ request, response: result });
            return result;
          }
        }
      },
    };
  } catch (error) {
    socket.terminate();
    throw error;
  }
}
