import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanIsolatedKeychainEntry,
  isolatedElectronIdentity,
  prepareIsolatedElectron,
} from "./isolated-electron-identity.mjs";

test("isolated Electron identities do not share Keychain entries", () => {
  const a = isolatedElectronIdentity("/tmp/host-a", "/tmp/user", "/tmp/core", "1");
  const b = isolatedElectronIdentity("/tmp/host-b", "/tmp/user", "/tmp/core", "1");
  assert.notEqual(a.service, b.service);
  assert.notEqual(a.account, b.account);
  assert.notEqual(a.hostService, b.hostService);
});

test("signing occurs only after the isolated app is prepared", async () => {
  const steps = [];
  await prepareIsolatedElectron({
    root: "/tmp/test",
    installedElectron: "/tmp/installed/Contents/MacOS/Electron",
    identity: isolatedElectronIdentity("/tmp/host", "/tmp/user", "/tmp/core", "1"),
    run: async (name) => {
      steps.push(name);
      return { code: 0 };
    },
    afterCopy: async () => {
      steps.push("prepare");
    },
  });
  assert.ok(steps.indexOf("electron-copy") < steps.indexOf("prepare"));
  assert.ok(steps.indexOf("prepare") < steps.indexOf("electron-sign"));
  assert.ok(steps.indexOf("electron-sign") < steps.indexOf("electron-verify"));
});

test("unsettled Host retains its synthetic Keychain entry", async () => {
  const cleanup = { entries: [], unsettledHostHomes: ["/tmp/host"] };
  await cleanIsolatedKeychainEntry({
    service: "s",
    account: "a",
    cleanup,
    save: async () => {},
    security: () => assert.fail("must not access Keychain"),
  });
  assert.equal(cleanup.entries[0].state, "retained");
});

test("cleanup refuses to delete from a different Keychain", async () => {
  const cleanup = { entries: [] };
  await assert.rejects(
    cleanIsolatedKeychainEntry({
      service: "s",
      account: "a",
      expectedKeychain: "/expected",
      cleanup,
      save: async () => {},
      security: async () => ({ code: 0, stdout: 'keychain: "/other"', stderr: "" }),
    }),
    /cleanup exact original database/,
  );
  assert.equal(cleanup.entries[0].state, "pending");
});

test("cleanup deletes only the identified item and verifies absence", async () => {
  const cleanup = { entries: [] };
  const calls = [];
  await cleanIsolatedKeychainEntry({
    service: "test-service",
    account: "test-account",
    expectedKeychain: "/test.keychain",
    cleanup,
    save: async () => {},
    security: async (args) => {
      calls.push(args);
      if (calls.length === 1) return { code: 0, stdout: 'keychain: "/test.keychain"', stderr: "" };
      if (calls.length === 2) return { code: 0, stdout: "", stderr: "" };
      return { code: 44, stdout: "", stderr: "could not be found" };
    },
  });
  assert.deepEqual(calls[1], [
    "delete-generic-password",
    "-s",
    "test-service",
    "-a",
    "test-account",
    "/test.keychain",
  ]);
  assert.equal(cleanup.entries[0].state, "removed");
});
