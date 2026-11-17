// @ts-check
"use strict";
const fs = require("node:fs");
const { join } = require("node:path");
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const { createHash } = require("node:crypto");
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
/** @param {unknown} value @param {string[]} allowed */
const choice = (value, allowed) =>
  typeof value === "string" && allowed.includes(value) ? value : undefined;
/** @param {unknown} value */
const count = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const tiers = ["auto", "default", "flex", "priority", "fast", "scale", "ultrafast"];
const labels = [
  "rate_limit_exceeded",
  "rate_limit_error",
  "insufficient_quota",
  "budget_exhausted",
  "context_length_exceeded",
  "invalid_request_error",
  "unsupported_parameter",
  "unsupported_value",
  "invalid_api_key",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "model_not_found",
  "server_error",
  "server_is_overloaded",
  "service_unavailable_error",
  "api_error",
  "overloaded_error",
  "content_policy_violation",
  "content_filter",
  "max_tokens",
  "max_output_tokens",
  "invalid_messages",
  "validation_error",
];
/** @param {unknown} value */
function endpoint(value) {
  if (!record(value) || typeof value.origin !== "string") return undefined;
  try {
    const url = new URL(value.origin);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    return {
      origin: url.origin,
      route:
        choice(value.route, [
          "/v1/responses",
          "/responses",
          "/v1/chat/completions",
          "/chat/completions",
          "/backend-api/codex/responses",
        ]) ?? "[redacted]",
    };
  } catch {
    return undefined;
  }
}
/** @param {unknown} value @param {string} requestId */
function projectModelRequest(value, requestId) {
  if (!record(value) || value.requestId !== requestId) return null;
  const parameters = record(value.parameters) ? value.parameters : {};
  const usage = record(value.usageDetails) ? value.usageDetails : {};
  const error = record(value.streamError) ? value.streamError : {};
  const model = typeof parameters.model === "string" ? parameters.model : undefined;
  return {
    requestId,
    startedAtUnixMs: count(value.startedAtUnixMs),
    protocol: choice(value.protocol, ["responses", "chat-completions"]),
    transport: choice(value.transport, ["http-sse", "responses-websocket"]),
    endpoint: endpoint(value.endpoint),
    model:
      model && /^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,127}$/.test(model) && !/^(sk-|Bearer)/i.test(model)
        ? model
        : undefined,
    requestedServiceTier: choice(parameters.service_tier, tiers),
    actualServiceTier: choice(usage.serviceTier, tiers),
    httpStatus: count(value.httpStatus),
    httpAttempts: count(value.httpAttempts),
    outcome: choice(value.outcome, ["pending", "completed", "failed", "interrupted_or_unfinished"]),
    error: {
      eventType: choice(error.eventType, ["error", "response.failed", "response.incomplete"]),
      code: choice(error.code, labels),
      type: choice(error.errorType, labels),
      reason: choice(error.reason, labels),
      parameter: choice(error.parameter, ["reasoning.effort", "service_tier"]),
      summary: choice(error.messageSummary, [
        "upstream stream request failed",
        "Unsupported service_tier: fast",
      ]),
    },
    privateDetailAvailable: typeof value.errorDetailFile === "string",
  };
}
/** @param {{packaged:boolean,coreBinary:string,coreHome:string,config:string,explicitConfig:boolean}} value */
function instanceSelection(value) {
  /** @param {string} path */
  const hash = (path) => createHash("sha256").update(path).digest("hex");
  return {
    mode: value.packaged ? "packaged" : "source",
    configSource: value.explicitConfig ? "explicit" : "default",
    configPathSha256: hash(value.config),
    coreBinaryPathSha256: hash(value.coreBinary),
    coreHomeSha256: hash(value.coreHome),
  };
}

/**
 * @param {string|undefined} coreRoot
 * @param {{list:(path:string,limit?:number)=>import('node:fs').Dirent[],json:(path:string,optional?:boolean,limit?:number)=>Promise<unknown>,omissions:{rejectedEntries:number,readFailures:number,truncatedFiles:number},available:()=>boolean}} reader
 */
async function readModelRequests(coreRoot, { list, json, omissions, available }) {
  const modelRequests = [];
  if (coreRoot) {
    const projects = list(coreRoot).filter(
      (entry) =>
        /^[a-f0-9]{24}$/.test(entry.name) && entry.isDirectory() && !entry.isSymbolicLink(),
    );
    for (const project of projects) {
      const root = join(coreRoot, project.name, "state", "model-requests");
      // Core 保留最多 4096 条审计；沿用有界目录和文件读取，不读取私有 errors 子目录。
      const requests = list(root, 4098).filter(
        (entry) => UUID.test(entry.name.replace(/\.json$/, "")) && entry.name.endsWith(".json"),
      );
      const candidates = requests
        .filter((entry) => {
          if (entry.isFile() && !entry.isSymbolicLink()) return true;
          omissions.rejectedEntries++;
          return false;
        })
        .map((entry) => {
          try {
            return { entry, time: fs.lstatSync(join(root, entry.name)).mtimeMs };
          } catch {
            omissions.readFailures++;
            return { entry, time: 0 };
          }
        })
        .sort((a, b) => b.time - a.time);
      const capacity = Math.min(32, 128 - modelRequests.length);
      if (candidates.length > capacity) omissions.truncatedFiles++;
      for (const { entry } of candidates.slice(0, capacity)) {
        const value = projectModelRequest(
          await json(join(root, entry.name), false, 1024 * 1024),
          entry.name.slice(0, -5),
        );
        if (value) modelRequests.push({ project: project.name, ...value });
        else omissions.rejectedEntries++;
      }
      if (!available()) break;
    }
  }
  return modelRequests;
}
/** @param {string} root @param {(path:string)=>void} directory @param {{readFailures:number}} omissions */
function dumps(root, directory, omissions) {
  let count = 0,
    scanned = 0,
    truncated = false,
    available = false;
  for (const suffix of ["", "pending", "completed", "reports"]) {
    const path = join(`${root}-crashes`, suffix);
    let handle;
    try {
      directory(path);
      available = true;
      handle = fs.opendirSync(path);
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        if (++scanned > 64) {
          truncated = true;
          break;
        }
        if (entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".dmp")) count++;
      }
    } catch (error) {
      if (!record(error) || error.code !== "ENOENT") omissions.readFailures++;
    } finally {
      handle?.closeSync();
    }
    if (truncated) break;
  }
  return { available, count, truncated, dumpContentsIncluded: false };
}

module.exports = { readModelRequests, dumps, instanceSelection };
