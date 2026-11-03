import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeHostFixture, nativeCoreProject } from "./remote-native-host-fixture.mjs";
import { until } from "./remote-native-push-fixture.mjs";
import { createIdentity, identityId, secureChannel } from "../packages/remote/src/channel.mjs";
import { createRemoteWire } from "../packages/remote/src/wire.mjs";
import { respondToSessionName } from "../../../scripts/model-fixture.mjs";

const require = createRequire(new URL("../app/package.json", import.meta.url));
const WebSocket = require("ws");
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const originalChecks = [
  "bounded-authoritative-detail-preserves-session",
  "reviewed-approval-exact-native-identity-and-durable-dedup",
  "partial-pages-forged-review-and-deny",
  "stale-pages-bind-content-identity-grant-and-target",
  "wrong-original-target-digest-expiry-and-permanent-decisions",
  "native-read-budget-keeps-original-deny-available",
  "questions-exact-core-keys-options-and-utf8-bounds",
  "lost-response-no-receipt-no-replay-independent-observation",
  "outcome-loss-and-host-restart-stays-unknown",
  "two-devices-one-core-answer-original-associations",
  "final-revoke-fences-before-and-after-native-dispatch",
  "delayed-duplicate-preflight-keeps-original-outcome",
  "unknown-answer-does-not-block-settled-desktop-operations",
  "detail-publication-fences-revocation-and-service-replacement",
  "command-observation-final-identity-and-capability-fence",
  "bounded-observer-queue-and-active-viewer-survive-detail-read",
  "actual-noise-direct-reviewed-route-and-schema",
];

export async function nativeInteractionContract(t) {
  const f = await nativeHostFixture(t);
  const expectedChecks = [0, 1, 2, 4, 5, 6, 15, 16].map((index) => originalChecks[index]);
  const proof = {
    owner: "Rust Host",
    scope: "original RC07 real-Core subset",
    originalChecks,
    expectedChecks,
    checks: [],
    ownerRemaining: [...originalChecks],
  };
  const proofPath = join(f.evidence.root, "native-interaction-contract.json");
  const persist = () => writeFile(proofPath, JSON.stringify(proof, null, 2));
  try {
    const project = await nativeCoreProject(t, f, { approval: true });
    const seeds = new Map();
    const model = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      if (respondToSessionName(body, response)) return;
      const latestUser = body.messages.findLastIndex((message) => message.role === "user");
      const prompt = JSON.stringify(body.messages[latestUser] ?? null);
      const seed = [...seeds.values()].find((value) => prompt.includes(value.marker));
      const summary = !body.tools?.length;
      assert.ok(summary || seed, "the real Core request carries the original interaction marker");
      const answered =
        summary || body.messages.slice(latestUser + 1).some((message) => message.role === "tool");
      const tool = seed?.kind === "question" ? "ask_user_question" : "fs_create";
      const args =
        seed?.kind === "question"
          ? { questions: seed.questions, timeoutSeconds: seed.timeoutSeconds }
          : { path: seed?.path, text: seed?.text };
      const delta = answered
        ? { content: "Original interaction complete." }
        : {
            tool_calls: [
              {
                index: 0,
                id: seed.marker,
                type: "function",
                function: { name: tool, arguments: JSON.stringify(args) },
              },
            ],
          };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [
          { choices: [{ index: 0, delta, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: answered ? "stop" : "tool_calls" }] },
        ]
          .map((value) => `data: ${JSON.stringify(value)}\n\n`)
          .join("") + "data: [DONE]\n\n",
      );
    });
    await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      model.closeAllConnections();
      await new Promise((resolve) => model.close(resolve));
    });
    await project.core.call("areal/provider/upsert", {
      provider: {
        id: "interaction-native",
        revision: 0,
        endpoint: `http://127.0.0.1:${model.address().port}/v1/chat/completions`,
        protocol: "chatCompletions",
        models: ["fixture"],
        parameters: {},
      },
      expectedRevision: 0,
    });
    await f.remote.control({ operation: "enableDirect" });
    async function device({ identity, pair = true } = {}) {
      identity ??= await createIdentity();
      const invite = pair
        ? new URLSearchParams(
            new URL(
              (await f.remote.control({ operation: "pair", transport: "direct" })).payload,
            ).hash.slice(1),
          ).get("invite")
        : null;
      const origin = f.remote.state().directUrl;
      const socket = new WebSocket(origin.replace(/^http/, "ws") + "/remote/socket", { origin });
      t.after(() => socket.terminate());
      const { wire, ready } = createRemoteWire(socket);
      await ready;
      const secure = await secureChannel(wire, identity, identityId(f.remote.config.identity));
      const messages = secure.messages();
      secure.send({
        method: "hello",
        apiVersion: "areal.remote.v2",
        clientVersion: "rc07-native",
        displayName: "Original RC07 device",
        ...(invite ? { inviteSecret: invite } : {}),
      });
      let active = (await messages.next()).value;
      if (pair) {
        assert.equal(active.event, "pairing");
        await f.remote.control({
          operation: "approve",
          id: identityId(identity),
          projects: [project.alias],
          preset: "Operator",
        });
        active = (await messages.next()).value;
      }
      assert.equal(active.event, "ready");
      const pending = new Map();
      const events = [];
      const pump = (async () => {
        for await (const message of messages) {
          const callback = pending.get(message.id);
          if (callback) {
            pending.delete(message.id);
            callback.resolve(message);
          } else events.push(message);
        }
      })()
        .catch((error) => {
          for (const callback of pending.values()) callback.reject(error);
        })
        .finally(() => {
          for (const callback of pending.values())
            callback.reject(new Error("original RC07 connection closed"));
          pending.clear();
        });
      t.after(async () => {
        secure.close();
        socket.terminate();
        await pump;
      });
      return {
        identity,
        active,
        events,
        socket,
        rpc(method, params = {}, commandId, context) {
          const id = randomUUID();
          const reply = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
          secure.send({
            id,
            method,
            params,
            context: context ?? {
              projectId: project.alias,
              ...(commandId
                ? {
                    gatewayGeneration: active.gatewayGeneration,
                    grantRevision: active.grantRevision,
                    serviceGeneration: project.service.generation,
                  }
                : {}),
            },
            ...(commandId ? { commandId } : {}),
          });
          return reply;
        },
      };
    }
    let a = await device();
    const b = await device();
    async function interaction(
      kind = "approval",
      text = "exact",
      timeoutSeconds = 600,
      existingThread,
    ) {
      const marker = randomUUID();
      const seed = {
        marker,
        kind,
        text,
        path: `${marker}.txt`,
        timeoutSeconds,
        questions: [
          { id: "choice", title: "Pick", options: ["a", "b"], allowFreeText: false },
          { id: "text", title: "Explain", options: [], allowFreeText: true },
        ],
      };
      seeds.set(marker, seed);
      const { thread } = existingThread
        ? { thread: { id: existingThread } }
        : await project.core.call("areal/thread/start", {
            requestId: randomUUID(),
            cwd: project.workspace,
            agentProfile: { id: "fixture", revision: "v1" },
          });
      if (!existingThread)
        await project.core.call("areal/thread/configure", {
          threadId: thread.id,
          expectedRevision: 1,
          model: { providerId: "interaction-native", modelId: "fixture" },
        });
      const { turn } = await project.core.call("areal/turn/start", {
        requestId: randomUUID(),
        threadId: thread.id,
        expectedConfigRevision: 2,
        input: [{ type: "text", text: marker }],
      });
      let listBytes;
      const item = await until(async () => {
        const listed = await project.core.call("areal/interaction/list", { threadId: thread.id });
        listBytes = Buffer.byteLength(JSON.stringify(listed));
        return listed.data.find((value) => value.turnId === turn.id);
      }, "the original real Core interaction");
      assert.equal(item.kind, kind);
      if (timeoutSeconds > 1) assert.equal(item.status, "pending");
      return {
        ...seed,
        item,
        listBytes,
        target: { threadId: thread.id, turnId: turn.id, interactionId: item.requestId },
      };
    }
    const settled = (value) =>
      until(async () => {
        const current = await project.core.call("thread/read", {
          threadId: value.target.threadId,
          includeTurns: true,
        });
        return ["completed", "failed", "interrupted"].includes(
          current.thread.turns.find((turn) => turn.id === value.target.turnId)?.status,
        );
      }, "the original interaction Turn settles");
    const detail = async (value, phone = a, params = value.target) => {
      const response = await phone.rpc("attention.read", params);
      assert.ok(response.result, JSON.stringify(response));
      return response.result;
    };
    const respond = (value, params, phone = a, commandId = randomUUID()) =>
      phone.rpc("interaction.respond", { ...value.target, ...params }, commandId);
    async function review(value, phone = a) {
      let page = await detail(value, phone);
      const first = page;
      let body = page.review.chunk;
      while (page.nextCursor) {
        page = await detail(value, phone, { ...value.target, cursor: page.nextCursor });
        assert.equal(page.review.offset, Buffer.byteLength(body));
        assert.equal(page.argumentsDigest, first.argumentsDigest);
        assert.equal(page.threadId, first.threadId);
        assert.equal(page.turnId, first.turnId);
        assert.equal(page.interactionId, first.interactionId);
        assert.ok(Buffer.byteLength(JSON.stringify(page)) < 128 * 1024);
        body += page.review.chunk;
      }
      assert.equal(Buffer.byteLength(body), page.review.totalBytes);
      assert.deepEqual(JSON.parse(body).effectiveArguments, value.item.effectiveArguments ?? null);
      return page;
    }
    async function check(name, run) {
      await pause(1050);
      await run();
      proof.checks.push(name);
      proof.ownerRemaining = originalChecks.filter((value) => !proof.checks.includes(value));
      await persist();
    }
    const first = await interaction();
    let foreground;
    await check(originalChecks[0], async () => {
      const opened = await a.rpc("session.open", { threadId: first.target.threadId });
      assert.ok(opened.result, JSON.stringify(opened));
      foreground = opened.result;
      const journal = await f.client.journal(project.projectId).read();
      const page = await detail(first);
      assert.equal(page.threadId, first.target.threadId);
      assert.equal(page.turnId, first.target.turnId);
      assert.equal(page.interactionId, first.target.interactionId);
      assert.equal(page.argumentsDigest, first.item.argumentsDigest);
      assert.deepEqual(page.effectiveArguments, first.item.effectiveArguments);
      assert.equal(page.complete, true);
      assert.ok(page.reviewToken);
      assert.deepEqual(await f.client.journal(project.projectId).read(), journal);
      const history = await a.rpc("session.history", { threadId: first.target.threadId });
      assert.equal(history.result?.subscriptionId, foreground.subscriptionId);
      assert.equal(history.result.connectionId, foreground.connectionId);
      await assert.rejects(readFile(join(project.workspace, first.path)), { code: "ENOENT" });
    });
    await check(originalChecks[1], async () => {
      const page = await review(first);
      const params = {
        decision: "allowOnce",
        argumentsDigest: first.item.argumentsDigest,
        reviewToken: page.reviewToken,
      };
      const commandId = randomUUID();
      const response = await respond(first, params, a, commandId);
      assert.equal(response.result?.admissionState, "accepted", JSON.stringify(response));
      assert.equal(response.result.turnId, first.target.turnId);
      assert.notEqual(response.result.operationId, first.target.interactionId);
      const duplicate = await respond(first, { ...params, reviewToken: "expired" }, a, commandId);
      assert.equal(duplicate.result?.operationId, response.result.operationId);
      assert.equal((await a.rpc("command.read", { commandId })).result.admissionState, "accepted");
      const { snapshot } = await f.client.journal(project.projectId).read();
      const record = snapshot.outcomes[response.result.operationId];
      assert.equal(record.remote.target.interactionId, first.target.interactionId);
      assert.equal(record.threadId, first.target.threadId);
      assert.equal(record.turnId, first.target.turnId);
      await until(async () => {
        try {
          return (await readFile(join(project.workspace, first.path), "utf8")) === first.text;
        } catch (error) {
          if (error.code === "ENOENT") return false;
          throw error;
        }
      }, "the reviewed original Runtime effect");
      await until(
        () =>
          a.events.some(
            (event) =>
              event.event === "session.updated" &&
              event.subscriptionId === foreground.subscriptionId,
          ),
        "the foreground viewer retains its original subscription",
      );
    });
    await check(originalChecks[2], async () => {
      const value = await interaction("approval", "界".repeat(20000));
      const partial = await detail(value);
      assert.equal(partial.complete, false);
      assert.equal(partial.reviewToken, null);
      assert.equal(partial.effectiveArguments, undefined);
      const params = { decision: "allowOnce", argumentsDigest: value.item.argumentsDigest };
      assert.equal((await respond(value, params)).error?.code, "REVIEW_INCOMPLETE");
      assert.equal(
        (await respond(value, { ...params, reviewToken: partial.nextCursor })).error?.code,
        "REVIEW_INCOMPLETE",
      );
      const page = await review(value);
      assert.equal(
        (await respond(value, { ...params, reviewToken: page.reviewToken })).result?.admissionState,
        "accepted",
      );
      const denied = await interaction("approval", "界".repeat(20000));
      assert.equal((await detail(denied)).complete, false);
      assert.equal(
        (await respond(denied, { decision: "deny", argumentsDigest: denied.item.argumentsDigest }))
          .result?.admissionState,
        "accepted",
      );
      await settled(denied);
      await assert.rejects(readFile(join(project.workspace, denied.path)), { code: "ENOENT" });
    });
    await pause(1050);
    {
      const value = await interaction("approval", "x".repeat(40000));
      const page = await detail(value);
      assert.ok(page.nextCursor);
      const params = { ...value.target, cursor: page.nextCursor };
      const samePeer = await device({ identity: a.identity, pair: false });
      assert.equal((await samePeer.rpc("attention.read", params)).error?.code, "TARGET_CHANGED");
      assert.equal((await b.rpc("attention.read", params)).error?.code, "TARGET_CHANGED");
      assert.equal(
        (await a.rpc("attention.read", { ...params, turnId: randomUUID() })).error?.code,
        "TARGET_CHANGED",
      );
      const identity = a.identity;
      const previous = a;
      await f.remote.control({
        operation: "updateGrant",
        id: identityId(identity),
        projects: [project.alias],
        preset: "Operator",
      });
      await until(
        () => previous.socket.readyState === 3 && samePeer.socket.readyState === 3,
        "the original grant revision closes its authenticated connections",
      );
      a = await device({ identity, pair: false });
      assert.equal(a.active.grantRevision, previous.active.grantRevision + 1);
      assert.equal((await a.rpc("attention.read", params)).error?.code, "TARGET_CHANGED");
      assert.equal(
        (await respond(value, { decision: "deny", argumentsDigest: value.item.argumentsDigest }, b))
          .result?.admissionState,
        "accepted",
      );
      await settled(value);
      proof.partialChecks = [
        {
          name: originalChecks[3],
          proved: [
            "connection-bound cursor",
            "device-bound cursor",
            "original target",
            "grant revision invalidates original connections",
          ],
          remaining: ["Core generation fence", "synthetic same-digest body mutation"],
        },
      ];
      await persist();
    }
    await check(originalChecks[4], async () => {
      const value = await interaction();
      const page = await review(value);
      const params = {
        decision: "allowOnce",
        argumentsDigest: value.item.argumentsDigest,
        reviewToken: page.reviewToken,
      };
      for (const patch of [
        { threadId: randomUUID() },
        { turnId: randomUUID() },
        { interactionId: randomUUID() },
        { argumentsDigest: "f".repeat(64) },
      ]) {
        assert.equal((await respond(value, { ...params, ...patch })).error?.code, "TARGET_CHANGED");
      }
      for (const decision of ["allowSession", "allowProject", "allow"])
        assert.equal((await respond(value, { ...params, decision })).error?.code, "INVALID_PARAMS");
      const expired = await interaction("question", "", 1);
      await until(
        async () =>
          (
            await project.core.call("areal/interaction/list", { threadId: expired.target.threadId })
          ).data.find((item) => item.requestId === expired.item.requestId)?.status !== "pending",
        "the original question expires in Core",
      );
      const expiredPage = await review(expired);
      assert.equal(
        (
          await respond(expired, {
            answers: { choice: "a", text: "ok" },
            reviewToken: expiredPage.reviewToken,
          })
        ).error?.code,
        "TARGET_CHANGED",
      );
      await assert.rejects(readFile(join(project.workspace, value.path)), { code: "ENOENT" });
      await respond(value, { decision: "deny", argumentsDigest: value.item.argumentsDigest });
    });
    await check(originalChecks[5], async () => {
      const observedBytes = [];
      let threadId;
      let pending;
      for (let index = 0; index < 128; index++) {
        const value = await interaction("approval", "x".repeat(60000), 600, threadId);
        threadId = value.target.threadId;
        observedBytes.push(value.listBytes);
        if (value.listBytes > 4 * 1024 * 1024) {
          pending = value;
          break;
        }
        const receipt = await project.core.call("areal/interaction/respond", {
          threadId,
          turnId: value.target.turnId,
          requestId: value.item.requestId,
          argumentsDigest: value.item.argumentsDigest,
          decision: "deny",
        });
        assert.equal(receipt.decision, "deny");
        await settled(value);
      }
      proof.readBudget = {
        argumentTextBytes: 60000,
        observedListBytes: observedBytes,
        target: pending?.target,
      };
      await persist();
      assert.ok(pending, "the authoritative unpaged Core interaction history crosses 4MiB");
      assert.equal(
        (await a.rpc("attention.read", pending.target)).error?.code,
        "RESOURCE_UNAVAILABLE",
      );
      const denied = await respond(pending, {
        decision: "deny",
        argumentsDigest: pending.item.argumentsDigest,
      });
      assert.equal(denied.result?.admissionState, "accepted", JSON.stringify(denied));
      assert.equal(denied.result.receipt.decision, "deny");
      await settled(pending);
      await assert.rejects(readFile(join(project.workspace, pending.path)), { code: "ENOENT" });
    });
    await check(originalChecks[6], async () => {
      const value = await interaction("question");
      const page = await detail(value);
      assert.deepEqual(page.questions, value.item.questions);
      const journal = await f.client.journal(project.projectId).read();
      for (const answers of [
        { choice: "a" },
        { choice: "a", text: "ok", extra: "bad" },
        { choice: "other", text: "ok" },
        { choice: "a", text: "界".repeat(1365) + "ab" },
      ]) {
        assert.equal(
          (await respond(value, { answers, reviewToken: page.reviewToken })).error?.code,
          "INVALID_PARAMS",
        );
      }
      assert.deepEqual(await f.client.journal(project.projectId).read(), journal);
      const answers = { choice: "a", text: "界".repeat(1365) + "a" };
      assert.equal(Buffer.byteLength(answers.text), 4096);
      const params = { answers, reviewToken: page.reviewToken };
      const commandId = randomUUID();
      const running = respond(value, params, a, commandId);
      answers.text = "caller changed after start";
      const response = await running;
      assert.equal(response.result?.admissionState, "accepted", JSON.stringify(response));
      const answered = (
        await project.core.call("areal/interaction/list", { threadId: value.target.threadId })
      ).data.find((item) => item.requestId === value.item.requestId);
      assert.equal(answered.response.answers.text, "界".repeat(1365) + "a");
      assert.equal(Object.hasOwn(answered.response, "argumentsDigest"), false);
      assert.equal((await respond(value, params, a, commandId)).error?.code, "COMMAND_CONFLICT");
      assert.equal((await a.rpc("command.read", { commandId })).result.admissionState, "accepted");
    });
    await check(originalChecks[15], async () => {
      const opened = await a.rpc("session.open", { threadId: first.target.threadId });
      assert.ok(opened.result, JSON.stringify(opened));
      const journal = await f.client.journal(project.projectId).read();
      const pages = await Promise.all(
        Array.from({ length: 17 }, () => a.rpc("attention.read", first.target)),
      );
      for (const page of pages) {
        assert.ok(page.result, JSON.stringify(page));
        assert.equal(page.result.threadId, first.target.threadId);
        assert.equal(page.result.turnId, first.target.turnId);
        assert.equal(page.result.interactionId, first.target.interactionId);
        assert.equal(page.result.argumentsDigest, first.item.argumentsDigest);
        assert.equal(page.result.complete, true);
      }
      const history = await a.rpc("session.history", { threadId: first.target.threadId });
      assert.equal(history.result?.subscriptionId, opened.result.subscriptionId);
      assert.equal(history.result.connectionId, opened.result.connectionId);
      assert.equal(a.socket.readyState, WebSocket.OPEN);
      assert.deepEqual(await f.client.journal(project.projectId).read(), journal);
      proof.concurrentDetailReads = {
        submitted: pages.length,
        completed: pages.length,
        subscriptionId: history.result.subscriptionId,
        connectionId: history.result.connectionId,
        observation:
          "real wire pipelining and subscription continuity; private queue size unmeasured",
      };
    });
    await check(originalChecks[16], async () => {
      assert.ok(a.active.capabilities.includes("answer"));
      assert.ok(a.active.methods.includes("attention.read"));
      assert.ok(a.active.methods.includes("interaction.respond"));
      const value = await interaction();
      const page = await detail(value);
      const params = {
        decision: "allowOnce",
        argumentsDigest: page.argumentsDigest,
        reviewToken: page.reviewToken,
      };
      assert.equal(
        (await respond(value, { ...params, decision: "allowProject" })).error?.code,
        "INVALID_PARAMS",
      );
      assert.equal(
        (await a.rpc("attention.read", { ...value.target, endpoint: "ws://injected" })).error?.code,
        "INVALID_PARAMS",
      );
      const commandId = randomUUID();
      const response = await respond(value, params, a, commandId);
      assert.equal(response.result?.admissionState, "accepted");
      assert.equal(response.result.observedState.status, "answered");
      assert.equal(
        (await respond(value, { ...params, reviewToken: "expired" }, a, commandId)).result
          ?.operationId,
        response.result.operationId,
      );
    });
    proof.complete = proof.ownerRemaining.length === 0;
    proof.subsetComplete = expectedChecks.every((name) => proof.checks.includes(name));
    await persist();
    assert.deepEqual(proof.checks, expectedChecks);
    assert.equal(proof.subsetComplete, true);
    t.diagnostic(
      `real-Core subset ${proof.checks.length}/${expectedChecks.length}; remaining boundaries are recorded separately`,
    );
    return proofPath;
  } finally {
    await persist();
  }
}
