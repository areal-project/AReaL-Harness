import type { SVGProps } from "react";
import sprite from "./assets/file-tree-builtins.svg?raw";

// 复用已保留来源的 Codex 文件树 MCP 矢量，静态资产不含工作区内容。
const mcp = sprite.match(/<symbol id="file-tree-builtin-mcp"[^>]*>([\s\S]*?)<\/symbol>/)![1];
export function ComposerMcpIcon(props: SVGProps<SVGSVGElement>) {
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            aria-hidden="true"
            {...props}
            dangerouslySetInnerHTML={{ __html: mcp }}
        />
    );
}
