// @ts-check
"use strict";
const { record } = require("./service-transport-contract.cjs");
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
/** @type {Map<string,Promise<string>>} */
const pending = new Map();
/**
 * 只取当前目录或待填表单里声明过的图片；归属由 Core 当场核对，不在进程里记授权。
 * @param {(name:string,request:Record<string,unknown>)=>Promise<unknown>} command
 * @param {Record<string,unknown>} request
 */
async function loadMetadataImage(command, request) {
  const { source, projectId, threadId } = request;
  if (typeof source !== "string" || typeof projectId !== "string") throw Error("Invalid image");
  if (threadId !== undefined && typeof threadId !== "string") throw Error("Invalid image");
  const scope = { projectId, ...(threadId ? { threadId } : {}) };
  /** @param {unknown} rows */
  const owner = (rows) =>
    record(rows) && Array.isArray(rows.data)
      ? rows.data.find((row) => record(row) && urls(row).has(source))
      : undefined;
  let row = owner(await command("manage", { operation: "mcpApps", ...scope }));
  if (!row && threadId) row = owner(await command("manage", { operation: "mcpForms", ...scope }));
  if (!record(row)) throw Error("Image was not advertised");
  const key = JSON.stringify([projectId, row.serverId, row.generation, source]);
  const existing = pending.get(key);
  if (existing) return existing;
  if (pending.size >= 8) throw Error("Image fetch limit");
  const loading = imageData(source);
  pending.set(key, loading);
  try {
    return await loading;
  } finally {
    pending.delete(key);
  }
}
module.exports = { loadMetadataImage, publicAddress, urls };
