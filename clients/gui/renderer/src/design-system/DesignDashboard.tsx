import { useLayoutEffect, useState } from "react";
import { Button } from "../components/ui/button.js";
import { useAppearance } from "../settings/applicationPreferences.js";
import { baseCandidate } from "./catalog.js";
import "./design-dashboard.css";

type PhaseId = "architecture" | "base" | "independent" | "feedback";
type PhaseStatus = "established" | "completed" | "current" | "pending" | "later";
type Source = { readonly title: string; readonly path: string };
type Phase = {
  readonly id: PhaseId;
  readonly letter: string;
  readonly title: string;
  readonly status: PhaseStatus;
  readonly summary: string;
  readonly outcomes: readonly string[];
  readonly remaining: readonly string[];
  readonly sources: readonly Source[];
};

const statusLabels: Record<PhaseStatus, string> = {
  established: "已建立", completed: "本轮已完成", current: "当前阶段", pending: "待开始", later: "后续迭代",
};
const phases: readonly Phase[] = [
  {
    id: "architecture", letter: "A", title: "架构", status: "established",
    summary: "设计知识、生产实现和验证各有所有者。设计地图已经建立，视觉选择仍需在真实任务中评价。",
    outcomes: ["原则、基础、内容、交互与工作台说明已有统一入口。", "组件、Token 和执行权威沿用原有生产所有者。"],
    remaining: ["设计地图建立不等于所有设计已经批准。后续取舍继续回到对应主题维护。"],
    sources: [{ title: "设计地图", path: "design/README.md" }, { title: "设计系统架构", path: "design/architecture.md" }],
  },
  {
    id: "base", letter: "B", title: "Base 设计系统", status: "completed",
    summary: "五条真实 GUI 切片已验证，0.4.0 按 20 个成员、3 个模式的有限范围冻结。",
    outcomes: ["提交、过程、审批到结果复用生产组件与原执行控制器。", "外观修改立即生效；资源文件与 Diff 关闭后返回原任务，保留草稿、阅读和焦点。", "插件查找、详情、项目启停、失败与 UNKNOWN 原回执核对及返回已通过真实 GUI 验证。", "同窗口 Renderer 刷新、崩溃后重载保留已加载段落与草稿，原执行不重放；显式返回最新后保持跟随。"],
    remaining: ["冻结只限 Base 列明的 GUI 成员、变体与状态，不表示稳定公共 API。", "P-RESOURCES 仅限列明插件路径；完整插件生命周期、P-CONVERSATION、SidePane、列明同窗口 Renderer 恢复以外的生命周期与跨平台仍未完成。"],
    sources: [{ title: "Base 与兼容边界", path: "clients/gui/design-system/base.md" }, { title: "运行证据", path: "clients/gui/design-system/base-evidence.md" }, { title: "插件资源管理", path: "design/patterns/plugin-resources.md" }],
  },
  {
    id: "independent", letter: "C", title: "固定题目与模拟页面", status: "completed",
    summary: "0.2 冻结输入上的交付物核对独立题已完成；0.4 扩展后的同题检查属于迁移回归。",
    outcomes: ["题目与可访问语义先固定，实现者与评估材料分离。", "筛选、处理中换对象、失败、未知结果显式核对、刷新与键盘通过本地检查。"],
    remaining: ["0.4 迁移回归已通过，不作为新的盲试；单个独立任务不证明所有组件、主题或平台的泛化。", "本地模拟不连接 Core、文件系统或供应商。"],
    sources: [{ title: "固定题目", path: "design/components/reuse-exercise.md" }, { title: "独立复用结果", path: "design/components/reuse-result.md" }],
  },
  {
    id: "feedback", letter: "D", title: "归因并改进", status: "current",
    summary: "前两条切片已有首轮用户反馈；文件与 Diff、插件、阅读恢复切片仍待整体体验评价。",
    outcomes: ["评估器的定位、按钮内容假设和时钟问题归回评估器，消费者与冻结 Base 保持不变。", "文件与 Diff 返回保留场景已有自动化证据；插件扩展已有真实 GUI 证据，前四条切片也已回归。"],
    remaining: ["用户仍拥有整体产品与视觉结果的最终评价权。", "下一步以用户整体评价、真实缺口和异常恢复为方向，不为补齐目录扩大范围。"],
    sources: [{ title: "结果与归因", path: "design/components/reuse-result.md" }, { title: "建设计划", path: "design/roadmap.md" }],
  },
];
const slices = [
  { title: "完成一项任务", path: "提交 → 过程 → 审批 → 结果", result: "真实批准、拒绝与文件结果已核对。执行事实继续由 Core 与 Runtime 提供。", feedback: true, source: "design/products/workbench/README.md" },
  { title: "修改外观后继续工作", path: "外观设置 → 立即生效 → 返回原任务", result: "真实设置偏好已核对。返回时保留草稿与当前可用的阅读段落。", feedback: true, source: "design/patterns/settings.md" },
  { title: "查看资源后回到任务", path: "结果 → 文件 / Diff → 返回原任务", result: "真实文件回执、历史轮次 Diff、缺失文件恢复与返回焦点已核对。保留草稿和当前阅读。", feedback: false, source: "design/patterns/inspect-and-return.md" },
  { title: "查找并管理插件", path: "查找 / 筛选 → 详情 → 项目启停 → 失败 / UNKNOWN 原回执核对 → 原列表 → 原任务", result: "当前项目启停、明确失败、UNKNOWN 原回执核对和上下文返回已验证。完整安装、认证与连接生命周期另行验证。", feedback: false, source: "design/patterns/plugin-resources.md" },
  { title: "界面恢复后继续阅读", path: "阅读历史 / 保留草稿 → 刷新或崩溃后重载 → 继续阅读 → 返回最新", result: "同一主窗口恢复已加载段落和偏移，原执行继续输出且不拉到末尾；明确返回最新后继续跟随。未重复提交。", feedback: false, source: "design/patterns/feedback-and-recovery.md" },
] as const;

function documentUrl(path: string) {
  const [file, fragment] = path.split("#");
  return `?docs=${encodeURIComponent(file)}${fragment ? `#${encodeURIComponent(fragment)}` : ""}`;
}

export function DesignDashboard() {
  const [dark, setDark] = useState(false);
  const [phaseId, setPhaseId] = useState<PhaseId>("feedback");
  const phase = phases.find(item => item.id === phaseId)!;
  useAppearance(dark);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.classList.toggle("theme-areal-light", !dark);
    root.classList.toggle("theme-areal-dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
  }, [dark]);

  return <main className="design-dashboard">
    <div className="design-dashboard-layout">
      <header className="design-dashboard-header">
        <a className="design-dashboard-brand" href="?dashboard" aria-current="page">AReaL / 设计系统</a>
        <nav aria-label="设计预览导航">
          <a href={documentUrl("design/README.md")}>设计地图</a>
          <a href="?conversation-system">对话流设计</a>
          <a href="?ui-library">UI 包与架构</a>
          <a href={`${window.location.pathname}#controls`}>组件示例</a>
          <a href="?product-candidate">完整产品候选</a>
          <a href="?reuse-exercise">操作独立复用题</a>
        </nav>
        <Button variant="outline" size="sm" aria-pressed={dark} onClick={() => setDark(value => !value)}>深色主题</Button>
      </header>

      <div className="design-dashboard-heading">
        <div><p className="design-dashboard-eyebrow">目标 · 阶段 · 下一步</p><h1>设计系统建设看板</h1></div>
        <p className="design-dashboard-snapshot">手动整理的来源快照<br /><time dateTime="2026-10-23">2026 年 10 月 23 日</time><br />状态不随页面自动更新</p>
      </div>

      <section className="design-dashboard-overview" aria-label="目标与当前状态">
        <div className="design-dashboard-goal">
          <p className="design-dashboard-eyebrow">我们的终点</p>
          <h2>新增一个真实 GUI 任务，<br />仍能使用同一套设计选择。</h2>
          <p>原则、Token、组件与交互模式共同指导实现。每个选择都能找到来源、适用状态和验证证据，用户能连贯地完成工作。</p>
          <ul className="design-dashboard-acceptance">
            <li>提交、观察过程、处理决定、查看资源和返回工作形成完整体验。</li>
            <li>主题、字号、宽窄和键盘操作有对应证据，未覆盖的情况明确保留。</li>
            <li>新任务复用已有规则。需要修订时，回到同一个生产所有者。</li>
          </ul>
          <a href={documentUrl("design/roadmap.md#首轮完成条件")}>查看完整完成条件 →</a>
        </div>
        <aside className="design-dashboard-current" aria-labelledby="dashboard-current-title">
          <p className="design-dashboard-eyebrow">当前 · 五条切片已验证</p>
          <h2 id="dashboard-current-title">有限 Base beta</h2>
          <p className="design-dashboard-base">Base {baseCandidate.version}<span>{({ "frozen-beta": "有限范围已冻结", candidate: "候选未冻结" })[baseCandidate.status]}</span></p>
          <p>五条切片已有真实 GUI 自动化证据，0.2 冻结输入上的独立题结果保留。<strong>用户对前两条的首轮反馈未发现明显问题，与现有基准接近。</strong> 文件与 Diff、插件、阅读恢复仍待用户评价。</p>
          <div className="design-dashboard-next">
            <h3>下一步</h3>
            <p>评价五条切片的整体效果，单独记录文件与 Diff、插件和阅读恢复体验反馈。后续跟随用户评价、真实缺口与异常恢复需求。</p>
          </div>
          <a href={documentUrl("design/roadmap.md")}>查看建设计划 →</a>
        </aside>
      </section>

      <section className="design-dashboard-phases" aria-labelledby="dashboard-phases-title">
        <div className="design-dashboard-section-heading"><h2 id="dashboard-phases-title">建设阶段</h2><p>选择阶段，查看产物与进入下一步的条件。</p></div>
        <div className="design-dashboard-phase-layout">
          <div className="design-dashboard-phase-list" role="group" aria-label="选择建设阶段">
            {phases.map(item => <Button key={item.id} variant="ghost" className="design-dashboard-phase" aria-pressed={phaseId === item.id} aria-controls="dashboard-phase-detail" onClick={() => setPhaseId(item.id)}>
              <span className="design-dashboard-phase-letter">{item.letter}</span>
              <span className="design-dashboard-phase-name">{item.title}<span>{statusLabels[item.status]}</span></span>
              <span aria-hidden="true">→</span>
            </Button>)}
          </div>
          <section id="dashboard-phase-detail" className="design-dashboard-phase-detail" aria-labelledby="dashboard-phase-title">
            <p className="design-dashboard-eyebrow">阶段 {phase.letter} · {statusLabels[phase.status]}</p>
            <h3 id="dashboard-phase-title">{phase.title}</h3>
            <p>{phase.summary}</p>
            <div className="design-dashboard-phase-criteria">
              <div><h4>{phase.status === "current" || phase.status === "established" || phase.status === "completed" ? "已有基础" : "预期产物"}</h4><ul>{phase.outcomes.map(item => <li key={item}>{item}</li>)}</ul></div>
              <div><h4>{phase.status === "completed" ? "后续边界" : phase.status === "established" ? "仍需保持" : "尚需完成"}</h4><ul>{phase.remaining.map(item => <li key={item}>{item}</li>)}</ul></div>
            </div>
            <nav className="design-dashboard-source-links" aria-label={`${phase.title}来源`}>{phase.sources.map(source => <a key={source.path} href={documentUrl(source.path)}>{source.title} ↗</a>)}</nav>
          </section>
        </div>
      </section>

      <section className="design-dashboard-slices" aria-labelledby="dashboard-slices-title">
        <div className="design-dashboard-section-heading"><h2 id="dashboard-slices-title">当前五条任务切片</h2><p>实现、运行验证与人的评价分别记录。</p></div>
        {slices.map(slice => <article key={slice.title} className="design-dashboard-slice">
          <div><h3>{slice.title}</h3><p className="design-dashboard-slice-path">{slice.path}</p></div>
          <div><div className="design-dashboard-evidence"><span>已实现</span><span>自动化 GUI 已验证</span><span>{slice.feedback ? "用户首轮反馈已记录" : "等待用户体验评价"}</span></div><p>{slice.result}</p></div>
          <a href={documentUrl(slice.source)}>阅读来源 ↗</a>
        </article>)}
        <details className="design-dashboard-limits">
          <summary>验证范围与已知缺口</summary>
          <div className="design-dashboard-limits-content">
            <p>五条切片的路径证据来自隔离的 Electron、Core 与 Runtime，模型事件由本地确定性服务提供。完整插件安装、认证、连接、完整应用重启后的阅读位置、真实供应商、安装包和跨平台仍未完成。</p>
            <p>外观返回只验证同一进程中当前可用的阅读段落。第五条另行验证同窗口 Renderer 阅读恢复。尚未加载的历史、过程展开和完整应用退出后的阅读位置不在其范围内。</p>
            <p>插件长列表的非零滚动恢复、切换项目后的迟到结果注入尚无运行证据。</p>
            <p>0.2 独立题限一个冻结任务；0.3 / 0.4 同题复验用于检查扩展后的迁移兼容，不作为新盲试或完整组件验收。</p>
            <p>首轮用户反馈仅对应前两条切片；后三条仍待用户评价，不等于所有主题、字号与状态均获认可。组件目录和构建通过，不能代替用户路径、原生平台或安装包验收。</p>
            <p className="design-dashboard-technical">0.2 独立题的固定输入为 c98af14e；当前有限冻结与具体运行见 Base 证据和独立结果。Base 标识读取现有目录 {baseCandidate.id}。<a href={documentUrl("design/architecture.md#验证边界")}>查看验证边界</a></p>
          </div>
        </details>
      </section>

      <footer className="design-dashboard-footer">
        <p><strong>GUI 优先，Web 后续独立验证。</strong> Web 按实际接入复用适用的规则与组件，不阻塞本轮 GUI 完成。CLI 与 TUI 不在本设计系统建设范围内。</p>
        <a href={documentUrl("design/architecture.md")}>范围与所有者 ↗</a>
      </footer>
    </div>
  </main>;
}
