// @ts-check
"use strict";
const { realpath, stat } = require("node:fs/promises");
const { watch } = require("node:fs");
const { resolve, relative, sep, basename, dirname } = require("node:path");
const { randomUUID } = require("node:crypto");
/** @typedef {{uri:string,path:string,root:string,relative:string,projectId:string,name:string,watcher:import('node:fs').FSWatcher|null}} AuthorizedFile */
/** @typedef {{method:string,params?:{uri?:unknown}}} FileRequest */
/** @param {{snapshot:()=>{projects:{id:string,root:string}[]}}} backend @param {string} projectId @param {unknown} requestedPath @returns {Promise<AuthorizedFile>} */
async function authorizeFile(backend, projectId, requestedPath) {
  const project = backend.snapshot().projects.find((p) => p.id === projectId);
  if (!project || typeof requestedPath !== "string" || requestedPath.includes("\0"))
    throw Error("Invalid workspace file");
  const root = await realpath(project.root),
    path = await realpath(resolve(root, requestedPath));
  if (!path.startsWith(root + sep)) throw Error("File is outside this workspace");
  const info = await stat(path);
  if (!info.isFile()) throw Error("Only regular files are supported");
  return {
    uri: `areal-file://${randomUUID()}`,
    path,
    root,
    relative: relative(root, path),
    projectId,
    name: basename(path),
    watcher: null,
  };
}
/** @param {AuthorizedFile|null|undefined} file @param {FileRequest} request @param {()=>void} current @param {(notice:{jsonrpc:'2.0',method:'notifications/resources/updated',params:{uri:string}})=>void} notify @param {((request:FileRequest)=>Promise<unknown>)|undefined} coreRequest */
async function fileRequest(file, request, current, notify, coreRequest) {
  if (!file || request.params?.uri !== file.uri) throw Error("Resource is not owned by this app");
  current();
  if (request.method === "resources/subscribe") {
    if (!file.watcher)
      file.watcher = watch(dirname(file.path), (_event, name) => {
        if (name && String(name) !== basename(file.path)) return;
        try {
          current();
          notify({
            jsonrpc: "2.0",
            method: "notifications/resources/updated",
            params: { uri: file.uri },
          });
        } catch {
          file.watcher?.close();
          file.watcher = null;
        }
      });
    return {};
  }
  if (request.method === "resources/unsubscribe") {
    file.watcher?.close();
    file.watcher = null;
    return {};
  }
  if (!["resources/read", "openai/resources/write"].includes(request.method))
    throw Error("Unsupported file resource operation");
  if (typeof coreRequest !== "function") throw Error("Core file grant unavailable");
  // Core resolves the persisted opaque grant through descriptor-anchored Runtime I/O.
  // Main never opens or rewrites a path after its initial user-context grant.
  const reply = await coreRequest(request);
  current();
  if (
    !reply ||
    typeof reply !== "object" ||
    ("error" in reply && reply.error) ||
    !("result" in reply)
  )
    throw Error("Core file operation rejected or incomplete");
  return reply.result;
}
module.exports = { authorizeFile, fileRequest };
