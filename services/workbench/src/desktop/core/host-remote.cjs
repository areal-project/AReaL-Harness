// @ts-check
"use strict";
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { HostClient } = require("@areal/client/node");
const { parseRemoteConfig } = require("./remote-config.cjs");
/** @typedef {{requestId:string,sourceId:string,expectedRevision:number}} PendingWrite */

class HostRemote {
  /** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend @param {()=>void} disconnected @param {{native?:boolean}} [options] */
  constructor(backend, disconnected, { native = false } = {}) {
    this.backend = backend;
    this.disconnected = disconnected;
    this.client = new HostClient();
    this.sourceId = "";
    this.revision = 0;
    this.leased = false;
    this.closed = false;
    this.native = native;
    this.nativeOwned = false;
    /** @type {Promise<void>|undefined} */ this.persistence = undefined;
    /** @type {PendingWrite|null} */ this.pending = null;
    /** @type {Promise<unknown>} */ this.chain = Promise.resolve();
  }
  async init() {
    this.requireOpen();
    this.sourceId = this.backend.host.sourceId;
    try {
      const record = JSON.parse(
        await readFile(join(this.backend.home, "host-remote-operation.json"), "utf8"),
      );
      if (
        record.version !== 1 ||
        (record.pending !== null &&
          (typeof record.pending?.requestId !== "string" ||
            record.pending.sourceId !== this.sourceId ||
            !Number.isSafeInteger(record.pending.expectedRevision) ||
            record.pending.expectedRevision < 0))
      )
        throw new Error("Host Remote 操作记录无效");
      this.pending = record.pending;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    this.requireOpen();
    await this.client.connect(this.backend.host.home);
    this.requireOpen();
    this.client.socket?.once("close", () => {
      this.leased = false;
      this.disconnected();
    });
    this.client.requireCapability("remoteState");
    if (!this.native) await this.client.request("remote.acquire", { sourceId: this.sourceId });
    this.requireOpen();
    this.leased = !this.native;
    await this.settle();
    return this.read();
  }
  available() {
    return !this.closed && (this.leased || this.native) && !this.client.socket?.destroyed;
  }
  persist() {
    const result = this.backend.save("host-remote-operation.json", {
      version: 1,
      pending: this.pending,
    });
    this.persistence = result;
    void result.catch(() => {});
    return result;
  }
  async read() {
    const value = await this.client.request("remote.read", {});
    if (value.sourceId !== null && value.sourceId !== this.sourceId)
      throw new Error("Remote 配置属于其他来源");
    this.revision = value.revision;
    this.nativeOwned = value.owner === "native";
    return parseRemoteConfig(value.config);
  }
  /** @param {Record<string,unknown>|null|undefined} receipt @param {PendingWrite} item */
  matches(receipt, item) {
    return (
      receipt?.requestId === item.requestId &&
      receipt.method === "remote.replace" &&
      receipt.sourceId === item.sourceId &&
      receipt.previousRevision === item.expectedRevision &&
      ["completed", "blocked"].includes(String(receipt.state))
    );
  }
  async settle() {
    if (!this.pending) return false;
    const item = this.pending;
    const response = await this.client.operation(item.requestId);
    if (!this.matches(response?.operation ?? response, item))
      throw Object.assign(new Error("原 Remote 写入仍待确认，请恢复 Host 连接后重试"), {
        requestId: item.requestId,
      });
    this.pending = null;
    await this.persist();
    return true;
  }
  async refresh() {
    await this.settle();
    return this.read();
  }
  /** @param {import('./remote-config.cjs').RemoteConfig} config */
  replace(config) {
    const result = this.chain.then(async () => {
      if (!this.available()) throw new Error("Host Remote 连接已关闭");
      if (await this.settle()) {
        await this.read();
        throw new Error("原 Remote 写入已确认，请刷新后重试");
      }
      const item = {
        requestId: randomUUID(),
        sourceId: this.sourceId,
        expectedRevision: this.revision,
      };
      this.pending = item;
      await this.persist();
      let receipt;
      try {
        receipt = await this.client.request(
          this.native && this.nativeOwned ? "remote.gateway.replace" : "remote.replace",
          {
            ...item,
            expectedGeneration: this.client.generation,
            config,
          },
        );
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          [
            "revisionConflict",
            "generationMismatch",
            "migrationConflict",
            "sourceNotFound",
            "invalidRequest",
          ].includes(String(error.code))
        ) {
          this.pending = null;
          await this.persist();
          throw error;
        }
        try {
          const response = await this.client.operation(item.requestId);
          receipt = response?.operation ?? response;
        } catch {
          throw error;
        }
      }
      if (!this.matches(receipt, item))
        throw Object.assign(new Error("原 Remote 写入仍待确认，请恢复 Host 连接后重试"), {
          requestId: item.requestId,
        });
      this.pending = null;
      await this.persist();
      if (receipt.state !== "completed") throw new Error("Remote 配置未写入，请刷新后重试");
      const current = await this.read();
      if (this.revision !== receipt.revision) throw new Error("Remote 配置已变更，请刷新后重试");
      return current;
    });
    this.chain = result.catch(() => {});
    return result;
  }
  requireOpen() {
    if (!this.closed) return;
    this.client.close();
    throw new Error("Host Remote connection is closed");
  }
  async drained() {
    await this.chain;
    await this.persistence;
  }
  close() {
    this.closed = true;
    this.leased = false;
    this.client.close();
  }
}
module.exports = { HostRemote };
