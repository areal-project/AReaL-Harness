import { useEffect, useRef, useState } from "react";
import {
  ActionButton,
  Button,
  Feedback,
  SettingsGroupCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "./base-components.js";

type Artifact = {
  id: string;
  name: string;
  type: string;
  information: string;
  outcome: "checked" | "failed" | "unknown" | "unavailable";
};

const artifacts = [
  { id: "guide", name: "项目快速开始.md", type: "文档", information: "当前可用", outcome: "checked" },
  { id: "trace", name: "本轮执行过程与工具返回记录-包含中文和English的长文件名.ndjson", type: "记录", information: "当前可用", outcome: "failed" },
  { id: "screenshot", name: "结果截图.png", type: "图片", information: "当前可用", outcome: "checked" },
  { id: "remote", name: "远端模型产物.bin", type: "其他", information: "仅远端可用", outcome: "unavailable" },
  { id: "draft", name: "交付摘要草稿.md", type: "文档", information: "资料可能过期", outcome: "unknown" },
  { id: "metrics", name: "运行指标.json", type: "记录", information: "当前可用", outcome: "checked" },
] as const satisfies readonly Artifact[];

type ArtifactId = (typeof artifacts)[number]["id"];
type ReviewResult =
  | { status: "未核对" }
  | { status: "处理中"; operationId: string; intent: "check" | "resolve" }
  | { status: "已核对" | "明确失败" | "结果未知"; operationId: string };

const filters = ["全部", "文档", "记录", "图片", "其他", "视频"] as const;

export function ArtifactReviewExercise({ baseVersion }: { baseVersion: string }) {
  const [filter, setFilter] = useState("全部");
  const [selectedId, setSelectedId] = useState<ArtifactId | null>("guide");
  const [refreshCount, setRefreshCount] = useState(0);
  const [results, setResults] = useState<Record<ArtifactId, ReviewResult>>({
    guide: { status: "未核对" },
    trace: { status: "未核对" },
    screenshot: { status: "未核对" },
    remote: { status: "未核对" },
    draft: { status: "未核对" },
    metrics: { status: "未核对" },
  });
  const timers = useRef(new Map<ArtifactId, ReturnType<typeof setTimeout>>());
  const nextOperation = useRef(0);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(timer => clearTimeout(timer));
      pending.clear();
    };
  }, []);

  const visibleArtifacts = artifacts.filter(artifact => filter === "全部" || artifact.type === filter);
  const selected = visibleArtifacts.find(artifact => artifact.id === selectedId);
  const result = selected ? results[selected.id] : undefined;

  function changeFilter(value: string) {
    const visible = artifacts.filter(artifact => value === "全部" || artifact.type === value);
    setFilter(value);
    setSelectedId(current => visible.some(artifact => artifact.id === current)
      ? current
      : visible[0]?.id ?? null);
  }

  function review(artifact: (typeof artifacts)[number], intent: "check" | "resolve") {
    const previous = results[artifact.id];
    if (artifact.outcome === "unavailable" || timers.current.has(artifact.id)) return;
    if (intent === "check" ? previous.status !== "未核对" : previous.status !== "结果未知") return;
    const operationId = previous.status === "结果未知"
      ? previous.operationId
      : `artifact-${artifact.id}-${++nextOperation.current}`;
    setResults(current => ({
      ...current,
      [artifact.id]: { status: "处理中", operationId, intent },
    }));
    const timer = setTimeout(() => {
      timers.current.delete(artifact.id);
      setResults(current => {
        const pending = current[artifact.id];
        if (pending.status !== "处理中" || pending.operationId !== operationId || pending.intent !== intent) return current;
        const status = intent === "resolve" || artifact.outcome === "checked"
          ? "已核对"
          : artifact.outcome === "failed" ? "明确失败" : "结果未知";
        return { ...current, [artifact.id]: { status, operationId } };
      });
    }, 500);
    timers.current.set(artifact.id, timer);
  }

  return (
    <SettingsPage
      title="交付物核对"
      subtitle={`Base ${baseVersion} · 本地模拟，不连接 Core、文件系统或模型服务，不代表真实交付物已经核对。`}
    >
      <SettingsSection title="查找交付物">
        <SettingsGroupCard>
          <SettingsRow
            label="类型筛选"
            control={
              <SettingsSelect aria-label="类型筛选" value={filter} onValueChange={changeFilter}>
                {filters.map(value => <option key={value} value={value}>{value}</option>)}
              </SettingsSelect>
            }
          />
          <SettingsRow
            label={`资料刷新：${refreshCount}`}
            description="刷新只更新资料次数和说明，保留核对结果。"
            control={<ActionButton type="button" onClick={() => setRefreshCount(count => count + 1)}>刷新资料</ActionButton>}
          />
        </SettingsGroupCard>
      </SettingsSection>

      <SettingsSection title="交付物列表">
        {visibleArtifacts.length ? (
          <SettingsGroupCard>
            {visibleArtifacts.map(artifact => {
              const itemResult = results[artifact.id];
              return (
                <SettingsRow
                  key={artifact.id}
                  label={artifact.name}
                  description={`${artifact.type} · ${itemResult.status}`}
                  control={
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      aria-label={`选择${artifact.name}`}
                      aria-pressed={selectedId === artifact.id}
                      onClick={() => setSelectedId(artifact.id)}
                    >
                      {selectedId === artifact.id ? "已选择" : "选择"}
                    </Button>
                  }
                  detail={itemResult.status === "明确失败"
                    ? <Feedback error="明确失败，文件已移走。" />
                    : itemResult.status === "结果未知"
                      ? <Feedback message={`结果未知。操作标识：${itemResult.operationId}。请显式核对结果。`} />
                      : undefined}
                />
              );
            })}
          </SettingsGroupCard>
        ) : <Feedback message="此类型下没有交付物。请选择其他类型。" />}
      </SettingsSection>

      {selected && result && (
        <section aria-label="交付物详情">
          <SettingsSection title={selected.name}>
            <SettingsGroupCard>
              <SettingsRow
                label="资料状态"
                description={refreshCount
                  ? `${selected.information}。已完成 ${refreshCount} 次本地资料刷新。`
                  : selected.information}
                control={<span className="text-ui-sm text-foreground-subtle">{selected.type}</span>}
              />
              <SettingsRow
                label="核对结果"
                description={result.status}
                control={
                  result.status === "结果未知" || (result.status === "处理中" && result.intent === "resolve") ? (
                    <ActionButton
                      type="button"
                      pending={result.status === "处理中"}
                      onClick={() => review(selected, "resolve")}
                    >核对结果</ActionButton>
                  ) : (
                    <ActionButton
                      type="button"
                      pending={result.status === "处理中"}
                      disabled={selected.outcome === "unavailable" || result.status !== "未核对"}
                      onClick={() => review(selected, "check")}
                    >核对交付物</ActionButton>
                  )
                }
                detail={
                  <>
                    {selected.outcome === "unavailable" && <Feedback message="本地核对不可用，此交付物仅远端可用，本地没有可核对的文件。" />}
                    {result.status === "处理中" && <Feedback message="处理中，正在等待此交付物的本地模拟结果。" />}
                    {result.status === "已核对" && <Feedback message="已核对，内容与记录一致。" />}
                    {result.status === "明确失败" && <Feedback error="明确失败，文件已移走。" />}
                    {result.status === "结果未知" && <Feedback message="结果未知，不会自动重复核对。请点击核对结果确认本次操作。" />}
                    {result.status !== "未核对" && <p className="text-ui-sm text-foreground-subtle">操作标识：{result.operationId}</p>}
                  </>
                }
              />
            </SettingsGroupCard>
          </SettingsSection>
        </section>
      )}
    </SettingsPage>
  );
}
