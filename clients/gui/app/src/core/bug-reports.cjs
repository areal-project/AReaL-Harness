// @ts-check
"use strict";
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const contract = require("@areal/workbench/desktop-contract/bug-report");
/** @typedef {import('@areal/workbench/desktop-contract/bug-report').Report} Report */

class BugReports {
  /** @param {{root:string,collect:()=>Promise<Awaited<ReturnType<typeof import('./diagnostics.cjs').collect>>>,normalizeImage:(data:string)=>string}} options */
  constructor({ root, collect, normalizeImage }) {
    this.root = root;
    this.collect = collect;
    this.normalizeImage = normalizeImage;
    /** @type {Map<string,{at:number,text:string}>} */
    this.prepared = new Map();
    this.queue = Promise.resolve();
  }
  async directory() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const status = await fs.lstat(this.root);
    if (!status.isDirectory() || status.isSymbolicLink())
      throw new Error("BUG_REPORT_STORAGE_UNAVAILABLE");
  }
  /** @param {string} id */
  async read(id) {
    const file = await fs.open(
      join(this.root, `${id}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 40 * 1024 * 1024) throw new Error("BUG_REPORT_INVALID");
      const value = JSON.parse(await file.readFile("utf8"));
      if (!contract.report(value) || value.id !== id) throw new Error("BUG_REPORT_INVALID");
      return value;
    } finally {
      await file.close();
    }
  }
  /** @param {import('@areal/workbench/desktop-contract/bug-report').Request} request */
  command(request) {
    const task = this.queue.then(() => this.perform(request));
    this.queue = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  /** @param {import('@areal/workbench/desktop-contract/bug-report').Request} request @returns {Promise<import('@areal/workbench/desktop-contract/bug-report').Response>} */
  async perform(request) {
    if (!contract.isRequest(request)) throw new Error("BUG_REPORT_INVALID");
    await this.directory();
    if (request.operation === "prepare") {
      const report = await this.collect();
      // 反馈仅复用诊断白名单投影；去掉供应商域名、模型名、路径指纹与跨报告稳定身份。
      const aliases = new Map();
      const text = JSON.stringify(
        report,
        (key, value) => {
          if (["endpoint", "model", "instance", "crashDumps", "serviceId"].includes(key))
            return undefined;
          if (
            [
              "requestId",
              "runId",
              "appRunId",
              "project",
              "operationId",
              "parentOperationId",
              "incidentId",
            ].includes(key) &&
            typeof value === "string"
          ) {
            if (!aliases.has(value)) aliases.set(value, `ref-${aliases.size + 1}`);
            return aliases.get(value);
          }
          return value;
        },
        2,
      );
      if (Buffer.byteLength(text) > 24 * 1024 * 1024)
        throw new Error("BUG_REPORT_CONTEXT_TOO_LARGE");
      if (this.prepared.size >= 8) this.prepared.delete(this.prepared.keys().next().value ?? "");
      const token = randomUUID();
      this.prepared.set(token, { at: Date.now(), text });
      return { token, diagnostics: text };
    }
    if (request.operation === "list") {
      const entries = (await fs.readdir(this.root)).filter((name) =>
        /^[a-f0-9-]{36}\.json$/.test(name),
      );
      const reports = await Promise.all(
        entries.slice(0, 20).map(async (name) => {
          const report = await this.read(name.slice(0, -5));
          return {
            id: report.id,
            createdAt: report.createdAt,
            screenshotCount: report.screenshots.length,
            hasDiagnostics: report.diagnostics !== null,
          };
        }),
      );
      return { reports: reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
    }
    if (request.operation === "read") return { report: await this.read(request.id) };
    if (request.operation === "delete") {
      await fs.unlink(join(this.root, `${request.id}.json`));
      return { deleted: true };
    }
    if (request.operation !== "save") throw new Error("BUG_REPORT_INVALID");
    const screenshots = request.screenshots.map(this.normalizeImage);
    const prepared = request.diagnosticsToken
      ? this.prepared.get(request.diagnosticsToken)
      : undefined;
    try {
      const existing = await this.read(request.id);
      if (
        existing.description !== request.description ||
        JSON.stringify(existing.screenshots) !== JSON.stringify(screenshots) ||
        (existing.diagnostics !== null) !== !!request.diagnosticsToken ||
        (prepared && existing.diagnostics !== prepared.text)
      )
        throw new Error("BUG_REPORT_CONFLICT");
      return { id: request.id };
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
    }
    const entries = (await fs.readdir(this.root)).filter((name) => name.endsWith(".json"));
    if (entries.length >= 20) throw new Error("BUG_REPORT_CAPACITY");
    if (request.diagnosticsToken && (!prepared || Date.now() - prepared.at > 30 * 60 * 1000))
      throw new Error("BUG_REPORT_PREVIEW_EXPIRED");
    const report = {
      schemaVersion: 1,
      id: request.id,
      createdAt: new Date().toISOString(),
      state: "local-only",
      description: request.description,
      screenshots,
      diagnostics: prepared?.text ?? null,
    };
    const temporary = join(this.root, `${request.id}-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(report), { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, join(this.root, `${request.id}.json`));
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
    return { id: request.id };
  }
}
/** @param {string} destination @param {Report} report */
async function exportReport(destination, report) {
  const temporary = join(
    require("node:path").dirname(destination),
    `.areal-bug-${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}
module.exports = { BugReports, exportReport };
