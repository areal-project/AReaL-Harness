import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeHostFixture, nativeCoreProject } from "./remote-native-host-fixture.mjs";
import {
  hash,
  NEGATIVE_MS,
  until,
  observeNone,
  pushRelay,
  phone,
  grant,
  privateFree,
  runWithIsolatedCA,
} from "./remote-native-push-fixture.mjs";

function attentionFrame(relay, target) {
  return relay.frames.find(({ message }) => message.target?.attentionRef === target.attentionRef)
    ?.message;
}
function verifyAttention(message, target, projectId, token) {
  assert.equal(message.type === "push", true);
  assert.equal(message.kind === "attention", true);
  assert.equal(message.environment === "development", true);
  assert.equal(message.token === token, true, "the frame uses the exact current synthetic token");
  assert.equal(
    message.target.projectId === projectId,
    true,
    "push project matches the original public alias",
  );
  assert.equal(
    message.target.threadId === target.threadId,
    true,
    "push thread matches the real approval",
  );
  assert.equal(
    message.target.attentionRef === target.attentionRef,
    true,
    "push attention matches the real approval",
  );
  assert.equal(Number.isSafeInteger(message.count) && message.count > 0, true);
  assert.equal(typeof message.collapseId === "string" && message.collapseId.length > 0, true);
  const text = JSON.stringify(message);
  for (const secret of ["PRIVATE_PUSH_APPROVAL", "approved.txt", "approved once"])
    assert.equal(text.includes(secret), false, "push frame contains opaque references only");
}
function registered(response, expected) {
  assert.equal(response.error === undefined, true, "device command has a successful response");
  assert.equal(
    response.result?.registered === expected,
    true,
    "device command has the original registration result",
  );
  assert.equal(
    Object.keys(response.result).join(",") === "registered",
    true,
    "device result contains no credential fields",
  );
}

if (!process.env.RC12_TLS_HOME) {
  test("native push uses the isolated process CA", async () => {
    await runWithIsolatedCA(import.meta.filename);
  });
} else {
  test(
    "native approval attention reaches real Relay and fences token rotation, online state and revocation",
    { timeout: 240000 },
    async (t) => {
      const tokenA = "a".repeat(64),
        tokenB = "b".repeat(64),
        tokenC = "c".repeat(64);
      const tokens = [tokenA, tokenB, tokenC];
      const relay = await pushRelay(t, new Set([tokenA, tokenB]));
      const f = await nativeHostFixture(t);
      const native = await nativeCoreProject(t, f, { approval: true });
      const proof = { negativeObservationMs: NEGATIVE_MS, checks: [] };
      f.evidence.nativePush = proof;
      t.after(() => {
        proof.relay = relay.evidence();
        proof.modelRequests = native.modelRequests;
        privateFree(proof, tokens);
        return writeFile(
          join(f.evidence.root, "native-push-evidence.json"),
          JSON.stringify(proof, null, 2),
          { mode: 0o600 },
        );
      });
      await f.remote.control({
        operation: "enable",
        relay: relay.origin,
        code: relay.enrollment(),
        confirmed: true,
      });
      await until(async () => (await f.remote.refresh()).connected, "native Relay connected");
      const first = await phone(t, f.remote, native.alias, undefined, true);
      assert.equal(first.active.capabilities.includes("push"), true);
      await until(() => relay.ready.includes(true), "actual Relay ready push capability");
      const registration = randomUUID();
      registered(
        await first.rpc(
          "device.push.register",
          { platform: "apns", token: tokenA, environment: "development" },
          registration,
        ),
        true,
      );
      registered(
        await first.rpc(
          "device.push.register",
          { environment: "development", token: tokenA.toUpperCase(), platform: "apns" },
          registration,
        ),
        true,
      );
      assert.equal(
        (
          await first.rpc(
            "device.push.register",
            { platform: "apns", token: tokenB, environment: "development" },
            registration,
          )
        ).error?.code === "COMMAND_CONFLICT",
        true,
      );
      const original = (await first.rpc("command.read", { commandId: registration })).result;
      assert.equal(original.admissionState, "accepted");
      assert.equal(original.receipt.registered, true);
      const savedDigest = (await f.persisted()).pushCommands.find(
        (command) => command.devicePeerId === first.peer && command.commandId === registration,
      )?.semanticDigest;
      assert.equal(
        savedDigest ===
          hash(
            JSON.stringify({
              method: "device.push.register",
              params: { platform: "apns", token: tokenA, environment: "development" },
            }),
          ),
        true,
        "native encrypted command digest preserves the original JS field ordering",
      );
      const fresh = await f.make();
      const stored = await grant(fresh, first.peer);
      assert.equal(stored.pushRegistered, true);
      assert.equal(stored.revision, first.active.grantRevision);
      privateFree(fresh.state(), tokens);
      proof.checks.push(
        "Noise registration original receipt, canonical replay, conflict and fresh public state",
      );

      const online = await native.createApproval();
      await observeNone(
        () => relay.frames.length,
        "online phone suppresses native attention wire sends within two product periods",
      );
      await native.denyApproval(online);
      first.close();
      await until(
        async () => (await grant(f.remote, first.peer)).online === false,
        "native phone offline authority",
      );
      await observeNone(
        () => relay.frames.length,
        "offline baseline does not invent a notification for old attention",
      );

      const a = await native.createApproval();
      const frameA = await until(
        () => attentionFrame(relay, a),
        "new real Core approval reaches actual Relay wire",
      );
      verifyAttention(frameA, a, native.alias, tokenA);
      await until(
        () => relay.records.find((record) => record.token === tokenA),
        "actual APNs request for original token",
      );
      const rotated = await phone(t, f.remote, native.alias, first.identity);
      const rotation = randomUUID();
      registered(
        await rotated.rpc(
          "device.push.register",
          { platform: "apns", token: tokenB, environment: "development" },
          rotation,
        ),
        true,
      );
      relay.release(tokenA, 410);
      await until(
        () =>
          relay.results.some(
            ({ message }) => message.token === tokenA && message.status === "unregistered",
          ),
        "real Relay returns the late original-token 410",
      );
      assert.equal((await grant(fresh, first.peer)).pushRegistered, true);
      await native.denyApproval(a);
      rotated.close();
      await until(
        async () => (await grant(f.remote, first.peer)).online === false,
        "rotated phone offline authority",
      );
      const b = await native.createApproval();
      const frameB = await until(
        () => attentionFrame(relay, b),
        "late original-token 410 preserves actual current-token delivery",
      );
      verifyAttention(frameB, b, native.alias, tokenB);
      assert.equal(
        frameB.collapseId === frameA.collapseId,
        true,
        "fresh approval shares the current collapse window",
      );
      assert.equal(
        frameB.count === frameA.count + 1,
        true,
        "collapse count advances once for the next original approval",
      );
      await until(
        () => relay.records.find((record) => record.token === tokenB),
        "actual APNs current token request",
      );
      relay.release(tokenB, 410);
      await until(
        () => relay.results.some(({ message }) => message.token === tokenB),
        "current-token 410 reaches the native owner",
      );
      const after410 = await f.make();
      await until(
        async () => (await grant(after410, first.peer)).pushRegistered === false,
        "current-token removal persists through a fresh public facade",
      );
      privateFree(after410.state(), tokens);
      await native.denyApproval(b);
      proof.checks.push(
        "real approval Relay/APNs frames, collapse increment, late old-token 410 and persisted current-token removal",
      );

      const finalPhone = await phone(t, f.remote, native.alias, first.identity);
      assert.equal(
        (await finalPhone.rpc("command.read", { commandId: rotation })).result.receipt.registered,
        true,
        "historical original registration receipt survives token removal",
      );
      const unregister = randomUUID();
      registered(await finalPhone.rpc("device.push.unregister", {}, unregister), false);
      registered(await finalPhone.rpc("device.push.unregister", {}, unregister), false);
      assert.equal(
        (await finalPhone.rpc("command.read", { commandId: unregister })).result.receipt.registered,
        false,
      );
      assert.equal(
        (await finalPhone.rpc("command.read", { commandId: registration })).result.receipt
          .registered,
        true,
        "unregister does not rewrite historical registration receipts",
      );
      registered(
        await finalPhone.rpc(
          "device.push.register",
          { platform: "apns", token: tokenC, environment: "development" },
          randomUUID(),
        ),
        true,
      );
      const pending = await native.createApproval();
      await f.remote.control({ operation: "revoke", id: first.peer });
      await until(
        async () => (await grant(f.remote, first.peer)).status === "revoked",
        "native revocation authority",
      );
      const before = relay.frames.length;
      await observeNone(
        () => relay.frames.length - before,
        "revocation fences pre-existing Core attention without sending the revoked token",
      );
      await native.denyApproval(pending);
      const revokedFresh = await native.createApproval();
      await observeNone(
        () => relay.frames.length - before,
        "revocation fences newly observed Core attention",
      );
      await native.denyApproval(revokedFresh);
      assert.equal(relay.evidence().tapErrors, 0);
      privateFree(f.remote.state(), tokens);
      proof.checks.push(
        "bounded online/offline baseline and revocation observations; no completion or queue-watch claim",
      );
    },
  );
}
