import { lazy, Suspense, type ComponentProps } from "react";
export type { McpAppMessage, McpAppModelContext, McpAppPlacement } from "./McpAppHost.js";
const Content = lazy(() =>
  import("./McpAppHost.js").then(({ McpAppHost }) => ({ default: McpAppHost })),
);
export function McpAppHost(props: ComponentProps<typeof import("./McpAppHost.js").McpAppHost>) {
  return (
    <Suspense fallback={null}>
      <Content {...props} />
    </Suspense>
  );
}
