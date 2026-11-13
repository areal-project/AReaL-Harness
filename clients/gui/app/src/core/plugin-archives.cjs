// @ts-check
"use strict";
const { basename } = require("node:path");
const { randomUUID } = require("node:crypto");
const { record } = require("@areal/workbench-service/desktop/core/resource-contract.cjs");

class PluginArchives {
  /** @param {{backend:Pick<InstanceType<typeof import("./service-client.cjs").SharedCoreBackend>,"snapshot"|"command">,choose:(options:import("electron").OpenDialogOptions)=>Promise<import("electron").OpenDialogReturnValue>}} options */
  constructor({ backend, choose }) {
    this.backend = backend;
    this.choose = choose;
    /** @type {Map<string,{projectId:string,path:string,expires:number}>} */
    this.selections = new Map();
  }
  /** @param {unknown} request @param {()=>void} authorize */
  async command(request, authorize) {
    if (!record(request) || typeof request.projectId !== "string") throw new Error("请先打开项目");
    const projectId = request.projectId;
    const project = () => {
      authorize();
      if (!this.backend.snapshot().projects.some((item) => item.id === projectId))
        throw new Error("请先打开项目");
    };
    project();
    if (request.operation === "pluginArchivePick") {
      for (const [token, selection] of this.selections) {
        if (selection.expires < Date.now() || selection.projectId === projectId)
          this.selections.delete(token);
      }
      if (this.selections.size >= 16) throw new Error("待导入插件包过多");
      const result = await this.choose({
        title: "导入插件包",
        properties: ["openFile"],
        filters: [{ name: "ZIP 插件包", extensions: ["zip"] }],
      });
      project();
      if (result.canceled || !result.filePaths.length) return { canceled: true };
      const selectionToken = randomUUID();
      this.selections.set(selectionToken, {
        projectId: projectId,
        path: result.filePaths[0],
        expires: Date.now() + 600000,
      });
      return { selectionToken, fileName: basename(result.filePaths[0]) };
    }
    const selection =
      typeof request.selectionToken === "string"
        ? this.selections.get(request.selectionToken)
        : undefined;
    if (!selection || selection.projectId !== projectId || selection.expires < Date.now())
      throw new Error("插件包选择已失效，请重新选择");
    if (typeof request.selectionToken === "string") this.selections.delete(request.selectionToken);
    return this.backend.command("manage", {
      operation: "pluginArchiveImport",
      projectId: projectId,
      path: selection.path,
      expectedRevision: request.expectedRevision,
      requestId: request.requestId,
    });
  }
}
module.exports = { PluginArchives };
