import { memo, type ComponentProps } from "react";
import { MemoTaskItem as View } from "@areal/ui/wip";
import { useI18n } from "./i18n/IntlProvider.js";
import { useReducedMotion } from "./settings/applicationPreferences.js";
import { SidebarDragSurface, type SidebarSurfaceDragProps } from "./sidebarDrag.js";
export const MemoTaskItem = memo(function TaskListItem({ dragProps, ...props }: Omit<ComponentProps<typeof View>, "renderSurface" | "reducedMotion" | "worktreeLabel" | "worktreeTitle"> & { dragProps?: SidebarSurfaceDragProps }) {
 const { t } = useI18n(); const reducedMotion = useReducedMotion(); const worktree = props.worktree;
 const name = worktree ? t("worktree.threadWorkspace", { branch: worktree.branch }) : undefined;
 const state = worktree?.state; const label = name ? name + (state ? " · " + t(state === "ready" ? "worktree.ready" : state === "failed" ? "worktree.failed" : state === "unknown" ? "worktree.unknown" : state === "cancelled" ? "worktree.cancelled" : state === "cancelling" ? "worktree.cancelling" : "worktree.creating") : "") : undefined;
 return <View {...props} reducedMotion={reducedMotion} worktreeTitle={worktree ? name + " · " + worktree.directory : undefined} worktreeLabel={label} renderSurface={element => <SidebarDragSurface as="li" {...dragProps} dragId={props.instanceId ?? dragProps?.dragId} {...element} />} />;
});
