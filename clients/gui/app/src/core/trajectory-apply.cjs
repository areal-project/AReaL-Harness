"use strict";
const { isDeepStrictEqual } = require("node:util");

function unchangedOutsideTrajectory(previous, current) {
    if (!previous?.effective || !current?.effective) return false;
    const other = ({ trajectory, sources, ...value }) => value;
    return (
        isDeepStrictEqual(other(previous.effective), other(current.effective)) &&
        isDeepStrictEqual(previous.data, current.data) &&
        isDeepStrictEqual(previous.defaultModel, current.defaultModel)
    );
}

// 上传控制立即生效；采集装配只复用 Core 的 ifIdle 排空与共享配置安全应用。
class TrajectoryApply {
    constructor(backend) {
        this.backend = backend;
        this.revision = null;
        this.error = null;
    }
    project(status) {
        const { capture_apply_pending, capture_apply_error, ...value } = status;
        if (!this.revision && !this.error) {
            // 外部配置工具启用后，旧 Core 可能仍没有采集桥；只读状态也不能显示为就绪。
            const inactiveCapture =
                value.enabled &&
                [...(this.backend.projects?.values() ?? [])].some(
                    (project) =>
                        project.service &&
                        project.providerSnapshot?.effective?.trajectory?.enabled === false,
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
                    (project) =>
                        project.client?.ready && project.providerRevision === current.revision,
                )
            ) {
                this.revision = null;
                this.error = null;
                return;
            }
            if (
                projects.some(
                    (project) => !unchangedOutsideTrajectory(project.providerSnapshot, current),
                )
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
                if (!status?.restartSafe) {
                    this.later();
                    return;
                }
            }
            const result = await backend.providers.command({
                operation: "apply",
                expectedRevision: current.revision,
            });
            if (this.revision !== revision) return;
            if (result.pendingApply || result.warning) {
                this.error = result.warning || "部分 Core 尚未应用采集配置，请重新连接后台服务。";
                this.revision = null;
            } else {
                this.revision = null;
                this.error = null;
            }
        } catch (error) {
            if (this.revision !== revision) return;
            // 准入竞态交回已有安全应用机制；不取消任务或重复重放客户端操作。
            if (
                /请等待任务|尚有未结算|正在应用|重新连接项目|正在运行的任务或终端/.test(
                    error.message,
                )
            )
                this.later();
            else {
                this.revision = null;
                this.error = backend.providers.redact(error.message);
            }
        } finally {
            this.running = false;
            if (this.revision && !this.error) this.later();
            else clearTimeout(this.timer);
            backend.onChange();
        }
    }
}
module.exports = { TrajectoryApply };
