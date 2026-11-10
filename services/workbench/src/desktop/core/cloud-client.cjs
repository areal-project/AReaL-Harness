// @ts-check
"use strict";
const { HostCoreClient } = require("@areal/workbench-service/host-core-client");
const { randomUUID } = require("node:crypto");

/** @param {string} value */
function backendURL(value) {
  const url = new URL(value);
  if (
    !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Cloud 地址必须是无凭据、查询参数和片段的 app-server 地址");
  url.protocol = ["http:", "ws:"].includes(url.protocol) ? "ws:" : "wss:";
  url.pathname = url.pathname.replace(/\/+$/, "") + "/";
  return url;
}

/** Arena 与远程 Core 使用同一原生接口，客户端不管理平台 Session。 */
class CloudClient {
  /** @param {{baseURL:string,token:string,host:(method:string,params:unknown)=>Promise<unknown>,sourceId:string,clients:Map<string,import('@areal/workbench-service/host-core-client').HostCoreClient>}} options */
  constructor({ baseURL, token, host, sourceId, clients }) {
    this.host = host; this.sourceId = sourceId; this.clients = clients;
    this.baseURL = backendURL(baseURL);
    if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token))
      throw new Error("Cloud token 无效");
    this.token = token;
  }
  /** @param {string} sessionId */
  forWorkspace(sessionId) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(sessionId))
      throw new Error("Cloud Session ID 无效");
    const url = new URL(this.baseURL);
    url.pathname += encodeURIComponent(sessionId) + "/";
    return new CloudClient({ baseURL: url.href, token: this.token, host:this.host, sourceId:this.sourceId, clients:this.clients });
  }
  /** @param {{onNotification?:(method:string,params:unknown)=>void,onClose?:()=>void}} [options] */
  async connect({ onNotification = () => {}, onClose = () => {} } = {}) {
    const client = new HostCoreClient({ host:this.host, sourceId:this.sourceId, projectId:"", cloud:{baseURL:this.baseURL.href,token:this.token} });
    const key=`cloud:${randomUUID()}`;
    this.clients.set(key,client);
    client.onClose(() => { if (this.clients.get(key)===client) this.clients.delete(key); });
    client.onNotification(onNotification);
    client.onClose(onClose);
    try {
      await client.connect();
      if (
        client.capabilities?.apiVersion !== "areal.core.v1" ||
        !Array.isArray(client.capabilities.methods)
      )
        throw new Error("远端不是兼容的 AReaL app-server");
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }
  async check() {
    const client = await this.connect();
    try {
      return { connected: true, apiVersion: client.capabilities?.apiVersion };
    } finally {
      client.close();
    }
  }
}
/** @param {string} value */
function cloudServiceURL(value) {
  const url = backendURL(value);
  if (url.pathname === "/") url.pathname = "/openapi/v1/app-server/";
  if (!url.pathname.endsWith("/app-server/"))
    throw new Error(
      "请填写固定服务地址，例如 https://host/openapi/v1/app-server/，不要附加 workspace",
    );
  return url;
}
module.exports = { CloudClient, backendURL, cloudServiceURL };
