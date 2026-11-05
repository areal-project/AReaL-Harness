// @ts-check
"use strict";
const { randomUUID } = require("node:crypto");
const { record } = require("@areal/workbench-service/desktop/core/service-transport-contract.cjs");
const path = require("node:path");
/** @typedef {{projectId:string,threadId:string,requestId:string,fieldName:string,uri?:string}} FormOwner */
/** @typedef {{uri:string,name:string,mimeType?:unknown,size?:unknown}} StagedResource */
/** @typedef {{selectionToken:string,multiple:boolean,serverLabel:string,userOptions?:{kind?:unknown,accept?:unknown}}} PreparedSelection */
/** @typedef {{stage:{operation:string,projectId:string,selectionToken:string,requestId:string,paths:string[]},prepared:PreparedSelection,directory:boolean,chosen:Electron.OpenDialogReturnValue}} UnsettledSelection */
/** @param {unknown} value @param {boolean} [release] @returns {FormOwner} */
function identity(value, release = false) {
  const keys = ["projectId", "threadId", "requestId", "fieldName", ...(release ? ["uri"] : [])];
  if (!record(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Invalid form resource request");
  return {
    projectId: formField(value.projectId),
    threadId: formField(value.threadId),
    requestId: formField(value.requestId),
    fieldName: formField(value.fieldName),
    ...(release ? { uri: formField(value.uri) } : {}),
  };
}
/** @param {unknown} value */
function formField(value) {
  if (typeof value !== "string" || !value || value.length > 4096)
    throw new Error("Invalid form resource request");
  return value;
}
/** @param {unknown} accept */
function fileFilters(accept) {
  if (!Array.isArray(accept) || !accept.length) return undefined;
  /** @type {Record<string,string[]>} */
  const known = {
    "text/plain": ["txt", "text"],
    "text/csv": ["csv"],
    "application/json": ["json"],
    "application/pdf": ["pdf"],
    "image/png": ["png"],
    "image/jpeg": ["jpg", "jpeg"],
    "image/gif": ["gif"],
    "image/webp": ["webp"],
    "image/*": ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff"],
  };
  const extensions = [];
  for (const item of accept) {
    if (typeof item !== "string") return undefined;
    if (/^\.[a-z0-9]{1,16}$/i.test(item)) extensions.push(item.slice(1));
    else if (known[item]) extensions.push(...known[item]);
    else return undefined; // Unknown MIME stays selectable; authoritative Core still rejects mismatches.
  }
  return [{ name: "允许的文件", extensions: [...new Set(extensions)] }];
}
// Main only mediates consent. Core owns filesystem snapshots, grants and expiration.
class McpFormResources {
  /** @param {{backend:InstanceType<typeof import('./service-client.cjs').SharedCoreBackend>,choose:(options:Electron.OpenDialogOptions)=>Promise<Electron.OpenDialogReturnValue>,confirm:(options:Electron.MessageBoxOptions)=>Promise<Electron.MessageBoxReturnValue>}} options */
  constructor({ backend, choose, confirm }) {
    this.backend = backend;
    this.choose = choose;
    this.confirm = confirm;
    /** @type {Map<string,Promise<{resources:{uri:string,name:string,mimeType?:string,size?:number}[]}>>} */
    this.pending = new Map();
    /** @type {Map<string,UnsettledSelection>} */
    this.unsettled = new Map();
    this.disposed = false;
  }
  /** @param {FormOwner} request @param {()=>void} current */
  guard(request, current) {
    current();
    if (this.disposed) throw new Error("Form resources closed");
    if (!this.backend.ownsThread(request.projectId, request.threadId))
      throw new Error("Form resource owner expired");
  }
  /** @param {unknown} request @param {()=>void} current */
  async release(request, current) {
    const owner = identity(request, true);
    this.guard(owner, current);
    return this.backend.command("manage", { operation: "mcpFormResourceRelease", ...owner });
  }
  /** @param {unknown} request @param {()=>void} current */
  async pick(request, current) {
    const owner = identity(request);
    this.guard(owner, current);
    const key = JSON.stringify(owner);
    // The same pending user selection must never become two stage mutations.
    if (this.pending.has(key)) return this.pending.get(key);
    const pending = this.select(owner, current).finally(() => this.pending.delete(key));
    this.pending.set(key, pending);
    return pending;
  }
  /** @param {FormOwner} owner @param {()=>void} current */
  async select(owner, current) {
    /** @type {unknown} */
    let result;
    const key = JSON.stringify(owner);
    try {
      let selection = this.unsettled.get(key);
      if (!selection) {
        const prepared = readPrepared(
          await this.backend.command("manage", { operation: "mcpFormResourcePrepare", ...owner }),
        );
        this.guard(owner, current);
        const directory = prepared.userOptions?.kind === "directory";
        const chosen = await this.choose({
          title: `为 ${prepared.serverLabel} 选择${directory ? "目录" : "文件"}`,
          properties: [
            directory ? "openDirectory" : "openFile",
            ...(prepared.multiple ? [/** @type {const} */ ("multiSelections")] : []),
          ],
          ...(!directory ? { filters: fileFilters(prepared.userOptions?.accept) } : {}),
        });
        this.guard(owner, current);
        if (chosen.canceled || !chosen.filePaths?.length) return { resources: [] };
        if (!prepared.multiple && chosen.filePaths.length !== 1)
          throw new Error("Invalid selection count");
        // One UUID and its immutable selection survive UNKNOWN. Recovery never reopens the picker.
        const stage = {
          operation: "mcpFormResourceStage",
          projectId: owner.projectId,
          selectionToken: prepared.selectionToken,
          requestId: randomUUID(),
          paths: chosen.filePaths,
        };
        selection = { stage, prepared, directory, chosen };
        this.unsettled.set(key, selection);
        try {
          result = await this.backend.command("manage", stage);
        } catch (error) {
          // A conflict may describe another UNKNOWN request: this stage was not sent.
          if (
            !record(error) ||
            !error.submissionUnknown ||
            (error.requestId && error.requestId !== stage.requestId)
          )
            this.unsettled.delete(key);
          throw error;
        }
        this.unsettled.delete(key);
      } else {
        const receipt = await this.backend.command("manage", {
          operation: "mcpFormResourceSubmission",
          projectId: owner.projectId,
          requestId: selection.stage.requestId,
        });
        if (!record(receipt) || !receipt.confirmed) throw new Error("Upload outcome unknown");
        this.unsettled.delete(key);
        if (!receipt.accepted || receipt.status === "failed")
          throw new Error(typeof receipt.message === "string" ? receipt.message : "Upload failed");
        result = receipt.result;
      }
      const { prepared, directory, chosen } = selection;
      this.guard(owner, current);
      if (
        !record(result) ||
        !Array.isArray(result.resources) ||
        !result.resources.every(stagedResource)
      )
        throw new Error("Invalid staged resources");
      if (directory) {
        if (
          !record(result.summary) ||
          typeof result.summary.fileCount !== "number" ||
          !Number.isSafeInteger(result.summary.fileCount) ||
          result.summary.fileCount < 0 ||
          typeof result.summary.totalBytes !== "number" ||
          !Number.isSafeInteger(result.summary.totalBytes) ||
          result.summary.totalBytes < 0
        )
          throw new Error("Directory summary unavailable");
        const confirmation = await this.confirm({
          type: "question",
          buttons: ["取消", "添加目录"],
          defaultId: 0,
          cancelId: 0,
          title: "确认目录资源",
          message: `向 ${prepared.serverLabel} 添加目录`,
          detail: `${chosen.filePaths.map((item) => path.basename(item)).join("\n")}\n${result.summary.fileCount} 个文件 · ${result.summary.totalBytes} 字节\n提交表单后，服务器才能读取这些文件的副本。`,
        });
        this.guard(owner, current);
        if (confirmation.response !== 1) {
          await this.releaseAll(owner, result.resources);
          return { resources: [] };
        }
      }
      return {
        resources: result.resources.map(({ uri, name, mimeType, size }) => ({
          uri,
          name,
          ...(typeof mimeType === "string" ? { mimeType } : {}),
          ...(typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? { size } : {}),
        })),
      };
    } catch (error) {
      if (record(result) && Array.isArray(result.resources))
        await this.releaseAll(owner, result.resources).catch(() => {});
      if (
        /RESOURCE_UPLOAD_UNSUPPORTED/.test(error instanceof Error ? error.message : String(error))
      )
        throw new Error("RESOURCE_UPLOAD_UNSUPPORTED");
      throw new Error("资源选择未确认；请检查表单状态后再操作。");
    }
  }
  dispose() {
    this.disposed = true;
    this.pending.clear();
    this.unsettled.clear();
  }
  /** @param {FormOwner} owner @param {unknown[]} resources */
  async releaseAll(owner, resources) {
    await Promise.all(
      resources
        .flatMap((item) => (record(item) && typeof item.uri === "string" ? [item.uri] : []))
        .map((uri) =>
          this.backend.command("manage", { operation: "mcpFormResourceRelease", ...owner, uri }),
        ),
    );
  }
}
module.exports = { McpFormResources };

/** @param {unknown} value @returns {PreparedSelection} */
function readPrepared(value) {
  if (
    !record(value) ||
    typeof value.selectionToken !== "string" ||
    typeof value.multiple !== "boolean" ||
    typeof value.serverLabel !== "string" ||
    (value.userOptions !== undefined && !record(value.userOptions))
  )
    throw new Error("Invalid upload capability");
  return {
    selectionToken: value.selectionToken,
    multiple: value.multiple,
    serverLabel: value.serverLabel,
    ...(record(value.userOptions) ? { userOptions: value.userOptions } : {}),
  };
}
/** @param {unknown} item @returns {item is StagedResource} */
function stagedResource(item) {
  return (
    record(item) &&
    typeof item.uri === "string" &&
    /^areal-mcp-resource:\/\/[0-9a-f-]{36}$/.test(item.uri) &&
    typeof item.name === "string"
  );
}
