// @ts-check
"use strict";
const { readFile } = require("node:fs/promises");
const { join, isAbsolute } = require("node:path");
const { homedir } = require("node:os");
const { modelRecord } = require("@areal/workbench/core-model-contract");
const catalogContract = require("@areal/workbench/desktop-contract/catalog");

// 过渡：到 0.1.21 删；旧投影只转发原生 Host 预约，不再创建目录或登记项目。
class ProjectlessWorkspaces {
    /** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend */
    constructor(backend) {
        this.backend = backend;
        /** @type {Record<string,{root:string,existing?:boolean}>} */
        this.records = {};
    }
    async init() {
        try {
            const value = JSON.parse(
                await readFile(join(this.backend.home, "projectless-drafts.json"), "utf8"),
            );
            if (!isAllocations(value)) throw new Error("项目外目录预约结构无效");
            this.records = value;
        } catch (error) {
            if (!modelRecord(error) || error.code !== "ENOENT") throw error;
        }
    }
    snapshot() {
        return {
            directory:
                this.backend.library.value.settings.projectlessDirectory ??
                join(this.backend.userHome ?? homedir(), "Documents", "AReaL"),
        };
    }
    /** @param {Record<string,unknown> & {operation:string}} request */
    async command(request) {
        if (!catalogContract.isRequest("projectless", request)) throw new Error("无效项目外请求");
        if (!this.backend.hostCall) throw new Error("Projectless Host unavailable");
        const value = await this.backend.hostCall("projectless.command", request);
        await this.init();
        return value;
    }
}
module.exports = { ProjectlessWorkspaces };

/** @param {unknown} value @returns {value is Record<string,{root:string,existing?:boolean}>} */
function isAllocations(value) {
    return (
        modelRecord(value) &&
        Object.values(value).every(
            (item) =>
                modelRecord(item) &&
                typeof item.root === "string" &&
                isAbsolute(item.root) &&
                (item.existing === undefined || typeof item.existing === "boolean"),
        )
    );
}
