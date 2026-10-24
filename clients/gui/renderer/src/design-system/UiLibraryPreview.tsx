import manifestText from "@areal/ui/components.json?raw";
import tokenText from "@areal/ui/tokens.json?raw";
import "./ui-library.css";

type ComponentEntry = { id: string; title: string; summary: string; status: string; entry: string; layer: string; source: string; document: string; api: string };
const manifest: { name: string; version: string; private: boolean; components: ComponentEntry[] } = JSON.parse(manifestText);
const tokens = JSON.parse(tokenText);
const url = (document: string) => `?docs=${encodeURIComponent(document)}`;

export function UiLibraryPreview({ dark, fontSize }: { dark: boolean; fontSize: string }) {
  return <section className="ui-library" aria-label="UI包设计系统">
    <div className="ui-library-heading"><h2>{manifest.name} <small>{manifest.version}</small></h2><p>本地 workspace 包 · {manifest.private ? "私有，未发布 npm" : "可发布"}</p>
      <p>保留现有视觉，先贯通基础值、组件、文档、Agent入口与守卫，再通过真实组合迭代。</p></div>
    <nav className="design-preview-navigation" aria-label="UI包入口"><a href={url("clients/gui/packages/ui/agent-guide.md")}>Agent 使用入口</a><a href="./components.json" target="_blank" rel="noreferrer">组件索引 JSON</a><a href="./llms.txt" target="_blank" rel="noreferrer">llms.txt</a><a href="?conversation-system">对话组合实例</a></nav>
    <section className="ui-library-section" aria-label="独立包消费"><h3>真实组件示例</h3><p>下方示例运行在独立文档中，基础外观由包内样式提供。</p>
      <iframe key={`${dark}-${fontSize}`} title="独立UI包示例" src={`./ui-library.html?theme=${dark ? "dark" : "light"}&font=${fontSize}`} />
    </section>
    <section className="ui-library-section" aria-label="包内组件目录"><h3>组件与合同</h3>{manifest.components.map(component => <article id={`component-${component.id}`} className="ui-library-component" key={component.id}>
      <div><h4>{component.title}</h4><span>{component.layer === "conversation" ? "对话组合" : component.layer === "settings" ? "设置组合" : component.layer === "worktree" ? "Worktree组合" : component.layer === "workbench" ? "工作台组合" : "基础控件"} · {component.status === "stable" ? "稳定入口" : "实验入口"} · {component.entry === "wip" ? "@areal/ui/wip" : "@areal/ui"}</span></div><p>{component.summary}</p><a href={url(component.document)}>阅读组件合同</a><small className="ui-library-source">{component.document}</small>
      <details><summary>查看 TypeScript 生成的 API</summary><pre>{component.api}</pre></details>
    </article>)}</section>
    <section className="ui-library-section" aria-label="设计源与产物"><h3>设计源与生成链</h3><table><thead><tr><th>来源</th><th>生成/实现</th><th>消费者与检查</th></tr></thead><tbody>
      <tr><td>tokens.json · {Object.keys(tokens.foundation).length} 个基础角色</td><td>foundation.css、Tailwind 映射、默认主题输入</td><td>包、GUI 与独立示例；生成漂移和默认正文对比度检查</td></tr>
      <tr><td>theme.ts · 原有纯调色板算法</td><td>默认明暗 themes.css；动态偏好复用同一函数</td><td>原外观设置与示例；默认/自定义主题一致性核对</td></tr>
      <tr><td>组件源码与就近合同</td><td>JavaScript、声明类型、components.json、llms.txt</td><td>现有文档站与 Agent；导出、状态与依赖方向检查</td></tr>
    </tbody></table><p>产品状态、保存、执行与资源生命周期继续归原renderer适配层。包内登记、有限 Base 准入与用户视觉认可分别维护。</p></section>
  </section>;
}
