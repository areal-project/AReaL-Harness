// @ts-check
"use strict";
const { record } = require("@areal/workbench-service/desktop/core/service-transport-contract.cjs");
const https = require("node:https");
const dns = require("node:dns/promises");
const net = require("node:net");
// Metadata image fetches never receive renderer-selected authority or request headers.
// Pin the validated DNS result into the TLS request to avoid a lookup/rebind gap.
/** @param {string} address */
function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const b = address.split(".").map(Number);
    return !(
      b[0] === 0 ||
      b[0] === 10 ||
      b[0] === 127 ||
      b[0] >= 224 ||
      (b[0] === 169 && b[1] === 254) ||
      (b[0] === 172 && b[1] >= 16 && b[1] <= 31) ||
      (b[0] === 192 && [0, 168].includes(b[1])) ||
      (b[0] === 198 && [18, 19].includes(b[1])) ||
      (b[0] === 100 && b[1] >= 64 && b[1] <= 127)
    );
  }
  // Permit global IPv6 unicast only; mapped IPv4, local and transition ranges fail closed.
  return net.isIP(address) === 6 && /^2[0-9a-f]{3}:/i.test(address) && !/^200[12]:/i.test(address);
}
/** @param {string} source @returns {Promise<string>} */
async function imageData(source) {
  const url = new URL(source);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443"))
    throw Error("Invalid image origin");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some((item) => !publicAddress(item.address)))
    throw Error("Private image origin");
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        agent: false,
        headers: { Accept: "image/png,image/jpeg,image/gif,image/webp" },
        lookup: (_hostname, _options, callback) =>
          callback(null, selected.address, selected.family),
      },
      (response) => {
        const mime = String(response.headers["content-type"] || "")
          .split(";")[0]
          .toLowerCase();
        if (
          response.statusCode !== 200 ||
          !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)
        ) {
          response.destroy();
          reject(Error("Unsupported metadata image"));
          return;
        }
        let size = 0;
        /** @type {Buffer[]} */
        const chunks = [];
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            response.destroy(Error("Metadata image too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve(`data:${mime};base64,${Buffer.concat(chunks).toString("base64")}`),
        );
      },
    );
    request.setTimeout(8000, () => request.destroy(Error("Metadata image timeout")));
    request.on("error", reject);
  });
}
/** @param {unknown} value @param {Set<string>} [result] @param {number} [depth] */
function urls(value, result = new Set(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 24) return result;
  /** @param {unknown} icon */
  const add = (icon) => {
    if (record(icon) && typeof icon.src === "string" && icon.src.startsWith("https://"))
      result.add(icon.src);
  };
  if (record(value)) {
    if (Array.isArray(value.icons)) value.icons.forEach(add);
    if (value["x-openai-thumbnail"]) add(value["x-openai-thumbnail"]);
  }
  for (const child of Object.values(value))
    if (child && typeof child === "object") urls(child, result, depth + 1);
  return result;
}
class McpMetadataImages {
  /** @param {InstanceType<typeof import("./service-client.cjs").SharedCoreBackend>} backend */
  constructor(backend) {
    this.backend = backend;
    /** @type {Map<string,{projectId:string,threadId?:string,serverId:string,generation:string|number,formRequestId?:string}>} */
    this.grants = new Map();
    /** @type {Map<string,Promise<string>>} */
    this.pending = new Map();
  }
  /** @param {Record<string,unknown>} params @param {unknown} result */
  remember(params, result) {
    if (
      typeof params.projectId !== "string" ||
      (params.threadId !== undefined && typeof params.threadId !== "string")
    )
      return;
    const records =
      params.operation === "mcpApps"
        ? record(result) && Array.isArray(result.data)
          ? result.data
          : []
        : params.operation === "mcpForms"
          ? record(result) && Array.isArray(result.data)
            ? result.data
            : []
          : params.operation === "mcpExtensionCall"
            ? [{ ...params, generation: params.expectedGeneration, value: result }]
            : [];
    for (const row of records) {
      if (
        !record(row) ||
        typeof row.serverId !== "string" ||
        !(typeof row.generation === "string" || typeof row.generation === "number")
      )
        continue;
      for (const source of urls(row)) {
        if (this.grants.size >= 512) {
          const oldest = this.grants.keys().next();
          if (!oldest.done) this.grants.delete(oldest.value);
        }
        this.grants.set(source, {
          projectId: params.projectId,
          threadId: params.threadId,
          serverId: row.serverId,
          generation: row.generation,
          ...(params.operation === "mcpForms" && typeof row.requestId === "string"
            ? { formRequestId: row.requestId }
            : {}),
        });
      }
    }
  }
  /** @param {unknown} source */
  async load(source) {
    if (typeof source !== "string") throw Error("Invalid image");
    const owner = this.grants.get(source);
    if (!owner) throw Error("Image was not advertised");
    const catalog = await this.backend.command("manage", {
      operation: "mcpApps",
      projectId: owner.projectId,
      ...(owner.threadId ? { threadId: owner.threadId } : {}),
    });
    if (
      !record(catalog) ||
      !Array.isArray(catalog.data) ||
      !catalog.data.some(
        (row) =>
          record(row) && row.serverId === owner.serverId && row.generation === owner.generation,
      )
    )
      throw Error("Image owner is stale");
    if (owner.formRequestId) {
      const forms = await this.backend.command("manage", {
        operation: "mcpForms",
        projectId: owner.projectId,
        threadId: owner.threadId,
      });
      if (
        !record(forms) ||
        !Array.isArray(forms.data) ||
        !forms.data.some(
          (row) =>
            record(row) &&
            row.requestId === owner.formRequestId &&
            row.generation === owner.generation &&
            urls(row).has(source),
        )
      )
        throw Error("Image form expired");
    }
    const key = JSON.stringify([owner.projectId, owner.serverId, owner.generation, source]);
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.pending.size >= 8) throw Error("Image fetch limit");
    const pending = imageData(source);
    this.pending.set(key, pending);
    try {
      return await pending;
    } finally {
      this.pending.delete(key);
    }
  }
}
module.exports = { McpMetadataImages, publicAddress, urls };
