// @ts-check
"use strict";

const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { modelRecord } = require("@areal/workbench/core-model-contract");
const {
  validateRequest,
} = require("../../../packages/workbench/client/desktop-contract/cloud.cjs");
/** @typedef {{home:string,save:(name:string,value:unknown)=>Promise<unknown>}} SettingsHost */
/** @typedef {{isEncryptionAvailable:()=>boolean,getSelectedStorageBackend?:()=>string,encryptString:(value:string)=>Buffer,decryptString:(value:Buffer)=>string}} Encryption */
const { cloudServiceURL, CloudClient } = require("./cloud-client.cjs");

/** Renderer 只读配置状态；token 只在可信适配器解密用于目标后端。 */
class CloudSettings {
  /** @param {SettingsHost} backend @param {Encryption|undefined} encryption */
  constructor(backend, encryption) {
    this.backend = backend;
    this.encryption = encryption;
    /** @type {Promise<unknown>} */
    this.chain = Promise.resolve();
  }
  /** @returns {Promise<{baseURL?:string,secret?:string}>} */
  async record() {
    try {
      /** @type {unknown} */
      const value = JSON.parse(await readFile(join(this.backend.home, "cloud.json"), "utf8"));
      if (
        !modelRecord(value) ||
        (value.baseURL !== undefined && typeof value.baseURL !== "string") ||
        (value.secret !== undefined && typeof value.secret !== "string")
      )
        throw new Error("Cloud 配置结构无效");
      const record = {
        baseURL: typeof value.baseURL === "string" ? value.baseURL : undefined,
        secret: typeof value.secret === "string" ? value.secret : undefined,
      };
      // 旧配置只移除已知 Arena workspace 后缀，仍保留原目标和加密凭据。
      if (record.baseURL) {
        const url = new URL(record.baseURL);
        const path = url.pathname.match(/^(.*\/app-server\/)[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\/?$/);
        if (path) {
          url.pathname = path[1];
          record.baseURL = url.href.replace(/\/$/, "");
        }
      }
      return record;
    } catch (error) {
      if (modelRecord(error) && error.code === "ENOENT") return {};
      throw new Error("无法读取 Cloud 配置");
    }
  }
  checkStorage() {
    if (
      !this.encryption?.isEncryptionAvailable() ||
      this.encryption.getSelectedStorageBackend?.() === "basic_text"
    )
      throw new Error("系统安全存储不可用，请解锁后重试");
    return this.encryption;
  }
  async status() {
    const record = await this.record();
    return { baseURL: record.baseURL ?? "", tokenConfigured: !!record.secret };
  }
  /** @param {unknown} value */
  command(value) {
    validateRequest("cloud", value);
    const request =
      /** @type {import('../../../packages/workbench/client/desktop-contract/cloud.cjs').SettingsRequest} */ (
        value
      );
    if (request?.operation === "status") return this.status();
    if (request?.operation !== "save") throw new Error("不支持的 Cloud 配置操作");
    const operation = this.chain.then(async () => {
      const previous = await this.record();
      const baseURL = cloudServiceURL(request.baseURL).href.replace(/\/$/, "");
      if (request.token !== undefined && typeof request.token !== "string")
        throw new Error("Cloud token 无效");
      let secret;
      if (request.token) {
        if (!request.token.trim() || /[\r\n]/.test(request.token) || request.token.length > 16384)
          throw new Error("Cloud token 无效");
        this.checkStorage();
        secret = this.checkStorage().encryptString(request.token).toString("base64");
      } else if (previous.baseURL === baseURL) secret = previous.secret;
      // 地址改变时必须重新提供token，不能把旧目标的凭据自动发送到新目标。
      if (!secret) throw new Error("请为此 Cloud 地址提供 token");
      await this.backend.save("cloud.json", { baseURL, secret });
      return { baseURL, tokenConfigured: true };
    });
    this.chain = operation.catch(() => {});
    return operation;
  }
  async client() {
    const record = await this.record();
    if (!record.baseURL || !record.secret) throw new Error("请先配置 Cloud 地址和 token");
    this.checkStorage();
    let token;
    try {
      token = this.checkStorage().decryptString(Buffer.from(record.secret, "base64"));
    } catch {
      throw new Error("无法解密 Cloud token，请重新保存");
    }
    return new CloudClient({ baseURL: record.baseURL, token });
  }
}

module.exports = { CloudSettings };
