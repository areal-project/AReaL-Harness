import { useState } from "react";
import { ScheduledWorkspace } from "@areal/ui/wip";
import { Button } from "@areal/ui";
import { CalendarClock, BookOpen } from "lucide-react";
export function ScheduledWorkspaceExample() {
  const [empty, setEmpty] = useState(false), [selected, setSelected] = useState("");
  return <section aria-label="定时工作区样例"><Button onClick={() => setEmpty(value => !value)}>{empty ? "显示示例任务" : "显示空态"}</Button><ScheduledWorkspace><aside style={{width:"13rem", flexShrink:0}}>{empty ? <p>尚无定时任务</p> : <><ScheduledWorkspace.Group label="已开启"><ScheduledWorkspace.Item title="每日进展" description="明天 09:00" aria-pressed={selected === "daily"} onClick={() => setSelected("daily")} /></ScheduledWorkspace.Group><ScheduledWorkspace.Group label="已暂停"><ScheduledWorkspace.Item title="每周回顾" description="已暂停" aria-pressed={selected === "weekly"} onClick={() => setSelected("weekly")} /></ScheduledWorkspace.Group></>}</aside><ScheduledWorkspace.Welcome icon={<CalendarClock size={32}/>} title={selected ? "已选择示例任务" : "安排任务"} description={selected ? "本页仅切换示例，不执行真实任务。" : "按计划处理持续性任务。"}><ScheduledWorkspace.Template icon={<BookOpen size={18}/>} title="每周知识回顾" description="整理本周记录、结论和下一步。" onClick={() => setSelected("template")} /></ScheduledWorkspace.Welcome></ScheduledWorkspace></section>;
}
