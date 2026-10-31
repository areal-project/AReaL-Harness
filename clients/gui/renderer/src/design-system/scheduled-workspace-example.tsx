import { useState } from "react";
import { ScheduledWorkspace } from "@areal/ui/experimental";
import { Button } from "@areal/ui";
import { CalendarClock, BookOpen, Clock, MoreHorizontal } from "lucide-react";
export function ScheduledWorkspaceExample() {
  const [empty, setEmpty] = useState(false),
    [selected, setSelected] = useState("");
  return (
    <section aria-label="定时工作区样例">
      <Button onClick={() => setEmpty((value) => !value)}>
        {empty ? "显示示例任务" : "显示空态"}
      </Button>
      <ScheduledWorkspace>
        <aside style={{ width: "13rem", flexShrink: 0 }}>
          {empty ? (
            <p>尚无定时任务</p>
          ) : (
            <>
              <ScheduledWorkspace.Group label="已开启">
                <ScheduledWorkspace.Item
                  title="每日进展"
                  description="明天 09:00"
                  aria-pressed={selected === "daily"}
                  onClick={() => setSelected("daily")}
                />
              </ScheduledWorkspace.Group>
              <ScheduledWorkspace.Group label="已暂停">
                <ScheduledWorkspace.Item
                  title="每周回顾"
                  description="已暂停"
                  aria-pressed={selected === "weekly"}
                  onClick={() => setSelected("weekly")}
                />
              </ScheduledWorkspace.Group>
            </>
          )}
        </aside>
        <ScheduledWorkspace.Welcome
          icon={<CalendarClock size={32} />}
          title={selected ? "已选择示例任务" : "安排任务"}
          description={selected ? "本页仅切换示例，不执行真实任务。" : "按计划处理持续性任务。"}
        >
          <ScheduledWorkspace.Template
            icon={<BookOpen size={18} />}
            title="每周知识回顾"
            description="整理本周记录、结论和下一步。"
            onClick={() => setSelected("template")}
          />
        </ScheduledWorkspace.Welcome>
      </ScheduledWorkspace>
      <div
        aria-label="定时任务行样例"
        style={{ display: "grid", gap: "0.5rem", marginTop: "1rem" }}
      >
        {(
          [
            ["enabled", "已开启", "每 10 分钟问好", "每 10 分钟 · 下次 今天 16:17"],
            ["running", "运行中", "临时工作树 Rust 缓存回收", "每 30 分钟 · 下次 今天 16:39"],
            ["attention", "需要处理", "每周长篇剧集精选", "上次运行被中断"],
            ["paused", "已暂停", "每天早上 10:10 问好", "每天 10:10"],
          ] as const
        ).map(([state, label, title, summary]) => (
          <ScheduledWorkspace.TaskRow
            key={state}
            variant="card"
            icon={<Clock size={16} />}
            title={title}
            summary={summary}
            state={state}
            stateLabel={label}
            actions={
              <Button size="icon-sm" variant="ghost" aria-label="更多操作">
                <MoreHorizontal />
              </Button>
            }
          />
        ))}
        <div style={{ width: "18rem" }}>
          {(
            [
              ["enabled", "已开启", "每 10 分钟问好", "每 10 分钟"],
              ["attention", "需要处理", "每天早上 10:10 问好", "上次运行失败"],
            ] as const
          ).map(([state, label, title, summary]) => (
            <ScheduledWorkspace.TaskRow
              key={state}
              variant="compact"
              icon={<Clock size={16} />}
              title={title}
              summary={summary}
              state={state}
              stateLabel={label}
              onOpen={() => setSelected(state)}
              openLabel={`打开自动化 ${title}`}
              actions={
                <Button size="icon-sm" variant="ghost" aria-label="更多操作">
                  <MoreHorizontal />
                </Button>
              }
            />
          ))}
        </div>
      </div>
    </section>
  );
}
