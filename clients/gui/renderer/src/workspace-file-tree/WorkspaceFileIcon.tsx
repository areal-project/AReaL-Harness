// Original public Codex 26.930 file-tree sprite, visible CDP 2026-10-06.
// File classification reuses the existing GUI owner; unobserved types use
// Codex's original generic document, rather than a substitute icon library.
import sprite from "../assets/file-tree-builtins.svg?raw";
import { resolveIconName, getIconPalette } from "../lib/fileDisplayHelpers.js";

const tokens = new Set([...sprite.matchAll(/id="file-tree-builtin-([^" ]+)"/g)].map(match => match[1]));
const aliases: Record<string, string> = { document: "text", readme: "markdown", react_ts: "react", tsconfig: "typescript", yaml: "yml", console: "bash" };

export function WorkspaceFileIconDefinitions() {
  // Static checked-in SVG only. No workspace content enters this markup.
  return <svg aria-hidden="true" width="0" height="0" style={{ position: "absolute" }} dangerouslySetInnerHTML={{ __html: sprite.replace(/^<svg[^>]*>|<\/svg>\s*$/g, "") }} />;
}

export function WorkspaceFileIcon({ path }: { path: string }) {
  const kind = resolveIconName(path);
  const token = aliases[kind] ?? kind;
  const name = tokens.has(token) ? token : "default";
  const color = name === "default" || name === "text" ? "var(--color-foreground-subtle)" : name === "markdown" ? "light-dark(#199f43, #5ecc71)" : getIconPalette(kind).accent;
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" className="shrink-0" style={{ color }}><use href={`#file-tree-builtin-${name}`} /></svg>;
}

export function WorkspaceDirectoryChevron({ expanded }: { expanded?: boolean }) {
  return <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" className={expanded ? "" : "-rotate-90"}><use href="#chevron-down-md-light-12" /></svg>;
}
