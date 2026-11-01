// @ts-check
"use strict";
const { createHash } = require("node:crypto");
const { constants } = require("node:fs");
const { open, readFile, writeFile, realpath } = require("node:fs/promises");
const { isAbsolute, join, relative, sep } = require("node:path");
const { HostClient } = require("./host-client.cjs");

/** @typedef {{profile:string,coreHome:string,legacyServiceHome:string}} GuiSource */
/** @typedef {{slot:{kind:string,reference?:string,providerId?:string},sourceDigest:string,relativeName:string,readPath:string}} PendingSecret */
/** @param {unknown} value @returns {value is Record<string,unknown>} */
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
/** @param {unknown} source @returns {Promise<GuiSource>} */
async function canonicalSource(source) {
  if (!record(source)) throw new Error("GUI migration source is required");
  const paths = [source.profile, source.coreHome, source.legacyServiceHome].map((path) => {
    if (typeof path !== "string" || !isAbsolute(path))
      throw new Error("GUI migration homes must be absolute");
    return path;
  });
  const [profile, coreHome, legacyServiceHome] = await Promise.all(
    paths.map((path) => realpath(path)),
  );
  if (new Set([profile, coreHome, legacyServiceHome]).size !== 3)
    throw new Error("GUI profile, Core home and legacy service home must be separate");
  return { profile, coreHome, legacyServiceHome };
}

// 仅在原 Desktop singleton 已取得、业务对象尚未初始化时使用。
class GuiSourceAdapter {
  /** @param {{source:GuiSource,hostHome:string,encryption:import('electron').SafeStorage,singletonHeld:boolean}} options */
  constructor(options) {
    if (!options.singletonHeld) throw new Error("Original Desktop singleton is required");
    this.source = options.source;
    this.hostHome = options.hostHome;
    this.encryption = options.encryption;
  }
  /** @param {PendingSecret} secret */
  async extract(secret) {
    if (
      !record(secret) ||
      !record(secret.slot) ||
      typeof secret.readPath !== "string" ||
      !/^[a-f0-9]{64}$/.test(secret.sourceDigest)
    )
      throw new Error("Invalid Host secret manifest");
    const backup = await realpath(secret.readPath);
    const directory = await realpath(join(this.hostHome, "host"));
    const within = relative(directory, backup);
    if (!within || within === ".." || within.startsWith(".." + sep) || isAbsolute(within))
      throw new Error("Secret backup is outside Host private storage");
    const file = await open(secret.readPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
        throw new Error("Secret backup must be private and owned by this user");
      bytes = await file.readFile();
    } finally {
      await file.close();
    }
    if (createHash("sha256").update(bytes).digest("hex") !== secret.sourceDigest)
      throw Object.assign(new Error("GUI migration source bytes changed"), {
        code: "sourceChanged",
      });
    const value = JSON.parse(bytes.toString("utf8"));
    if (!record(value)) throw new Error("Invalid GUI secret source");
    if (
      secret.relativeName === "subscription-transport.json" &&
      secret.slot.kind === "subscriptionTransport"
    )
      return require("./subscription.cjs").transportRecord(value);
    if (
      !this.encryption.isEncryptionAvailable() ||
      this.encryption.getSelectedStorageBackend?.() === "basic_text"
    )
      throw Object.assign(new Error("Unlock system secure storage before importing credentials"), {
        code: "storageLocked",
      });
    const encrypted = (() => {
      if (
        secret.relativeName === "provider-credentials.json" &&
        secret.slot.kind === "providerCredential"
      )
        return record(value.keys) && typeof secret.slot.reference === "string"
          ? value.keys[secret.slot.reference]
          : undefined;
      if (secret.relativeName === "providers.json" && secret.slot.kind === "providerCredential")
        return Array.isArray(value.data)
          ? value.data.find(
              (item) => record(item) && `AREAL_CREDENTIAL_${item.id}` === secret.slot.reference,
            )?.secret
          : undefined;
      if (
        secret.relativeName === "openai-subscription.json" &&
        secret.slot.kind === "subscriptionAccount" &&
        secret.slot.providerId === "openai"
      )
        return value.secret;
      if (secret.relativeName === "remote.json" && secret.slot.kind === "remoteIdentity")
        return value.encrypted;
      return undefined;
    })();
    if (typeof encrypted !== "string" || !encrypted)
      throw Object.assign(new Error("Manifest secret does not match its source slot"), {
        code: "credentialsRequired",
      });
    try {
      const decrypted = this.encryption.decryptString(Buffer.from(encrypted, "base64"));
      return secret.slot.kind === "providerCredential" ? decrypted : JSON.parse(decrypted);
    } catch {
      throw Object.assign(
        new Error("Saved credential could not be decrypted; source bytes are retained"),
        { code: "storageLocked" },
      );
    }
  }
  /** @param {string} requestId */
  async import(requestId) {
    const client = new HostClient();
    try {
      await client.connect(this.hostHome);
      await client.attachSource(this.source);
      let result = await client.importSource(requestId, this.source);
      if (Array.isArray(result.pendingSecrets) && result.pendingSecrets.length) {
        for (const secret of result.pendingSecrets) {
          const value = await this.extract(secret);
          const receipt = await client.importSecret(result.migrationId, secret, value);
          if (receipt.state !== "completed" || receipt.sourceDigest !== secret.sourceDigest)
            throw new Error("Host did not confirm durable secret storage");
        }
        result = await client.importSource(requestId, this.source);
      }
      return result;
    } finally {
      client.close();
    }
  }
}

/** @param {string} coreHome */
async function assertLegacySourceWritable(coreHome) {
  let bytes;
  try {
    bytes = await readFile(join(coreHome, "provider-credentials.json"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  // 旧 parser 也拒绝哨兵。这里提前失败，避免其前面的 Worktree/Remote 初始化。
  if (bytes.toString("utf8").startsWith("AREAL_HOST_"))
    throw Object.assign(
      new Error("GUI source belongs to shared Host; legacy writers are disabled"),
      { code: "GUI_SOURCE_MIGRATED" },
    );
}

/** @param {{app:import('electron').App,guiUserData:string,coreHome:string,legacyServiceHome:string,encryption:import('electron').SafeStorage}} options */
async function prepareGuiSource(options) {
  const importArgument = process.argv.find((value) =>
    value.startsWith("--areal-host-import-source="),
  );
  if (!importArgument) {
    await assertLegacySourceWritable(options.coreHome);
    return undefined;
  }
  const requestPath = importArgument.slice("--areal-host-import-source=".length);
  if (!isAbsolute(requestPath)) throw new Error("Import request path must be absolute");
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const source = await canonicalSource(request.source);
  if (
    source.coreHome !== options.coreHome ||
    source.profile !== (await realpath(options.guiUserData)) ||
    source.legacyServiceHome !== (await realpath(options.legacyServiceHome))
  )
    throw new Error("Import source must match the held Desktop singleton and explicit homes");
  if (typeof request.requestId !== "string" || typeof request.hostHome !== "string")
    throw new Error("Import requestId and Host home are required");
  if (typeof request.resultPath !== "string" || !isAbsolute(request.resultPath))
    throw new Error("Import resultPath must be absolute");
  const hostHome = await realpath(request.hostHome);
  if ([source.profile, source.coreHome, source.legacyServiceHome].includes(hostHome))
    throw new Error("Shared Host home must be separate from GUI source homes");
  await options.app.whenReady();
  const result = await new GuiSourceAdapter({
    source,
    hostHome,
    encryption: options.encryption,
    singletonHeld: true,
  }).import(request.requestId);
  await writeFile(request.resultPath, JSON.stringify(result) + "\n", { mode: 0o600 });
  return result;
}

module.exports = {
  GuiSourceAdapter,
  canonicalSource,
  assertLegacySourceWritable,
  prepareGuiSource,
};
