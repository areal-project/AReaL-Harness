// @ts-check
"use strict";
const { record, genUiSource } = require("./mcp-host-contract.cjs");
const { randomBytes, createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const {
  projectGenUiReferences,
  genUiWidgetStateSchema,
  genUiFollowUpSchema,
  buildGenUiStateKey,
} = require("@areal/gen-ui/node");
const methods = new Set([
  "zcode/gen-ui/state",
  "zcode/gen-ui/follow-up",
  "zcode/gen-ui/presentation",
]);
/** @type {Map<string,string>} */
const assetPaths = new Map([
  ["/runtime.js", require.resolve("@areal/gen-ui/runtime")],
  ...[
    "visualize.css",
    "calendar.js",
    "vendor/floating-ui-core-1.7.3.min.js",
    "vendor/floating-ui-dom-1.7.4.min.js",
    "vendor/lucide-1.17.0.js",
    "vendor/d3-7.9.0.min.js",
  ].map(
    /** @returns {[string,string]} */ (name) => [
      `/assets/${name}`,
      require.resolve(`@areal/gen-ui/assets/${name}`),
    ],
  ),
]);
/** @param {import("@areal/gen-ui/contract").GenUiWidgetState|null} value */
const escapeJson = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");
/** @param {string} html @param {import("@areal/gen-ui/contract").GenUiWidgetState|null} state */
async function shell(html, state) {
  if (/<\s*(?:!doctype|html|head|body|base)\b/i.test(html))
    throw Error("Expected an HTML fragment");
  let template = await readFile(require.resolve("@areal/gen-ui/assets/visualize.html"), "utf8");
  /** @type {unknown} */
  const manifest = JSON.parse(
    await readFile(require.resolve("@areal/gen-ui/assets/vendor/manifest.json"), "utf8"),
  );
  template = template.replace("<!--__INLINE_VISUALIZATION_FRAGMENT__-->", () => html);
  if (!record(manifest) || !Array.isArray(manifest.resources))
    throw Error("Invalid visualization asset manifest");
  for (const resource of manifest.resources) {
    if (!record(resource) || typeof resource.url !== "string" || typeof resource.file !== "string")
      throw Error("Invalid visualization asset manifest");
    template = template.replaceAll(resource.url, `/assets/vendor/${resource.file}`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/visualize.css"></head><body><script id="zcode-gen-ui-initial-state" type="application/json">${escapeJson(state)}</script><script src="/runtime.js"></script><script src="/assets/calendar.js"></script>${template}</body></html>`;
}
/** @typedef {{kind:'genUi',token:string,frameUrl:string,projectId:string,threadId:string,source:{projectId:string,threadId:string,turnId:string,itemId:string,referenceOffset:number},artifact:{artifactId:string,path:string,digest:string},title:string,readOnly:boolean,hostContext:{displayMode:string,availableDisplayModes:string[],'zcode/genUiState':import('@areal/gen-ui/contract').GenUiWidgetState|null}}} GenUiDescriptor */
/** @typedef {{kind:'genUi',sourceKey:string,resultSourceKey?:undefined,ownerId:number,projectId:string,threadId:string,target:import('@areal/gen-ui/contract').GenUiStateTarget,token:string,closed:boolean,visible:boolean,readOnly:boolean,requests:Map<number,{fingerprint:string,promise:Promise<{result:Record<string,never>}>}>,lastRequest:number,abort:AbortController,hostEpoch:number,csp:string,resource:{html:string},descriptor:GenUiDescriptor,stateSubscription?:{dispose:()=>void},invalidResource?:false}} GenUiInstance */
/** @typedef {{projectId:string,threadId:string,turnId:string,itemId:string,referenceOffset:number}} GenUiInput */
/** @param {InstanceType<typeof import('./mcp-apps.cjs').McpAppsHost>} host @param {unknown} params @param {number} ownerId @returns {Promise<unknown>} */
async function openGenUi(host, params, ownerId) {
  if (
    !genUiInput(params) ||
    ownerId !== host.currentOwner() ||
    !host.backend.ownsThread(params.projectId, params.threadId)
  )
    throw Error("Invalid generated answer owner");
  const sourceKey = JSON.stringify([
    ownerId,
    host.epoch,
    params.projectId,
    params.threadId,
    params.turnId,
    params.itemId,
    params.referenceOffset,
  ]);
  const existing = [...host.instances.values()].find(
    (app) => app.kind === "genUi" && app.sourceKey === sourceKey && !app.closed,
  );
  if (existing && existing.kind === "genUi") return existing.descriptor;
  const pending = host.resultOpens.get(sourceKey);
  if (pending) return pending.promise;
  const epoch = host.epoch;
  const promise = (async () => {
    host.pendingOpens++;
    try {
      if (host.instances.size + host.pendingOpens > 8) {
        const idle = [...host.instances.values()].find(
          (app) => app.kind === "genUi" && !app.visible,
        );
        if (idle) await host.close(idle.token, ownerId);
        if (host.instances.size + host.pendingOpens > 8) throw Error("App page limit reached (8)");
      }
      const source = genUiSource(
        await host.backend.command("manage", {
          operation: "genUiSource",
          projectId: params.projectId,
          threadId: params.threadId,
          turnId: params.turnId,
          itemId: params.itemId,
        }),
      );
      const part = projectGenUiReferences(source.text, true).find(
        (part) => part.kind === "ui" && part.offset === params.referenceOffset,
      );
      const reference = part?.kind === "ui" ? part.reference : undefined;
      if (!reference) throw Error("Generated answer is unavailable");
      const resolved = genUiSource(
        await host.backend.command("manage", {
          operation: "genUiSource",
          projectId: params.projectId,
          threadId: params.threadId,
          turnId: params.turnId,
          itemId: params.itemId,
          path: reference.path,
        }),
      );
      if (resolved.text !== source.text) throw Error("Generated source changed");
      const artifact = resolved.artifacts.find((item) => item.path === reference.path);
      if (
        !artifact ||
        typeof artifact.html !== "string" ||
        Buffer.byteLength(artifact.html) > 5_000_000 ||
        createHash("sha256").update(artifact.html).digest("hex") !== artifact.digest
      )
        throw Error("Generated answer is unavailable");
      const project = host.backend.saved.find((project) => project.id === params.projectId);
      if (!project) throw Error("Generated answer owner changed");
      const target = { ...host.backend.genUiScope(project, params.threadId), path: artifact.path };
      const state = await host.backend.genUiState.get(target);
      const html = await shell(artifact.html, state);
      if (
        epoch !== host.epoch ||
        ownerId !== host.currentOwner() ||
        !host.backend.ownsThread(params.projectId, params.threadId)
      )
        throw Error("Generated answer owner changed");
      const token = randomBytes(24).toString("hex");
      const sourceIdentity = {
        projectId: params.projectId,
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        referenceOffset: params.referenceOffset,
      };
      /** @type {GenUiDescriptor} */
      const descriptor = {
        kind: "genUi",
        token,
        frameUrl: `areal-mcp://${token}/`,
        projectId: params.projectId,
        threadId: params.threadId,
        source: sourceIdentity,
        artifact: { artifactId: artifact.artifactId, path: artifact.path, digest: artifact.digest },
        title: reference.title ?? "Interactive answer",
        readOnly: source.readOnly,
        hostContext: {
          displayMode: "inline",
          availableDisplayModes: ["inline"],
          "zcode/genUiState": state,
        },
      };
      /** @type {GenUiInstance} */
      const app = {
        descriptor,
        kind: "genUi",
        sourceKey,
        ownerId,
        projectId: params.projectId,
        threadId: params.threadId,
        target,
        token,
        closed: false,
        visible: false,
        readOnly: source.readOnly,
        requests: new Map(),
        lastRequest: 0,
        abort: new AbortController(),
        hostEpoch: epoch,
        csp: "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'; worker-src 'none'",
        resource: { html },
      };

      app.stateSubscription = host.backend.genUiState.onChanged((change) => {
        if (!app.closed && buildGenUiStateKey(change.target) === buildGenUiStateKey(target)) {
          app.descriptor.hostContext["zcode/genUiState"] = change.state;
          host.notify({
            token,
            notification: {
              jsonrpc: "2.0",
              method: "ui/notifications/host-context-changed",
              params: { "zcode/genUiState": change.state },
            },
          });
        }
      });
      host.instances.set(token, app);
      return app.descriptor;
    } finally {
      host.pendingOpens--;
    }
  })().finally(() => host.resultOpens.delete(sourceKey));
  host.resultOpens.set(sourceKey, { promise });
  return promise;
}
/** @param {InstanceType<typeof import("./mcp-apps.cjs").McpAppsHost>} host @param {unknown} params @param {number} ownerId */
function genUiVisibility(host, params, ownerId) {
  if (
    !record(params) ||
    typeof params.token !== "string" ||
    Object.keys(params).some((key) => !["operation", "token", "visible"].includes(key)) ||
    typeof params.visible !== "boolean"
  )
    throw Error("Invalid generated visibility");
  const app = host.get(params.token, ownerId);
  if (app.kind !== "genUi") throw Error("Invalid generated page");
  app.visible = params.visible;
  return {};
}
/** @param {InstanceType<typeof import("./mcp-apps.cjs").McpAppsHost>} host @param {GenUiInstance} app @param {unknown} request @param {number} ownerId */
async function genUiRequest(host, app, request, ownerId) {
  if (
    !record(request) ||
    typeof request.method !== "string" ||
    typeof request.id !== "number" ||
    request.jsonrpc !== "2.0" ||
    !methods.has(request.method) ||
    !Number.isSafeInteger(request.id) ||
    request.id <= 0 ||
    JSON.stringify(request).length > 96 * 1024
  )
    throw Error("Unsupported generated request");
  const fingerprint = JSON.stringify(request),
    previous = app.requests.get(request.id);
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw Error("Request identity changed");
    return previous.promise;
  }
  if (request.id <= app.lastRequest) throw Error("Generated request has expired");
  app.lastRequest = request.id;
  const current = () => {
    if (host.get(app.token, ownerId) !== app || !app.visible || app.readOnly)
      throw Error("Generated answer is hidden or read-only");
  };
  const promise = (async () => {
    current();
    if (request.method === "zcode/gen-ui/state") {
      if (!record(request.params) || Object.keys(request.params).some((key) => key !== "state"))
        throw Error("Invalid state request");
      await host.backend.genUiState.set(
        app.target,
        genUiWidgetStateSchema.parse(request.params.state),
      );
      current();
    } else if (request.method === "zcode/gen-ui/follow-up") {
      genUiFollowUpSchema.parse(request.params);
      const project = host.backend.saved.find((project) => project.id === app.projectId);
      if (!project) throw Error("Generated answer owner changed");
      await host.backend.genUiState.list(host.backend.genUiScope(project, app.threadId));
      current();
    } else if (
      !record(request.params) ||
      Object.keys(request.params).some((key) => !["hovered", "escape"].includes(key))
    )
      throw Error("Invalid presentation request");
    return { result: {} };
  })();
  app.requests.set(request.id, { fingerprint, promise });
  void promise
    .finally(() => {
      while (app.requests.size > 64) {
        const oldest = app.requests.keys().next();
        if (oldest.done) break;
        app.requests.delete(oldest.value);
      }
    })
    .catch(() => {});
  return promise;
}
/** @param {GenUiInstance} _app @param {string} pathname @param {boolean} [response] */
function genUiResource(_app, pathname, response = false) {
  if (["/", "/view"].includes(pathname)) return true;
  const file = assetPaths.get(pathname);
  if (!file) return false;
  if (!response) return true;
  return readFile(file).then(
    (bytes) =>
      new Response(bytes, {
        headers: {
          "Content-Type": pathname.endsWith(".css") ? "text/css" : "text/javascript",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'",
        },
      }),
  );
}
module.exports = { openGenUi, genUiRequest, genUiVisibility, genUiResource };

/** @param {unknown} value @returns {value is GenUiInput} */
function genUiInput(value) {
  const fields = ["operation", "projectId", "threadId", "turnId", "itemId", "referenceOffset"];
  return (
    record(value) &&
    Object.keys(value).every((key) => fields.includes(key)) &&
    ["projectId", "threadId", "turnId", "itemId"].every(
      (key) => typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 128,
    ) &&
    typeof value.referenceOffset === "number" &&
    Number.isSafeInteger(value.referenceOffset) &&
    value.referenceOffset >= 0
  );
}
