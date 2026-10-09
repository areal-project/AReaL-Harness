"use strict";
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { validateCommand } = require("@areal/workbench/desktop-contract");
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
        })),
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
    }
    async command(request) {
        validateCommand("trajectory", request);
        const args = ["trajectory", request.operation];
        if (this.backend.config) args.push("--config", this.backend.config);
        let stdout;
        try {
            ({ stdout } = await execute(this.backend.binary, args, {
                // 重试可能启动上传进程，须与 Core 启动继承同一凭据环境；只读状态不解密凭据。
                env: {
                    ...this.backend.hooks.environment(),
                    ...(request.operation === "retry" ? this.backend.providers.environment() : {}),
                },
                timeout: 15000,
                maxBuffer: 2 * 1024 * 1024,
            }));
        } catch (error) {
            const detail = this.backend.providers
                .redact(error.stderr || error.message)
                .slice(0, 2048);
            throw new Error(
                `数据飞轮${request.operation === "retry" ? "重试" : "状态读取"}失败：${detail}`,
            );
        }
        let value;
        try {
            value = JSON.parse(stdout);
        } catch {
            invalid();
        }
        return publicStatus(value);
    }
}

module.exports = { TrajectoryExport, publicStatus };
