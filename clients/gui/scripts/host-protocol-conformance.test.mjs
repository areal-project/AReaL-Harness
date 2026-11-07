import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { on, once } from "node:events";
import { connect } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { nativeHostFixture, nativeCoreProject } from "./remote-native-host-fixture.mjs";
import { relayFixture } from "./remote-relay-fixture.mjs";
import { runWithIsolatedCA, until } from "./remote-native-push-fixture.mjs";
import { createIdentity, identityId, secureChannel } from "../packages/remote/src/channel.mjs";
import { createRemoteWire } from "../packages/remote/src/wire.mjs";

const require = createRequire(new URL("../../../package.json", import.meta.url));
const Ajv2020 = require("ajv/dist/2020.js").default;
const WebSocket = require("ws");
const schema = JSON.parse(
  await readFile(new URL("../../../schemas/areal-host-protocol-v1.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020({ strict: false, allErrors: true });
const hyphenatedUuid = "[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}";
const uuid = new RegExp(
  `^(?:[0-9a-fA-F]{32}|${hyphenatedUuid}|urn:uuid:${hyphenatedUuid}|\\{${hyphenatedUuid}\\})$`,
);
ajv.addFormat("uuid", {
  type: "string",
  validate: (value) => uuid.exec(value)?.[0] === value,
});
ajv.addKeyword({
  keyword: "x-maxUtf8Bytes",
  type: "string",
  schemaType: "number",
  validate: (limit, value) => Buffer.byteLength(value, "utf8") <= limit,
});
const { addHostProtocolSchemas } = createRequire(import.meta.url)(
  "./host-protocol-schema-registry.cjs",
);
addHostProtocolSchemas(
  ajv,
  schema,
  JSON.parse(
    await readFile(new URL("../../../schemas/areal-core-v1.json", import.meta.url), "utf8"),
  ),
);
const validators = new Map();
function conforms(ref, value, expected = true) {
  if (!validators.has(ref)) validators.set(ref, ajv.compile({ $ref: `${schema.$id}${ref}` }));
  const validate = validators.get(ref);
  assert.equal(validate(value), expected, `${ref}: ${ajv.errorsText(validate.errors)}`);
}
function methodRef(transport, method, kind) {
  const ref = schema["x-current"][transport].methods[method]?.[kind];
  assert.equal(typeof ref, "string", `current ${transport} ${method} ${kind} is declared`);
  return ref;
}
async function deadline(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Host protocol conformance reply deadline")),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function localConnection(t, fixture) {
  const descriptor = JSON.parse(await readFile(join(fixture.home, "host/host.json"), "utf8"));
  const authToken = JSON.parse(await readFile(descriptor.authFile, "utf8"));
  const socket = connect(descriptor.socketPath);
  const failed = new Promise((_, reject) => socket.once("error", reject));
  t.after(() => socket.destroy());
  const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
  const next = async () => {
    const line = await deadline(Promise.race([lines.next(), failed]));
    return line.done ? undefined : JSON.parse(line.value);
  };
  const send = (request) => socket.write(`${JSON.stringify(request)}\n`);
  const request = async (method, params = {}) => {
    const value = { version: 1, id: randomUUID(), method, params };
    conforms(methodRef("local", method, "request"), value);
    send(value);
    for (;;) {
      const response = await next();
      if (typeof response?.method === "string") {
        const ref = schema["x-current"].local.events[response.method];
        assert.equal(typeof ref, "string", `actual local event ${response.method} is declared`);
        conforms(ref, response);
        continue;
      }
      conforms("#/$defs/LocalResponse", response);
      if (response.id !== value.id) continue;
      assert.equal(response.error, undefined);
      conforms(methodRef("local", method, "result"), response.result);
      return response.result;
    }
  };
  await request("hello", { protocolVersions: [1], capabilities: [], authToken });
  return { request, send, next };
}
async function remoteConnection(t, fixture, relay, projectId, capabilities) {
  const invite = new URLSearchParams(
    new URL(
      (await fixture.remote.control({ operation: "pair", transport: "relay" })).payload,
    ).hash.slice(1),
  ).get("invite");
  const identity = await createIdentity();
  const socket = new WebSocket(relay.origin.replace(/^https:/, "wss:") + "/remote/socket", {
    origin: relay.origin,
  });
  const failed = new Promise((_, reject) => socket.once("error", reject));
  const wait = (promise) => deadline(Promise.race([promise, failed]));
  t.after(() => socket.terminate());
  const { wire, ready } = createRemoteWire(socket, { room: fixture.remote.config.room });
  await wait(ready);
  const secure = await wait(
    secureChannel(wire, identity, identityId(fixture.remote.config.identity)),
  );
  const messages = secure.messages();
  const next = async () => {
    const item = await wait(messages.next());
    assert.equal(item.done, false, "actual Noise connection remains open");
    return item.value;
  };
  const hello = {
    method: "hello",
    apiVersion: "areal.remote.v2",
    clientVersion: "a0-conformance",
    displayName: "A0 conformance",
    clientKind: "ios",
    inviteSecret: invite,
    ...(capabilities ? { capabilities } : {}),
  };
  conforms(schema["x-current"].remote.hello, hello);
  secure.send(hello);
  const pairing = await next();
  assert.equal(pairing.event, "pairing");
  conforms("#/$defs/RemotePairing", pairing);
  await fixture.remote.control({
    operation: "approve",
    id: identityId(identity),
    projects: [projectId],
    preset: "Operator",
  });
  const active = await next();
  conforms(schema["x-current"].remote.ready, active);
  assert.equal(active.event, "ready");
  assert.deepEqual(
    [...active.methods].sort(),
    Object.entries(schema["x-current"].remote.methods)
      .filter(([, entry]) => !entry.capability)
      .map(([method]) => method)
      .sort(),
  );
  return {
    active,
    async rpc(request, valid = true) {
      const value = { id: randomUUID(), ...request };
      conforms(methodRef("remote", value.method, "request"), value, valid);
      secure.send(value);
      for (;;) {
        const response = await next();
        if (response.id !== value.id) {
          const ref = schema["x-current"].remote.events[response.event];
          assert.equal(typeof ref, "string", `actual Remote event ${response.event} is declared`);
          conforms(ref, response);
          continue;
        }
        if (response.error) conforms("#/$defs/RemoteError", response.error);
        else conforms(methodRef("remote", value.method, "result"), response.result);
        conforms("#/$defs/RemoteResponse", response);
        return response;
      }
    },
  };
}

if (!process.env.RC12_TLS_HOME) {
  test("Host protocol conformance uses isolated Relay TLS roots", async () => {
    await runWithIsolatedCA(import.meta.filename);
  });
} else {
  test("actual local Host hello, status, status notification and strict envelope match the schema", async (t) => {
    const fixture = await nativeHostFixture(t, { deferNative: true });
    const local = await localConnection(t, fixture);
    const before = await local.request("host.status");
    const subscription = await local.request("host.subscribe");
    assert.equal(subscription.sequence, 0);
    const workspace = join(fixture.evidence.root, "Protocol Project");
    await mkdir(workspace);
    await fixture.source.register(randomUUID(), {
      id: randomUUID().replaceAll("-", "").slice(0, 24),
      root: workspace,
    });
    const event = await local.next();
    assert.equal(event.method, "host.statusChanged");
    conforms(schema["x-current"].local.events[event.method], event);
    assert.equal(event.params.subscriptionId, subscription.subscriptionId);
    assert.equal(event.params.sequence, 1);
    assert.notDeepEqual(event.params.status, before);

    const endpoint = await local.request("web.endpoint");
    const ticket = await local.request("web.ticket", {
      origin: "areal-ui://app",
      expectedGeneration: endpoint.generation,
    });
    const ws = new WebSocket(ticket.websocketUrl, { origin: ticket.origin });
    t.after(() => ws.terminate());
    const messages = on(ws, "message");
    await once(ws, "open");
    const rpc = async (method, params) => {
      const request = { version: 1, id: randomUUID(), method, params };
      conforms(methodRef("loopback", method, "request"), request);
      ws.send(JSON.stringify(request));
      for (;;) {
        const { value } = await deadline(messages.next());
        const response = JSON.parse(value[0].toString());
        if (response.id !== request.id) continue;
        assert.equal(response.error, undefined);
        conforms(methodRef("loopback", method, "result"), response.result);
        return response.result;
      }
    };
    const negotiated = await rpc("hello", {
      protocolVersions: [1],
      capabilities: ["gui-read-v1"],
      ticket: ticket.ticket,
      expectedGeneration: ticket.generation,
    });
    assert.deepEqual(negotiated.negotiatedCapabilities, ["gui-read-v1"]);
    const subscribed = await rpc("shell.subscribe", {});
    assert.ok(subscribed.snapshot.projects.length > 0);
    assert.ok(subscribed.snapshot.projects.every((project) => project.summaries.state !== "fresh"));
    const nextWorkspace = join(fixture.evidence.root, "Second Protocol Project");
    await mkdir(nextWorkspace);
    await fixture.source.register(randomUUID(), {
      id: randomUUID().replaceAll("-", "").slice(0, 24),
      root: nextWorkspace,
    });
    const localUpdate = await local.next();
    conforms(schema["x-current"].local.events[localUpdate.method], localUpdate);
    const {
      value: [bytes],
    } = await deadline(messages.next());
    const update = JSON.parse(bytes.toString());
    assert.equal(update.method, "shell.updated");
    conforms(schema["x-current"].loopback.events[update.method], update);
    assert.equal(update.params.sequence, 1);
    assert.equal(update.params.subscriptionId, subscribed.subscriptionId);
    assert.deepEqual(
      update.params.delta.projects.upsert.map((project) => project.workspace),
      [nextWorkspace],
    );
    assert.equal(update.params.snapshot, undefined);
    const after = await local.request("host.status");
    assert.equal(
      after.projects.some((project) => project.state === "ready"),
      false,
    );
    assert.deepEqual(
      await rpc("shell.unsubscribe", { subscriptionId: subscribed.subscriptionId }),
      { closed: true },
    );

    const invalid = await localConnection(t, fixture);
    const request = {
      version: 1,
      id: randomUUID(),
      method: "host.status",
      params: {},
      unexpected: true,
    };
    conforms(methodRef("local", request.method, "request"), request, false);
    invalid.send(request);
    assert.equal(
      await invalid.next(),
      undefined,
      "actual Host closes an invalid envelope connection",
    );
  });

  test(
    "actual native Host over Relay preserves Remote strictness, UTF8 send and paged body",
    { timeout: 180000 },
    async (t) => {
      const relay = await relayFixture(t);
      const fixture = await nativeHostFixture(t);
      const native = await nativeCoreProject(t, fixture);
      await fixture.remote.control({
        operation: "enable",
        relay: relay.origin,
        code: relay.admin("enrollment").code,
        confirmed: true,
      });
      await until(
        async () => (await fixture.remote.refresh()).connected,
        "native Host joins real Relay",
      );
      const remote = await remoteConnection(t, fixture, relay, native.alias);
      const described = await remote.rpc({ method: "host.describe", params: {} });
      assert.deepEqual(described.result.methods, remote.active.methods);
      const listed = await remote.rpc({ method: "project.list", params: {} });
      const project = listed.result.projects.find((entry) => entry.projectId === native.alias);
      assert.ok(project);
      assert.equal(project.connectionState, "online");
      const created = await native.core.call("areal/thread/start", {
        requestId: randomUUID(),
        cwd: native.workspace,
        agentProfile: { id: "fixture", revision: "v1" },
      });
      const threadId = created.thread.id;
      const readContext = { projectId: native.alias, extraReadContext: true };
      const opened = await remote.rpc({
        method: "session.open",
        params: { threadId },
        context: readContext,
      });
      assert.equal(opened.result.snapshot.threadId, threadId);
      const context = {
        projectId: native.alias,
        gatewayGeneration: remote.active.gatewayGeneration,
        grantRevision: remote.active.grantRevision,
        serviceGeneration: project.serviceGeneration,
      };
      const params = {
        threadId,
        expectedConfigRevision: opened.result.snapshot.configRevision,
        text: "hello",
      };
      for (const request of [
        { method: "host.describe", params: {}, extraEnvelope: true },
        {
          method: "session.send",
          params: { ...params, extraParams: true },
          context,
          commandId: randomUUID(),
        },
        {
          method: "session.send",
          params,
          context: { ...context, extraContext: true },
          commandId: randomUUID(),
        },
        { method: "project.list", params: {}, context: readContext },
      ]) {
        const rejected = await remote.rpc(request, false);
        assert.equal(rejected.error?.code, "INVALID_PARAMS");
      }
      const text = "界".repeat(21845) + "x";
      assert.equal(Buffer.byteLength(text), 65536);
      const tooLong = await remote.rpc(
        {
          method: "session.send",
          params: { ...params, text: text + "x" },
          context,
          commandId: randomUUID(),
        },
        false,
      );
      assert.equal(tooLong.error?.code, "INVALID_PARAMS");
      const sent = await remote.rpc({
        method: "session.send",
        params: { ...params, text },
        context,
        commandId: randomUUID(),
      });
      assert.equal(sent.result?.admissionState, "accepted");
      let thread;
      await until(async () => {
        thread = (await native.core.call("thread/read", { threadId, includeTurns: true })).thread;
        return thread.turns.length === 1 && thread.turns[0].status === "completed";
      }, "original UTF8 boundary turn completes");
      const history = await remote.rpc({
        method: "session.history",
        params: { threadId, limit: 100 },
        context: readContext,
      });
      assert.equal(history.error, undefined);
      const turn = thread.turns[0];
      const item = turn.items.find((entry) => entry.type === "userMessage");
      let cursor,
        offset = 0,
        encoded = "",
        pages = 0,
        totalBytes;
      do {
        const response = await remote.rpc({
          method: "session.body",
          context: readContext,
          params: { threadId, turnId: turn.id, itemId: item.id, ...(cursor ? { cursor } : {}) },
        });
        assert.equal(response.error, undefined);
        const body = response.result.body;
        totalBytes ??= body.totalBytes;
        assert.equal(body.totalBytes, totalBytes);
        assert.equal(body.offset, offset);
        assert.ok(Buffer.byteLength(body.chunk) <= 32768);
        offset += Buffer.byteLength(body.chunk);
        encoded += body.chunk;
        cursor = response.result.nextCursor;
        pages++;
        assert.ok(pages <= 4, "body page traversal stays within this known payload");
      } while (cursor);
      assert.ok(pages > 1, "actual UTF8 body crossed the page budget");
      assert.equal(offset, totalBytes);
      const decoded = JSON.parse(encoded);
      assert.equal(decoded.content.map((part) => part.text ?? "").join(""), text);
      const shared = await remoteConnection(t, fixture, relay, native.alias, ["gui-read-v1"]);
      assert.deepEqual(shared.active.negotiatedCapabilities, ["gui-read-v1"]);
      assert.equal(shared.active.authorityHostId, (await fixture.client.status()).hostId);
      const shell = await shared.rpc({ method: "shell.subscribe", params: {} });
      assert.ok(
        shell.result.snapshot.projects.some((entry) => entry.projectId === native.projectId),
      );
      const nativeContext = {
        projectId: native.projectId,
        serviceGeneration: project.serviceGeneration,
      };
      const openedNative = await shared.rpc({
        method: "session.open",
        context: nativeContext,
        params: { threadId, view: "conversation" },
      });
      assert.equal(openedNative.result.projectId, native.projectId);
      const authoritativeNative = await native.core.call("areal/thread/observe", {
        threadId,
        mode: "conversation",
        maxBytes: 131072,
      });
      assert.deepEqual(openedNative.result.snapshot.thread, authoritativeNative.thread);
      assert.deepEqual(
        (
          await shared.rpc({
            method: "subscription.close",
            context: nativeContext,
            params: { subscriptionId: openedNative.result.subscriptionId },
          })
        ).result,
        { closed: true },
      );
      assert.deepEqual(
        (
          await shared.rpc({
            method: "shell.unsubscribe",
            params: { subscriptionId: shell.result.subscriptionId },
          })
        ).result,
        { closed: true },
      );
      fixture.evidence.protocolConformance = {
        transport: "real Host/Relay/Noise",
        utf8TextBytes: Buffer.byteLength(text),
        bodyPages: pages,
        bodyBytes: offset,
      };
      const writer = await remoteConnection(t, fixture, relay, native.alias, [
        "gui-read-v1",
        "gui-write-v1",
      ]);
      const models = await writer.rpc({
        method: "project.models",
        context: { projectId: native.projectId },
        params: {},
      });
      assert.ok(models.result.models.length > 0);
      const commandId = randomUUID();
      const submitted = await writer.rpc({
        method: "session.send",
        context: {
          ...context,
          projectId: native.projectId,
          gatewayGeneration: writer.active.gatewayGeneration,
          grantRevision: writer.active.grantRevision,
        },
        params: { ...params, text: "shared canonical identity" },
        commandId,
      });
      assert.equal(submitted.result.admissionState, "accepted");
      for (const projectId of [native.projectId, native.alias]) {
        const receipt = await writer.rpc({
          method: "command.read",
          context: { projectId },
          params: { commandId },
        });
        assert.equal(receipt.result.admissionState, "accepted");
        assert.equal(receipt.result.nativeRequestId, submitted.result.nativeRequestId);
      }
      await until(async () => {
        const result = await native.core.call("thread/read", { threadId, includeTurns: true });
        return result.thread.turns.length === 2 && result.thread.turns[1].status === "completed";
      }, "shared canonical submission reaches Core and completes");
    },
  );
}
