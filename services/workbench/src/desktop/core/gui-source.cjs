// @ts-check
"use strict";
const { createHash, randomUUID } = require("node:crypto");
const { constants } = require("node:fs");
const { open, readFile, writeFile, realpath, lstat, rename, unlink } = require("node:fs/promises");
const { isAbsolute, join, relative, sep, dirname } = require("node:path");
const { HostClient } = require("@areal/client/node");

/** @typedef {import("@areal/client/protocol").Source} GuiSource */
/** @typedef {{slot:{kind:string,reference?:string,providerId?:string},sourceDigest:string,relativeName:string,readPath:string}} PendingSecret */
/** @typedef {{site:'source'|'backup',relativeName:string,backupId:string,beforeDigest:string,afterDigest:string,byteLength:number}} RetirementTarget */
/** @typedef {{requestId:string,migrationId:string,planId:string,state:'applying'|'completed',next:RetirementTarget|null}} RetirementProgress */
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const RETIREMENT_FILES = new Set([
  "provider-credentials.json",
  "providers.json",
  "openai-subscription.json",
  "subscription-transport.json",
  "remote.json",
]);
/** @param {unknown} value @returns {value is Record<string,unknown>} */
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
/** @param {unknown} value @param {string} migrationId @returns {RetirementProgress} */
function retirementProgress(value, migrationId) {
  if (
    !record(value) ||
    value.migrationId !== migrationId ||
    typeof value.requestId !== "string" ||
    !UUID.test(value.requestId) ||
    typeof value.planId !== "string" ||
    !UUID.test(value.planId) ||
    (value.state !== "applying" && value.state !== "completed")
  )
    throw new Error("Invalid Host retirement progress");
  const next = value.next;
  if (
    next !== null &&
    (!record(next) ||
      (next.site !== "source" && next.site !== "backup") ||
      typeof next.relativeName !== "string" ||
      !RETIREMENT_FILES.has(next.relativeName) ||
      (next.site === "source" && next.relativeName === "provider-credentials.json") ||
      typeof next.backupId !== "string" ||
      !UUID.test(next.backupId) ||
      typeof next.beforeDigest !== "string" ||
      !DIGEST.test(next.beforeDigest) ||
      typeof next.afterDigest !== "string" ||
      !DIGEST.test(next.afterDigest) ||
      typeof next.byteLength !== "number" ||
      !Number.isSafeInteger(next.byteLength) ||
      next.byteLength < 0 ||
      value.state === "completed")
  )
    throw new Error("Invalid Host retirement target");
  return /** @type {RetirementProgress} */ (value);
}
/** @param {string} path */
async function retirementFile(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error("Retirement file must be private and owned by this user");
    return { file, stat };
  } catch (error) {
    await file.close();
    throw error;
  }
}
/** @param {import('node:fs/promises').FileHandle} file */
async function retirementDigest(file) {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  for (let position = 0; ;) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    if (!bytesRead) return hash.digest("hex");
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}
/** @param {string} root @param {string} path */
async function retirementDirectory(root, path) {
  if ((await realpath(root)) !== root) throw new Error("Retirement home changed");
  const parts = relative(root, path).split(sep).filter(Boolean);
  let directory = root;
  for (const part of ["", ...parts]) {
    directory = join(directory, part);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
      throw new Error("Retirement directory must be owned by this user without symlinks");
  }
}
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
  /** @param {{source:GuiSource,hostHome:string,encryption?:import('electron').SafeStorage,singletonHeld:boolean}} options */
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
      !this.encryption?.isEncryptionAvailable() ||
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
  /** @param {string} requestId @param {{publishOnly?:boolean}} [options] */
  async import(requestId, { publishOnly = false } = {}) {
    const client = new HostClient();
    try {
      await client.connect(this.hostHome);
      await client.attachSource(this.source);
      let result = await client.importSource(requestId, this.source);
      if (
        !publishOnly &&
        Array.isArray(result.pendingSecrets) &&
        result.pendingSecrets.length
      ) {
        /** @type {Map<string, typeof result.pendingSecrets>} */
        const slots = new Map();
        for (const secret of result.pendingSecrets) {
          const key = JSON.stringify(secret.slot);
          const group = slots.get(key) ?? [];
          group.push(secret);
          slots.set(key, group);
        }
        await Promise.all([...slots.values()].map(async (secrets) => {
          for (const secret of secrets) {
            try {
              const value = await this.extract(secret);
              const receipt = await client.importSecret(
                result.migrationId,
                secret,
                value,
              );
              if (
                receipt.state !== "completed" ||
                receipt.sourceDigest !== secret.sourceDigest
              )
                throw new Error("Host did not confirm durable secret storage");
            } catch (error) {
              // 同槽未确认时保留原顺序，独立槽继续，不重放未决写入。
              if (result.sourcePublished !== true) throw error;
              break;
            }
          }
        }));
        result = await client.importSource(requestId, this.source);
      }
      return result;
    } finally {
      client.close();
    }
  }
  /** @param {RetirementProgress} progress */
  async replaceRetirementTarget(progress) {
    const target = progress.next;
    if (!target) throw new Error("Host retirement prepare lacks a pending target");
    const importRoot = join(this.hostHome, "host", "imports", progress.migrationId);
    const path =
      target.site === "source"
        ? join(this.source.coreHome, target.relativeName)
        : join(importRoot, "backups", target.backupId + ".bytes");
    const derivative = join(importRoot, "retirement", progress.planId, target.backupId + ".bytes");
    const parent = dirname(path);
    const root = target.site === "source" ? this.source.coreHome : this.hostHome;
    await retirementDirectory(root, parent);
    await retirementDirectory(this.hostHome, dirname(derivative));
    const current = await retirementFile(path);
    try {
      const digest = await retirementDigest(current.file);
      if (digest === target.afterDigest) {
        const directory = await open(
          parent,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        return;
      }
      if (digest !== target.beforeDigest)
        throw Object.assign(new Error("Retirement target changed"), {
          code: "sourceChanged",
        });
      const sanitized = await retirementFile(derivative);
      const temporary = join(parent, `.host-retirement-${randomUUID()}.tmp`);
      let created = false;
      let replaced = false;
      try {
        if (sanitized.stat.size !== target.byteLength)
          throw new Error("Retirement derivative length mismatch");
        const output = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        created = true;
        try {
          const buffer = Buffer.alloc(64 * 1024);
          const hash = createHash("sha256");
          for (let position = 0; position < target.byteLength;) {
            const { bytesRead } = await sanitized.file.read(
              buffer,
              0,
              Math.min(buffer.length, target.byteLength - position),
              position,
            );
            if (!bytesRead) throw new Error("Retirement derivative was truncated");
            const chunk = buffer.subarray(0, bytesRead);
            hash.update(chunk);
            await output.writeFile(chunk);
            position += bytesRead;
          }
          const end = await sanitized.file.stat();
          if (
            end.size !== target.byteLength ||
            end.mtimeMs !== sanitized.stat.mtimeMs ||
            end.ctimeMs !== sanitized.stat.ctimeMs ||
            hash.digest("hex") !== target.afterDigest
          )
            throw new Error("Retirement derivative digest mismatch");
          await output.sync();
        } finally {
          await output.close();
        }
        await retirementDirectory(root, parent);
        const final = await retirementFile(path);
        try {
          if (
            final.stat.dev !== current.stat.dev ||
            final.stat.ino !== current.stat.ino ||
            (await retirementDigest(final.file)) !== target.beforeDigest
          )
            throw Object.assign(new Error("Retirement target changed before replacement"), {
              code: "sourceChanged",
            });
        } finally {
          await final.file.close();
        }
        await rename(temporary, path);
        replaced = true;
        const directory = await open(
          parent,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await sanitized.file.close();
        if (created && !replaced) await unlink(temporary);
      }
    } finally {
      await current.file.close();
    }
  }
  /** @param {string} migrationId @param {string} [requestId] */
  async retire(migrationId, requestId) {
    if (!UUID.test(migrationId) || (requestId !== undefined && !UUID.test(requestId)))
      throw new Error("Retirement IDs must be UUIDs");
    const client = new HostClient();
    let operationId = requestId;
    let planId;
    try {
      await client.connect(this.hostHome);
      await client.attachSource(this.source);
      const status = await client.retirementStatus(migrationId);
      if (status !== null) {
        const existing = retirementProgress(status, migrationId);
        if (operationId && operationId !== existing.requestId)
          throw new Error("Retirement must resume its original requestId");
        operationId = existing.requestId;
        planId = existing.planId;
        if (existing.state === "completed") return existing;
      }
      operationId ??= randomUUID();
      for (let count = 0; count < 9; count++) {
        const progress = retirementProgress(
          await client.retirementPrepare(operationId, migrationId),
          migrationId,
        );
        if (progress.requestId !== operationId || (planId && progress.planId !== planId))
          throw new Error("Host retirement identity changed");
        planId = progress.planId;
        if (progress.state === "completed") return progress;
        await this.replaceRetirementTarget(progress);
        const confirmed = retirementProgress(
          await client.retirementConfirm(operationId, migrationId, progress.planId),
          migrationId,
        );
        if (confirmed.requestId !== operationId || confirmed.planId !== progress.planId)
          throw new Error("Host retirement plan changed");
        if (confirmed.state === "completed") return confirmed;
      }
      throw new Error("Host retirement did not converge within the fixed target set");
    } catch (error) {
      throw Object.assign(
        error instanceof Error ? error : new Error("GUI credential retirement failed"),
        {
          requestId: operationId,
          migrationId,
          operation: "gui.retirementPrepare",
        },
      );
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
  if (!importArgument) return undefined;
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
  const adapter = new GuiSourceAdapter({
    source,
    hostHome,
    encryption: options.encryption,
    singletonHeld: true,
  });
  const result = await adapter.import(request.requestId);
  if (result.kind === "ready" && result.phase === "committed")
    await adapter.retire(result.migrationId);
  await writeFile(request.resultPath, JSON.stringify(result) + "\n", { mode: 0o600 });
  return result;
}

module.exports = {
  GuiSourceAdapter,
  canonicalSource,
  assertLegacySourceWritable,
  prepareGuiSource,
};
