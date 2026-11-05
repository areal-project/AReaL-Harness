// @ts-check
"use strict";
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { readCommandInvocation } = require("@areal/workbench/desktop-contract");
const { TrajectoryApply } = require("./trajectory-apply.cjs");
const execute = promisify(execFile);

const { publicStatus } = require("@areal/workbench/desktop-contract/trajectory");
/** @returns {never} */
function invalid() {
  throw new Error("Core 返回了无效的数据飞轮状态，请检查 Core 版本");
}

class TrajectoryExport {
  /** @param {InstanceType<typeof import("@areal/workbench-service/desktop/core/backend.cjs").CoreBackend>} backend */
  constructor(backend) {
    this.backend = backend;
    this.apply = new TrajectoryApply(backend);
  }
  /** @param {import("@areal/workbench/desktop-contract").TrajectoryRequest} request */
  async setEnabled(request) {
    readCommandInvocation("trajectory", request);
    if (request.operation !== "setEnabled") invalid();
    const backend = this.backend;
    if (
      backend.closing ||
      backend.providerUpdating ||
      backend.resourcesUpdating ||
      backend.activeCommands ||
      backend.starting.size
    )
      throw new Error("配置正在应用，请稍后重试");
    backend.providerUpdating = true;
    let value;
    try {
      value = await this.command(request);
      const current = await backend.providers.config.current();
      this.apply.schedule(current.revision);
    } catch (error) {
      if (!value) throw error;
      // 上传开关可能已经写入；采集核验失败必须在后续轮询中继续可见。
      clearTimeout(this.apply.timer);
      this.apply.revision = null;
      this.apply.error = `上传控制已应用，但无法核验采集配置：${backend.providers.redact(error instanceof Error ? error.message : String(error))}。请在后台服务中安全应用配置。`;
    } finally {
      backend.providerUpdating = false;
    }
    await this.apply.tryApply();
    if (!value) invalid();
    return this.apply.project(value);
  }
  /** @param {import("@areal/workbench/desktop-contract").TrajectoryRequest} request */
  async command(request) {
    readCommandInvocation("trajectory", request);
    const args =
      request.operation === "setEnabled"
        ? [
            "trajectory",
            "set-enabled",
            String(request.enabled),
            "--expected-revision",
            request.expectedRevision,
          ]
        : ["trajectory", request.operation];
    if (this.backend.config) args.push("--config", this.backend.config);
    let stdout;
    try {
      if (request.operation !== "status") await this.backend.providers.config.refreshCredentials();
      ({ stdout } = await execute(this.backend.binary, args, {
        // 重试可能启动上传进程，须与 Core 启动继承同一凭据环境；只读状态不解密凭据。
        env: {
          ...this.backend.hooks.environment(),
          ...(request.operation !== "status" ? this.backend.providers.environment() : {}),
        },
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
      }));
    } catch (error) {
      const detail = this.backend.providers
        .redact(
          error instanceof Error && "stderr" in error && typeof error.stderr === "string"
            ? error.stderr
            : error instanceof Error
              ? error.message
              : String(error),
        )
        .slice(0, 2048);
      throw new Error(
        `数据飞轮${request.operation === "setEnabled" ? "启停" : request.operation === "retry" ? "重试" : "状态读取"}失败：${detail}`,
      );
    }
    /** @type {unknown} */
    let value;
    try {
      value = JSON.parse(stdout);
    } catch {
      invalid();
    }
    return this.apply.project(publicStatus(value));
  }
}

module.exports = { TrajectoryExport, publicStatus };
