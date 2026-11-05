// @ts-check
"use strict";
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

/** @typedef {import('@areal/client/node').VaultSlot} VaultSlot */
/** @typedef {{requestId:string,slot:VaultSlot,expectedRevision:number}} PendingWrite */

class HostVault {
  /** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend */
  constructor(backend) {
    this.backend = backend;
    /** @type {PendingWrite[]} */ this.pending = [];
    /** @type {Promise<unknown>} */ this.chain = Promise.resolve();
  }
  async init() {
    try {
      const value = JSON.parse(
        await readFile(join(this.backend.home, "host-vault-operations.json"), "utf8"),
      );
      if (
        value.version !== 1 ||
        !Array.isArray(value.pending) ||
        !value.pending.every(
          (/** @type {PendingWrite} */ item) =>
            typeof item.requestId === "string" &&
            Number.isSafeInteger(item.expectedRevision) &&
            item.expectedRevision >= 0 &&
            ["providerCredential", "subscriptionAccount", "subscriptionTransport"].includes(
              item.slot?.kind,
            ),
        )
      )
        throw new Error("Host 凭据操作记录无效");
      this.pending = value.pending;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  save() {
    return this.backend.save("host-vault-operations.json", {
      version: 1,
      pending: this.pending,
    });
  }
  /** @param {VaultSlot} slot @param {{interactionAllowed?:boolean}} [options] */
  read(slot, options) {
    return this.backend.host.client.vaultRead(slot, options);
  }
  /** @param {VaultSlot} slot */
  async ready(slot) {
    for (const item of this.pending.filter((entry) => isDeepStrictEqual(entry.slot, slot))) {
      const response = await this.backend.host.client.operation(item.requestId);
      const receipt = response?.operation ?? response;
      if (
        receipt?.requestId !== item.requestId ||
        !isDeepStrictEqual(receipt.slot, item.slot) ||
        !["completed", "blocked"].includes(receipt.state)
      )
        throw Object.assign(new Error("原凭据写入仍待确认，请恢复 Host 连接后重试"), {
          code: "storage_write_failed",
          requestId: item.requestId,
        });
      this.pending = this.pending.filter((entry) => entry.requestId !== item.requestId);
      await this.save();
    }
  }
  /** @param {VaultSlot} slot @param {number} revision @param {unknown} value */
  replace(slot, revision, value) {
    const result = this.chain.then(async () => {
      await this.ready(slot);
      const item = { requestId: randomUUID(), slot, expectedRevision: revision };
      this.pending.push(item);
      await this.save();
      let receipt;
      try {
        receipt = await this.backend.host.client.vaultReplace(
          item.requestId,
          slot,
          revision,
          value,
        );
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "revisionConflict") {
          this.pending = this.pending.filter((entry) => entry.requestId !== item.requestId);
          await this.save();
          throw Object.assign(new Error("凭据已被其他客户端修改，请刷新后重试"), {
            code: "account_changed",
          });
        }
        try {
          const response = await this.backend.host.client.operation(item.requestId);
          receipt = response?.operation ?? response;
        } catch {
          throw error;
        }
      }
      if (
        receipt?.requestId !== item.requestId ||
        !isDeepStrictEqual(receipt.slot, slot) ||
        !["completed", "blocked"].includes(receipt.state)
      )
        throw Object.assign(new Error("原凭据写入仍待确认，请恢复 Host 连接后重试"), {
          code: "storage_write_failed",
          requestId: item.requestId,
        });
      this.pending = this.pending.filter((entry) => entry.requestId !== item.requestId);
      await this.save();
      if (receipt.state !== "completed")
        throw Object.assign(new Error("凭据写入未完成，请刷新后重试"), {
          code:
            receipt.error?.code === "revisionConflict" ? "account_changed" : "storage_write_failed",
        });
      const current = await this.read(slot);
      if (current.revision !== receipt.revision)
        throw Object.assign(new Error("凭据已被其他客户端修改，请刷新后重试"), {
          code: "account_changed",
        });
      return current;
    });
    this.chain = result.catch(() => {});
    return result;
  }
}
module.exports = { HostVault };
