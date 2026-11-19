import React, { lazy, Suspense } from "react";
import type { ComponentProps } from "react";
import type { BotsWorkspace as BotsWorkspaceComponent } from "./BotsWorkspace.js";

const LazyBots = lazy(async () => {
  const mod = await import("./BotsWorkspace.js");
  return { default: mod.BotsWorkspace };
});

export function LazyBotsWorkspace(props: ComponentProps<typeof BotsWorkspaceComponent>) {
  return (
    <Suspense fallback={null}>
      <LazyBots {...props} />
    </Suspense>
  );
}
