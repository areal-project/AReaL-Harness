import { useRef, useState } from "react";
import type { TrajectoryStatus } from "@areal/workbench/desktop-contract";
import { Button } from "../components/ui/button.js";
import type { Action } from "../services.js";
import { useTrajectoryPolling } from "./useTrajectoryPolling.js";
import {
    SettingsBadge,
    SettingsGroupCard,
    SettingsRow,
    SettingsSection,
} from "./SettingsPageParts.js";

const recordLabels = {
    pending: "待上传",
    uploading: "上传中",
    failed: "上传失败",
    uploaded: "已上传",
    evicted: "已淘汰",
};
const stateLabels = {
    disabled: "已关闭",
    ready: "就绪",
    degraded: "需要检查",
    invalid: "配置无效",
};
const size = (bytes: number) =>
    bytes < 1024
        ? `${bytes} B`
        : bytes < 1024 ** 2
          ? `${(bytes / 1024).toFixed(1)} KiB`
          : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
const date = (value: number | null) =>
    value == null ? "暂无记录" : new Date(value).toLocaleString();
const duration = (value: number | null | undefined) =>
    value == null ? "未知" : `${value.toLocaleString(undefined, { maximumFractionDigits: 3 })} ms`;

export function TrajectorySettings({
    action,
    connected,
    onStatus,
}: {
    action: Action;
    connected: boolean;
    onStatus: (status: TrajectoryStatus | null) => void;
}) {
    const [status, setStatus] = useState<TrajectoryStatus | null>(null);
    const [busy, setBusy] = useState<"status" | "retry" | null>(null);
    const [working, setWorking] = useState(false);
    const [error, setError] = useState(""),
        [notice, setNotice] = useState(""),
        [checkedAt, setCheckedAt] = useState("");
    const lastStatus = useRef<TrajectoryStatus | null>(null);
    const refresh = useTrajectoryPolling(action, {
        connected,
        intervalMs: 2500,
        onResult(value, operation) {
            lastStatus.current = value;
            setStatus(value);
            setError("");
            setCheckedAt(new Date().toLocaleTimeString());
            onStatus(value);
            if (operation === "retry") setNotice("已请求重试，上传进度将自动更新。");
        },
        onError(cause) {
            setError(cause instanceof Error ? cause.message : "无法读取轨迹上传状态。");
            onStatus(null);
        },
        onBusy(operation) {
            setWorking(operation !== null);
            // 后台刷新保留上次结果和错误；仅首次加载或显式操作显示读取中。
            if (!operation || operation === "retry" || !lastStatus.current) setBusy(operation);
        },
    });
    const run = (operation: "status" | "retry") => {
        if (refresh(operation)) {
            setBusy(operation);
            if (operation === "retry") setNotice("");
        }
    };
    const stale = !connected || !!error;
    return (
        <div className="settings-sections" aria-label="数据飞轮状态">
            <SettingsSection
                title="轨迹上传"
                description="轨迹由后台异步上传；此页可见且连接正常时，每 2.5 秒自动更新状态。"
                action={
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={!connected || working}
                        onClick={() => void run("status")}
                    >
                        刷新上传状态
                    </Button>
                }
            >
                {!connected && (
                    <p role="status" className="settings-section-desc">
                        后台适配器未连接，请在“后台服务”中连接后读取状态。
                    </p>
                )}
                <p role="status" className="settings-section-desc">
                    {busy === "status"
                        ? "读取中…"
                        : busy === "retry"
                          ? "请求重试中…"
                          : checkedAt
                            ? `上次读取：${checkedAt}${stale ? "（可能已过期）" : ""}`
                            : "尚未读取上传状态"}
                </p>
                {error && (
                    <p role="alert" className="text-destructive">
                        {error}
                        {status && " 上次读取结果可能已过期。"}
                    </p>
                )}
                {notice && <p role="status">{notice}</p>}
                {status && (
                    <SettingsGroupCard>
                        <SettingsRow
                            label="当前文件配置"
                            description={
                                status.enabled
                                    ? "已启用轨迹导出；运行中的 Core 需使用此配置并完成重启。"
                                    : "轨迹导出已关闭。"
                            }
                            control={<SettingsBadge>{stateLabels[status.state]}</SettingsBadge>}
                        />
                        <SettingsRow
                            label="上传进程"
                            description={
                                status.worker_running
                                    ? "后台上传进程正在运行。"
                                    : "未检测到上传进程；刷新状态不会启动它。"
                            }
                            control={<span>{status.worker_running ? "运行中" : "未运行"}</span>}
                        />
                        <SettingsRow
                            label="上传地址"
                            control={null}
                            description={
                                <span className="break-all">{status.endpoint || "尚未配置"}</span>
                            }
                        />
                        {status.configPath && (
                            <SettingsRow
                                label="配置文件"
                                control={null}
                                description={<span className="break-all">{status.configPath}</span>}
                            />
                        )}
                        <SettingsRow
                            label="本地上传缓存"
                            control={null}
                            description={<span className="break-all">{status.spool_dir}</span>}
                        />
                    </SettingsGroupCard>
                )}
            </SettingsSection>
            {status && (
                <>
                    <SettingsSection
                        title="队列与失败"
                        description="仅反映上传队列，不代表远端已完成数据分析或入库。"
                        action={
                            <Button
                                size="sm"
                                variant="outline"
                                disabled={
                                    !connected ||
                                    working ||
                                    !!error ||
                                    !status.enabled ||
                                    status.state === "invalid" ||
                                    status.queue.pending +
                                        status.queue.failed +
                                        status.queue.uploading ===
                                        0
                                }
                                onClick={() => void run("retry")}
                            >
                                重试上传
                            </Button>
                        }
                    >
                        <SettingsGroupCard>
                            <SettingsRow
                                label="待上传 / 上传中 / 失败"
                                control={
                                    <span>
                                        {status.queue.pending} / {status.queue.uploading} /{" "}
                                        {status.queue.failed}
                                    </span>
                                }
                            />
                            <SettingsRow
                                label="已上传"
                                control={<span>{status.queue.uploaded}</span>}
                                description={`最近成功：${date(status.last_success_at)}`}
                            />
                            <SettingsRow
                                label="队列占用"
                                control={
                                    <span>
                                        {size(status.queue.bytes)} / {size(status.queue.max_bytes)}
                                    </span>
                                }
                            />
                            <SettingsRow
                                label="已淘汰 / 内存丢弃 / 过大丢弃"
                                control={
                                    <span>
                                        {status.queue.evicted} / {status.queue.dropped_memory} /{" "}
                                        {status.queue.dropped_oversize}
                                    </span>
                                }
                                description="达到容量或批次大小限制时可能缺失轨迹，已淘汰或丢弃的数据无法通过重试恢复。"
                            />
                            <SettingsRow
                                label="重试与缓冲限制"
                                control={null}
                                description={`最多重试 ${status.limits.max_retries} 次 · 上传间隔 ${status.limits.upload_interval_ms} ms · 内存上限 ${size(status.limits.max_memory_bytes)}`}
                            />
                            <SettingsRow
                                label="最近失败原因"
                                control={null}
                                description={
                                    <span className="break-all">
                                        {status.last_error || "暂无失败记录"}
                                    </span>
                                }
                            />
                        </SettingsGroupCard>
                    </SettingsSection>
                    <SettingsSection
                        title="模型调用耗时"
                        description={`最近 ${status.model_call_summary?.records_considered ?? status.records.length} 条记录中的模型调用耗时；含请求准备、网络、模型调用内排队和重试，非纯服务端推理时间。`}
                    >
                        {status.model_call_summary ? (
                            <SettingsGroupCard>
                                <SettingsRow
                                    label="有耗时记录的模型调用"
                                    control={<span>{status.model_call_summary.model_calls}</span>}
                                    description="仅汇总最近最多 100 条上传记录，非完整历史；同一调用的上传重试不重复计入。缺失耗时保持未知。"
                                />
                                <SettingsRow
                                    label="调用耗时总和 / 平均 / 最大"
                                    control={null}
                                    description={[
                                        duration(status.model_call_summary.total_duration_ms),
                                        duration(status.model_call_summary.mean_duration_ms),
                                        duration(status.model_call_summary.max_duration_ms),
                                    ].join(" / ")}
                                />
                            </SettingsGroupCard>
                        ) : (
                            <p className="settings-section-desc">
                                当前 Core 未提供模型调用耗时汇总，耗时未知。
                            </p>
                        )}
                    </SettingsSection>
                    <SettingsSection
                        title="最近上传记录"
                        description="最多展示最近 100 条；事件发生、记录创建与上传成功时间分别显示。"
                    >
                        <SettingsGroupCard>
                            {status.records.length === 0 ? (
                                <p className="p-4 settings-section-desc">暂无轨迹上传记录。</p>
                            ) : (
                                status.records.map((record) => (
                                    <SettingsRow
                                        key={record.id}
                                        label={<span className="break-all">{record.id}</span>}
                                        control={
                                            <SettingsBadge>
                                                {recordLabels[record.status]}
                                            </SettingsBadge>
                                        }
                                        description={
                                            <>
                                                {record.turn_id && (
                                                    <p className="break-all">
                                                        Turn {record.turn_id}
                                                    </p>
                                                )}
                                                {(record.model_name || record.harness_version) && (
                                                    <p className="break-all">
                                                        {[
                                                            record.model_name &&
                                                                `模型 ${record.model_name}`,
                                                            record.harness_version &&
                                                                `Harness ${record.harness_version}`,
                                                        ]
                                                            .filter(Boolean)
                                                            .join(" · ")}
                                                    </p>
                                                )}
                                                {record.event_name && (
                                                    <p className="break-all">
                                                        事件 {record.event_name}
                                                    </p>
                                                )}
                                                {record.occurred_at != null &&
                                                    record.occurred_at > 0 && (
                                                        <p>事件发生 {date(record.occurred_at)}</p>
                                                    )}
                                                {record.execution_duration_ms != null && (
                                                    <p>
                                                        Agent 执行耗时（含工具/等待）{" "}
                                                        {duration(record.execution_duration_ms)}
                                                    </p>
                                                )}
                                                {record.model_call_duration_ms != null && (
                                                    <p>
                                                        模型调用耗时（含网络/重试）{" "}
                                                        {duration(record.model_call_duration_ms)}
                                                    </p>
                                                )}
                                                <span>
                                                    记录创建 {date(record.created_at)} ·{" "}
                                                    {size(record.bytes)} · 已尝试 {record.attempts}{" "}
                                                    次
                                                </span>
                                                {record.uploaded_at != null && (
                                                    <p>上传成功 {date(record.uploaded_at)}</p>
                                                )}
                                                {record.next_attempt_at != null &&
                                                    record.status !== "uploaded" &&
                                                    record.status !== "evicted" && (
                                                        <p>
                                                            下次尝试 {date(record.next_attempt_at)}
                                                        </p>
                                                    )}
                                                {record.error && (
                                                    <p className="break-all text-destructive">
                                                        {record.error}
                                                    </p>
                                                )}
                                            </>
                                        }
                                    />
                                ))
                            )}
                        </SettingsGroupCard>
                    </SettingsSection>
                </>
            )}
            <SettingsSection
                title="启用与修改"
                description="在用户配置中设置通用 OTLP 上传地址与认证引用。"
            >
                <p className="settings-section-desc">
                    编辑本页显示的配置文件中的 <code>[trajectory]</code>，设置开关、
                    <code>endpoint</code> 和凭据引用。修改后执行{" "}
                    <code>areal trajectory sync-config --config 配置文件路径</code>{" "}
                    应用上传控制，并安全重启已运行的 Core 服务以装配采集参数。
                    凭据由配置与环境管理，本页不显示凭据内容。
                </p>
            </SettingsSection>
        </div>
    );
}
