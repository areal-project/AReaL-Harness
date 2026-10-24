import { useLayoutEffect, useRef, useState } from "react";
import { MessageResponse } from "../components/ai-elements/message.js";
import { Feedback } from "../components/ui/feedback.js";
import { useAppearance } from "../settings/applicationPreferences.js";
import manifestText from "@areal/ui/components.json?raw";

type ComponentDoc = { id: string; title: string; summary: string; document: string; status: string; layer: string; category: string; aliases: string[]; related: string[]; exports: string[]; api: string };
const componentDocs: ComponentDoc[] = JSON.parse(manifestText).components;

type Destination =
  | { kind: "document"; path: string; fragment: string }
  | { kind: "example"; search: string; fragment: string }
  | { kind: "source" | "missing"; path: string }
  | { kind: "external"; url: string };

const rootDocuments = import.meta.glob<string>("../../../../../design/**/*.md", { eager: true, query: "?raw", import: "default" });
const guiDocuments = import.meta.glob<string>(["../../../design-system/**/*.md", "!../../../design-system/**/*.en.md", "!../../../design-system/templates/**"], { eager: true, query: "?raw", import: "default" });
const contracts = import.meta.glob<string>("../**/*.md", { eager: true, query: "?raw", import: "default" });
const uiDocuments = import.meta.glob<string>(["../../../packages/ui/src/**/*.md", "../../../packages/ui/agent-guide.md", "../../../packages/ui/README*.md"], { eager: true, query: "?raw", import: "default" });
const repositoryBase = "https://design.invalid/";
const modulePath = "clients/gui/renderer/src/design-system/";
const documents = new Map(Object.entries({ ...rootDocuments, ...guiDocuments, ...contracts, ...uiDocuments }).map(([path, markdown]) => [new URL(path, repositoryBase + modulePath).pathname.slice(1), markdown.replace(/^---\n[\s\S]*?\n---\n/, "")]));

function resolveDestination(from: string, href: string): Destination {
  const url = new URL(href, repositoryBase + from);
  if (url.origin !== new URL(repositoryBase).origin) return { kind: "external", url: url.href };
  const path = decodeURIComponent(url.pathname.slice(1));
  if (path === "clients/gui/renderer/design-system.html") return { kind: "example", search: url.search, fragment: url.hash };
  if (documents.has(path)) return { kind: "document", path, fragment: url.hash };
  return { kind: path.endsWith(".md") ? "missing" : "source", path: path + url.hash };
}

function documentUrl(path: string, fragment = "") {
  return `${window.location.pathname}?docs=${encodeURIComponent(path)}${fragment}`;
}

export function DesignDocument({ path }: { path: string }) {
  const [dark, setDark] = useState(false);
  const [notice, setNotice] = useState("");
  const article = useRef<HTMLElement>(null);
  const markdown = documents.get(path);
  const component = componentDocs.find(component => component.document === path);
  useAppearance(dark);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.classList.toggle("theme-areal-light", !dark);
    root.classList.toggle("theme-areal-dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
  }, [dark]);
  useLayoutEffect(() => {
    if (!article.current) return;
    const container = article.current;
    let pendingFragment = true;
    const assignHeadings = () => {
      const counts = new Map<string, number>();
      for (const heading of container.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")) {
        const slug = (heading.textContent ?? "").toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "").replace(/\s/g, "-");
        const count = counts.get(slug) ?? 0;
        heading.id = count ? `${slug}-${count}` : slug;
        heading.tabIndex = -1;
        counts.set(slug, count + 1);
      }
      if (pendingFragment && window.location.hash) {
        let fragment = window.location.hash.slice(1);
        try { fragment = decodeURIComponent(fragment); } catch {}
        const target = document.getElementById(fragment);
        if (target && container.contains(target)) {
          target.scrollIntoView();
          target.focus({ preventScroll: true });
          pendingFragment = false;
        }
      }
    };
    assignHeadings();
    const observer = new MutationObserver(assignHeadings);
    observer.observe(container, { childList: true, subtree: true });
    const followFragment = () => { pendingFragment = true; assignHeadings(); };
    window.addEventListener("hashchange", followFragment);
    return () => { observer.disconnect(); window.removeEventListener("hashchange", followFragment); };
  }, [markdown]);
  const example = (search = "", fragment = "#controls") => {
    const query = new URLSearchParams(search);
    query.delete("docs");
    query.set("returnTo", `${window.location.search}${window.location.hash}`);
    return `${window.location.pathname}?${query}${fragment}`;
  };
  const openLink = (href: string) => {
    let destination: Destination;
    try { destination = resolveDestination(path, href); }
    catch { setNotice(`无法解析此链接。原路径 ${href}`); return; }
    switch (destination.kind) {
      case "document":
        if (destination.path === path) window.location.hash = destination.fragment;
        else window.location.assign(documentUrl(destination.path, destination.fragment));
        break;
      case "example": window.location.assign(example(destination.search, destination.fragment)); break;
      case "external":
        if (/^https?:\/\//i.test(destination.url)) window.open(destination.url, "_blank", "noopener,noreferrer");
        else setNotice(`此链接不支持在预览中打开。原路径 ${href}`);
        break;
      case "source": setNotice(`此文件未收录在设计预览中。请在当前仓库查看原路径 ${destination.path}`); break;
      case "missing": setNotice(`未收录此设计文档。原路径 ${destination.path}`); break;
    }
  };
  return <main className="design-document">
    <header className="design-document-header">
      <nav aria-label="设计预览导航"><a href="?dashboard">建设看板</a><a href={documentUrl("design/README.md")}>设计地图</a><a href={example()}>组件示例</a></nav>
      <label>主题<select aria-label="主题" value={dark ? "dark" : "light"} onChange={event => setDark(event.target.value === "dark")}><option value="light">明亮</option><option value="dark">深色</option></select></label>
    </header>
    <p className="design-document-path">{path}</p>
    <Feedback message={notice} />
    <article ref={article} aria-label="设计文档正文">
      {component && <section className="design-component-meta" aria-label="组件元数据">
        <table><tbody>{[["title", component.title], ["summary", component.summary], ["status", component.status], ["layer", component.layer], ["category", component.category], ["aliases", component.aliases.join("、") || "—"], ["exports", component.exports.join("、")]].map(([key, value]) => <tr key={key}><th scope="row">{key}</th><td>{value}</td></tr>)}
          <tr><th scope="row">related</th><td>{component.related.map(id => { const related = componentDocs.find(item => item.id === id)!; return <a key={id} href={documentUrl(related.document)}>{related.title}</a>; })}</td></tr></tbody></table>
        <nav aria-label="组件文档入口"><a href={`./docs/ui/${component.id}.md`} target="_blank" rel="noreferrer">查看 Markdown 原文</a><a href={`?ui-library#component-${component.id}`}>返回组件目录</a><a href="#可操作示例">查看可操作示例</a></nav>
      </section>}
      {markdown ? <MessageResponse className="conversation-markdown" theme={dark ? "dark" : "light"} fileLinks fileLinkBase={repositoryBase + path} onOpenFileLink={openLink} onOpenExternalUrl={openLink}>{markdown}</MessageResponse>
        : <Feedback error={`未收录此设计文档。原路径 ${path}`} />}
      {component && <section className="design-component-example" aria-label="组件可操作示例"><h2>可操作示例</h2>
        <iframe key={`${component.id}-${dark}`} title={`${component.title} 独立示例`} src={`./ui-library.html?theme=${dark ? "dark" : "light"}&component=${component.id}`} />
        <details><summary>TypeScript 生成的 API</summary><pre>{component.api}</pre></details>
      </section>}
    </article>
  </main>;
}
