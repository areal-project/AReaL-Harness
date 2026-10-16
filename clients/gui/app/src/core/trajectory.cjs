"use strict";
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { validateCommand } = require("@areal/workbench/desktop-contract");
const { TrajectoryApply } = require("./trajectory-apply.cjs");
const execute = promisify(execFile);

function invalid() {
    throw new Error("Core 返回了无效的数据飞轮状态，请检查 Core 版本");
}
function text(value) {
    if (typeof value !== "string") invalid();
    return value;
}
function optionalText(value) {
    return value == null ? null : text(value);
}
function count(value) {
    if (!Number.isSafeInteger(value) || value < 0) invalid();
    return value;
}
function timestamp(value) {
    return value == null ? null : count(value);
}
function duration(value) {
    if (value == null) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid();
    return value;
}
function modelDuration(record) {
    if (!Object.hasOwn(record, "model_call_duration_ms")) return {};
    const value = duration(record.model_call_duration_ms);
    if (value != null && record.event_name !== "gen_ai.client.inference.operation.details")
        invalid();
    return { model_call_duration_ms: value };
}
function modelSummary(value, recordCount) {
    if (!value || value.scope !== "recent_records" || value.record_limit !== 100) invalid();
    const considered = count(value.records_considered),
        calls = count(value.model_calls);
    if (considered !== recordCount || considered > 100 || calls > considered) invalid();
    const total = duration(value.total_duration_ms),
        mean = duration(value.mean_duration_ms),
        maximum = duration(value.max_duration_ms);
    // 旧记录没有计时不补零；总和溢出时 Core 可保留有效最大值并将总和/平均标为未知。
    if (
        (total == null) !== (mean == null) ||
        (calls === 0 ? total != null || maximum != null : maximum == null)
    )
        invalid();
    return {
        scope: "recent_records",
        record_limit: 100,
        records_considered: considered,
        model_calls: calls,
        total_duration_ms: total,
        mean_duration_ms: mean,
        max_duration_ms: maximum,
    };
}
function boolean(value) {
    if (typeof value !== "boolean") invalid();
    return value;
}
function choice(value, allowed) {
    if (!allowed.includes(value)) invalid();
    return value;
}

// 只向界面投影已约定的状态字段，Core 新增字段不会自动穿过 IPC。
function publicStatus(value) {
    if (!value || !Array.isArray(value.records) || !value.queue || !value.limits) invalid();
    return {
        enabled: boolean(value.enabled),
        ...(Object.hasOwn(value, "config_revision")
            ? {
                  config_revision:
                      value.config_revision === "missing" ||
                      /^[a-f0-9]{64}$/.test(text(value.config_revision))
                          ? value.config_revision
                          : invalid(),
              }
            : {}),
        state: choice(value.state, ["disabled", "ready", "degraded", "invalid"]),
        endpoint: text(value.endpoint),
        configPath: optionalText(value.configPath),
        spool_dir: text(value.spool_dir),
        worker_running: boolean(value.worker_running),
        queue: Object.fromEntries(
            [
                "pending",
                "uploading",
                "failed",
                "uploaded",
                "evicted",
                "bytes",
                "max_bytes",
                "dropped_memory",
                "dropped_oversize",
            ].map((key) => [key, count(value.queue[key])]),
        ),
        last_error: optionalText(value.last_error),
        last_success_at: timestamp(value.last_success_at),
        records: value.records.slice(0, 100).map((record) => ({
            id: text(record.id),
            status: choice(record.status, [
                "pending",
                "uploading",
                "failed",
                "uploaded",
                "evicted",
            ]),
            created_at: count(record.created_at),
            uploaded_at: timestamp(record.uploaded_at),
            attempts: count(record.attempts),
            next_attempt_at: timestamp(record.next_attempt_at),
            bytes: count(record.bytes),
            error: optionalText(record.error),
            ...Object.fromEntries(
                ["turn_id", "event_name", "model_name", "harness_version"]
                    .filter((key) => Object.hasOwn(record, key))
                    .map((key) => [key, optionalText(record[key])]),
            ),
            ...Object.fromEntries(
                ["execution_duration_ms", "occurred_at"]
                    .filter((key) => Object.hasOwn(record, key))
                    .map((key) => [key, timestamp(record[key])]),
            ),
            ...modelDuration(record),
        })),
        ...(Object.hasOwn(value, "model_call_summary")
            ? {
                  model_call_summary: modelSummary(
                      value.model_call_summary,
                      Math.min(value.records.length, 100),
                  ),
              }
            : {}),
        limits: Object.fromEntries(
            ["max_retries", "upload_interval_ms", "max_memory_bytes"].map((key) => [
                key,
                count(value.limits[key]),
            ]),
        ),
    };
}

class TrajectoryExport {
    constructor(backend) {
        this.backend = backend;
        this.apply = new TrajectoryApply(backend);
    }
    async setEnabled(request) {
        validateCommand("trajectory", request);
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
            this.apply.error = `上传控制已应用，但无法核验采集配置：${backend.providers.redact(error.message)}。请在后台服务中安全应用配置。`;
        } finally {
            backend.providerUpdating = false;
        }
        await this.apply.tryApply();
        return this.apply.project(value);
    }
    async command(request) {
        validateCommand("trajectory", request);
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
                .redact(error.stderr || error.message)
                .slice(0, 2048);
            throw new Error(
                `数据飞轮${request.operation === "setEnabled" ? "启停" : request.operation === "retry" ? "重试" : "状态读取"}失败：${detail}`,
            );
        }
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
