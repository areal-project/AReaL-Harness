"use strict";
// 工作台服务的后端门面：Main 领域文件原来用 CoreBackend 的字段，这里每个字段都经 Host 取。
// 没有的字段（窗口、对话框、桌面工具）不提供，搬运时一用就报错，说明该留在外壳。
const { mkdir, rename, writeFile, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");

/** @typedef {{projectId:string,ready:boolean}} HostProject */
/** @typedef {{home:string,closing:boolean,save:(name:string,value:unknown)=>Promise<void>,projects:()=>Promise<HostProject[]>,core:(projectId:string)=>{request:(method:string,params:Record<string,unknown>)=>Promise<any>}}} Backend */

const NAME = /^[a-z][a-z0-9-]*\.json$/;

/**
 * @param {{data:string, host:(call:string, params:unknown)=>Promise<any>}} options
 * @returns {Backend}
 */
function createBackend({ data, host }) {
  const backend = {
    home: data,
    closing: false,
    /** 只写在服务自己的数据目录里，先写临时文件再改名，不留半个文件。 */
    async save(/** @type {string} */ name, /** @type {unknown} */ value) {
      if (!NAME.test(name)) throw new Error("INVALID_PARAMS");
      await mkdir(data, { recursive: true, mode: 0o700 });
      const target = join(data, name);
      const temporary = join(data, `.${name}.${randomUUID()}`);
      try {
        await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
    async projects() {
      const result = await host("projects.list", {});
      return Array.isArray(result?.projects) ? result.projects : [];
    },
    core(/** @type {string} */ projectId) {
      return {
        request: (/** @type {string} */ method, /** @type {Record<string,unknown>} */ params) =>
          host("core.request", { projectId, method, params }),
      };
    },
  };
  return backend;
}

module.exports = { createBackend };
