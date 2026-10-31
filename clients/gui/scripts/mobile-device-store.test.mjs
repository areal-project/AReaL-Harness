import assert from "node:assert/strict";
import test from "node:test";
import { createIdentity } from "../packages/remote/src/channel.mjs";
import { MobileClient } from "../renderer/src/mobile/mobile-client.mjs";
import { DeviceStore, parsePairingLink } from "../renderer/src/mobile/device-store.mjs";

const host = "A".repeat(40);
const room = "b".repeat(64);
const invite = "c".repeat(64);
const link = `https://relay.example/#host=${host}&room=${room}&invite=${invite}`;

test("pairing accepts only an HTTPS relay origin and complete validated locator", () => {
  assert.deepEqual(parsePairingLink(link), {
    host,
    room,
    invite,
    relayOrigin: "https://relay.example",
  });
  for (const candidate of [
    link.replace("https:", "http:"),
    link.replace("/#", "/path#"),
    link.replace("/#", "/?x=1#"),
    link.replace("relay.example", "user@relay.example"),
    link.replace(`&invite=${invite}`, ""),
    link.replace(room, "invalid"),
  ]) {
    assert.throws(() => parsePairingLink(candidate));
  }
});

test("a Keychain write failure rejects the transaction and preserves the existing identity", async () => {
  const original = JSON.stringify({
    schema: 1,
    relayOrigin: "https://relay.example",
    grantRevision: 2,
    client: { credential: "original" },
  });
  let value = original;
  const store = new DeviceStore({
    load: async () => ({ value }),
    save: async () => {
      throw new Error("locked");
    },
  });
  await assert.rejects(
    store.transaction(true, () => ({
      record: { credential: "replacement" },
      result: "remembered",
    })),
    /locked/,
  );
  assert.equal(value, original);
});

test("concurrent pending-locator updates commit serially and clear follows outstanding writes", async () => {
  let value = null;
  const store = new DeviceStore({
    load: async () => ({ value }),
    save: async (next) => {
      value = next.value;
    },
    clear: async () => {
      value = null;
    },
  });
  store.connection = { relayOrigin: "https://relay.example", grantRevision: 3 };
  await Promise.all(
    ["a", "b"].map((id) =>
      store.transaction(true, (record = { locators: [] }) => {
        record.locators.push(id);
        return { record, result: id };
      }),
    ),
  );
  assert.deepEqual((await store.load()).client.locators, ["a", "b"]);
  const writing = store.transaction(true, (record) => ({ record, result: null }));
  const clearing = store.clear();
  await Promise.all([writing, clearing]);
  assert.equal(await store.load(), null);
});

test("foreground restoration cannot invalidate a newer pairing identity", async () => {
  const identity = await createIdentity();
  const loading = Promise.withResolvers();
  const creating = Promise.withResolvers();
  let loads = 0;
  const client = new MobileClient({
    clientKind: "ios",
    keychain: { load: () => (++loads === 1 ? loading.promise : Promise.resolve({ value: null })) },
  });
  client.identities.createIdentity = () => creating.promise;
  client.active = true;
  let connected = false;
  client.connect = async (_target, token) => {
    client.identities.assertCurrent(token);
    connected = true;
  };
  const restoring = client.restore();
  const pairing = client.pair(link, "iPhone");
  loading.resolve({ value: null });
  await restoring;
  creating.resolve(identity);
  await pairing;
  assert.equal(connected, true);
  assert.equal(client.identities.current().mode, "remembering");
  assert.notEqual(client.snapshot().kind, "unpaired");
});

test("a failed Keychain clear keeps the device disconnected and rejects without claiming removal", async () => {
  const failure = new Error("KEYCHAIN_CLEAR");
  let closed = false;
  let rejected = false;
  const client = new MobileClient({
    clientKind: "ios",
    keychain: {
      clear: async () => {
        throw failure;
      },
    },
  });
  await client.identities.guest();
  client.connection = {
    socket: {
      close: () => {
        closed = true;
      },
    },
    rejectPending: () => {
      rejected = true;
    },
  };
  client.publish({ kind: "connected" });
  await assert.rejects(client.clear(), failure);
  assert.equal(closed, true);
  assert.equal(rejected, true);
  assert.equal(client.identities.current(), null);
  assert.equal(client.snapshot().kind, "blocked");
  await assert.rejects(client.request({ method: "project.list" }), /OFFLINE/);
});
