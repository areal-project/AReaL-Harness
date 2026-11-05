// @ts-check
"use strict";
const { modelRecord: record } = require("@areal/workbench/core-model-contract");
const { isDeepStrictEqual } = require("node:util");

/** @param {import("@areal/workbench-service/desktop/core/provider-contract.cjs").ModelSnapshot|undefined} previous @param {import("@areal/workbench-service/desktop/core/provider-contract.cjs").ModelSnapshot} current */
function unchangedOutsideTrajectory(previous, current) {
  if (!record(previous?.effective) || !record(current?.effective)) return false;
  /** @param {Record<string,unknown>} effective */
  const other = (effective) => {
    const { trajectory: _trajectory, sources: _sources, ...value } = effective;
    return value;
  };
  return (
    isDeepStrictEqual(other(previous.effective), other(current.effective)) &&
    isDeepStrictEqual(previous.data, current.data) &&
    isDeepStrictEqual(previous.defaultModel, current.defaultModel)
  );
}

// 上传控制立即生效；采集装配只复用 Core 的 ifIdle 排空与共享配置安全应用。
class TrajectoryApply {
  /** @param {InstanceType<typeof import("@areal/workbench-service/desktop/core/backend.cjs").CoreBackend>} backend */
  constructor(backend) {
    this.backend = backend;
    /** @type {string|null} */
    this.revision = null;
    /** @type {string|null} */
    this.error = null;
    /** @type {NodeJS.Timeout|undefined} */
    this.timer = undefined;
    this.running = false;
  }
  /** @param {import("@areal/workbench/desktop-contract").TrajectoryStatus} status */
  project(status) {
    const {
      capture_apply_pending: _capture_apply_pending,
      capture_apply_error: _capture_apply_error,
      ...value
    } = status;
    if (!this.revision && !this.error) {
      // 外部配置工具启用后，旧 Core 可能仍没有采集桥；只读状态也不能显示为就绪。
      const inactiveCapture =
        value.enabled &&
        [...(this.backend.projects?.values() ?? [])].some(
          (project) =>
            project.service &&
            record(project.providerSnapshot?.effective) &&
            record(project.providerSnapshot.effective.trajectory) &&
            project.providerSnapshot.effective.trajectory.enabled === false,
        );
      return inactiveCapture
        ? {
            ...value,
            capture_apply_pending: false,
            capture_apply_error:
              "当前 Core 尚未启用采集，请重新切换开关或在后台服务中安全应用配置。",
          }
        : value;
    }
    return {
      ...value,
      capture_apply_pending: !!this.revision,
      capture_apply_error: this.error,
    };
  }
  /** @param {string} revision */
  schedule(revision) {
    clearTimeout(this.timer);
    this.revision = revision;
    this.error = null;
    this.later();
  }
  later() {
    clearTimeout(this.timer);
    if (this.backend.closing || !this.revision) return;
    this.timer = setTimeout(() => void this.tryApply(), 1000);
    this.timer.unref?.();
  }
  async tryApply() {
    const backend = this.backend;
    if (!this.revision || this.running || backend.closing) return;
    const revision = this.revision;
    if (
      backend.providerUpdating ||
      backend.resourcesUpdating ||
      backend.activeCommands ||
      backend.starting.size ||
      backend.hasWork()
    ) {
      this.later();
      return;
    }
    this.running = true;
    backend.providerUpdating = true;
    try {
      const current = await backend.providers.config.current();
      if (this.revision !== revision) return;
      // 后续模型/工具编辑需要用户按原流程应用，不能借启停自动应用另一份配置。
      if (current.revision !== this.revision) {
        this.revision = null;
        this.error = "配置已有其它变化，请在后台服务中安全应用当前配置。";
        return;
      }
      const projects = [...backend.projects.values()].filter((project) => project.service);
      if (
        projects.every(
          (project) => project.client?.ready && project.providerRevision === current.revision,
        )
      ) {
        this.revision = null;
        this.error = null;
        return;
      }
      if (
        projects.some((project) => !unchangedOutsideTrajectory(project.providerSnapshot, current))
      ) {
        this.revision = null;
        this.error = "还有其它配置待应用，请在后台服务中安全应用当前配置。";
        return;
      }
      for (const project of projects) {
        const status =
          project.client?.ready &&
          (await project.client.request("areal/server/status", {}, { timeoutMs: 3000 }));
        if (this.revision !== revision) return;
        if (!record(status) || !status.restartSafe) {
          this.later();
          return;
        }
      }
      // Capture is a startup assembly, outside the model-only hot-apply contract.
      // restartProject owns ifIdle admission and requires the original Host cleanup receipt.
      for (const project of projects) {
        if (this.revision !== revision) return;
        if ((await backend.providers.config.current()).revision !== revision)
          throw new Error("配置已有其它变化，请在后台服务中安全应用当前配置。");
        if (project.client?.ready && project.providerRevision === revision) continue;
        await backend.restartProject(project, { expectedRevision: revision });
        if (this.revision !== revision) return;
        if (project.providerRevision !== revision)
          throw new Error("部分 Core 尚未应用采集配置，请重新连接后台服务。");
      }
      this.revision = null;
      this.error = null;
    } catch (error) {
      if (this.revision !== revision) return;
      // 准入竞态交回已有安全应用机制；不取消任务或重复重放客户端操作。
      if (
        /请等待任务|尚有未结算|正在应用|重新连接项目|正在运行的任务或终端/.test(
          error instanceof Error ? error.message : String(error),
        )
      )
        this.later();
      else {
        this.revision = null;
        this.error = backend.providers.redact(
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      backend.providerUpdating = false;
      this.running = false;
      if (this.revision && !this.error) this.later();
      else clearTimeout(this.timer);
      backend.onChange();
    }
  }
}
module.exports = { TrajectoryApply };
