// @ts-check
"use strict";
/** @type {typeof import("@areal/workbench/desktop-contract").validateCommand} */
const validateCommand = require("@areal/workbench/desktop-contract").validateCommand;
const { CloudClient } = require("./cloud-client.cjs");
/** @typedef {{hostCall?:((method:string,params:unknown)=>Promise<unknown>),host:{sourceId:string},hostCoreClients:Map<string,import('@areal/workbench-service/host-core-client').HostCoreClient>}} SettingsHost */

/** 剩余 Cloud 会话只使用 Host 已配置的连接，不读取 token 或持有设置状态。 */
class CloudSettings {
  /** @param {SettingsHost} backend */
  constructor(backend) {
    this.backend = backend;
  }
  /** @param {unknown} request @returns {Promise<{baseURL:string,tokenConfigured:boolean}>} */
  async command(request) {
    validateCommand("cloud", request);
    if (!this.backend.hostCall) throw new Error("Host Cloud settings unavailable");
    const value = await this.backend.hostCall("cloud.settings", {
      sourceId: this.backend.host.sourceId,
      request,
    });
    if (
      !value ||
      typeof value !== "object" ||
      !("baseURL" in value) ||
      typeof value.baseURL !== "string" ||
      !("tokenConfigured" in value) ||
      typeof value.tokenConfigured !== "boolean"
    )
      throw new Error("Invalid native Cloud settings");
    return { baseURL: value.baseURL, tokenConfigured: value.tokenConfigured };
  }
  status() {
    return this.command({ operation: "status" });
  }
  async client() {
    const value = await this.status();
    if (!value.baseURL || !value.tokenConfigured) throw new Error("请先配置 Cloud 地址和 token");
    if (!this.backend.hostCall) throw new Error("Host Cloud transport unavailable");
    return new CloudClient({
      baseURL: value.baseURL,
      host: this.backend.hostCall,
      sourceId: this.backend.host.sourceId,
      clients: this.backend.hostCoreClients,
    });
  }
}
module.exports = { CloudSettings };
