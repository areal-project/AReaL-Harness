import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";

// 独立身份只用于隔离验收，避免旧版 safeStorage 命中安装版钥匙串。
export function isolatedElectronIdentity(hostHome, nativeHome, coreUserHome, electronVersion) {
  const runId = randomUUID();
  const appName = `AReaL H2 SafeStorage Test ${runId}`;
  return {
    runId,
    appName,
    service: appName + " Safe Storage",
    account: appName + " Key",
    hostService: "org.areal.host.v1." + createHash("sha256").update(hostHome).digest("hex"),
    electronVersion,
    nativeHome,
    coreUserHome,
  };
}

export async function prepareIsolatedElectron({
  root,
  installedElectron,
  identity,
  run,
  afterCopy,
}) {
  const bundle = join(root, "Electron.app");
  const executable = join(bundle, "Contents/MacOS/Electron");
  const plist = join(bundle, "Contents/Info.plist");
  const commands = [
    ["electron-copy", "/usr/bin/ditto", [resolve(installedElectron, "../../.."), bundle]],
    [
      "electron-name",
      "/usr/libexec/PlistBuddy",
      ["-c", `Set :CFBundleName ${identity.appName}`, plist],
    ],
    [
      "electron-display-name",
      "/usr/libexec/PlistBuddy",
      ["-c", `Set :CFBundleDisplayName ${identity.appName}`, plist],
    ],
    [
      "electron-id",
      "/usr/libexec/PlistBuddy",
      ["-c", `Set :CFBundleIdentifier org.areal.h2.${identity.runId}`, plist],
    ],
    ["electron-sign", "/usr/bin/codesign", ["--force", "--sign", "-", bundle]],
    ["electron-verify", "/usr/bin/codesign", ["--verify", "--strict", bundle]],
    ["electron-signature", "/usr/bin/codesign", ["-dvv", bundle]],
  ];
  for (const [name, command, args] of commands) {
    const result = await run(name, command, args);
    assert.equal(result.code, 0, `${name} succeeds`);
    if (name === "electron-copy") await afterCopy(bundle);
  }
  return { bundle, executable, plist };
}

export async function cleanIsolatedKeychainEntry({
  service,
  account,
  expectedKeychain,
  security,
  cleanup,
  save,
}) {
  const item = { service, account, state: "pending" };
  cleanup.entries.push(item);
  await save();
  if (cleanup.unsettledHostHomes?.length) {
    item.state = "retained";
    item.reason = "Original Host stop remains unconfirmed; preserve synthetic recovery entries";
    await save();
    return;
  }
  const missing = (result) => result.code === 44 && result.stderr.includes("could not be found");
  const found = await security(["find-generic-password", "-s", service, "-a", account]);
  item.findExit = found.code;
  if (missing(found)) {
    item.state = "absent";
    return;
  }
  assert.equal(found.code, 0, `exact Keychain lookup failed for ${service}/${account}`);
  const keychain = /^keychain: "([^"\n]+)"/m.exec(found.stdout)?.[1];
  assert(keychain?.startsWith("/"), "exact Keychain metadata must identify its database");
  if (expectedKeychain) assert.equal(keychain, expectedKeychain, "cleanup exact original database");
  item.keychain = keychain;
  await save();
  const deleted = await security([
    "delete-generic-password",
    "-s",
    service,
    "-a",
    account,
    keychain,
  ]);
  item.deleteExit = deleted.code;
  assert.equal(deleted.code, 0, `exact test Keychain deletion failed for ${service}/${account}`);
  const after = await security(["find-generic-password", "-s", service, "-a", account, keychain]);
  item.verifyExit = after.code;
  assert(missing(after), "test Keychain item must be absent after exact deletion");
  item.state = "removed";
}

export function isolatedElectronBootstrapPrefix(identityPath) {
  return `const assert = require("node:assert/strict");
const { appendFileSync, writeFileSync } = require("node:fs");
const { app, safeStorage } = require("electron");
const identity = require(${JSON.stringify(identityPath)});
const target = JSON.parse(process.env.AREAL_H2_TEST_ENTRY);
assert.equal(app.isReady(), false, "identity must be set synchronously before ready");
assert.equal(app.getName(), identity.appName, "native startup name before override");
const nativeSetName = app.setName.bind(app);
nativeSetName(identity.appName);
app.setName = (name) => {
  assert(["AReaL Harness GUI", identity.appName].includes(name), "unexpected application name");
  nativeSetName(identity.appName);
};
const original = {
  object: safeStorage,
  encrypt: safeStorage.encryptString,
  decrypt: safeStorage.decryptString,
  available: safeStorage.isEncryptionAvailable,
};
function check(phase) {
  assert.equal(app.getName(), identity.appName, "native application identity");
  assert.equal(require("electron").safeStorage, original.object);
  assert.equal(safeStorage.encryptString, original.encrypt);
  assert.equal(safeStorage.decryptString, original.decrypt);
  assert.equal(safeStorage.isEncryptionAvailable, original.available);
  appendFileSync(target.evidence, JSON.stringify({
    phase, pid: process.pid, appName: app.getName(),
    service: identity.service, account: identity.account,
    realSafeStorageReferences: true,
  }) + "\\n", { mode: 0o600 });
}
check("before-load");
app.once("will-finish-launching", () => check("will-finish-launching"));
app.once("ready", () => check("ready"));
`;
}
