import { useReadOnly, useLibraryReadOnly } from "./PlatformReadContext.js";
import { memo, type ComponentProps } from "react";
import { MemoTaskItem as View } from "@areal/ui/compositions";
import { useI18n } from "./i18n/IntlProvider.js";
import { useReducedMotion } from "./settings/applicationPreferences.js";
import { SidebarDragSurface, type SidebarSurfaceDragProps } from "./sidebarDrag.js";
export const MemoTaskItem = memo(function TaskListItem({
  dragProps,
  ...props
}: Omit<
  ComponentProps<typeof View>,
  | "renderSurface"
  | "reducedMotion"
  | "worktreeLabel"
  | "worktreeTitle"
  | "cloudLabel"
  | "cloudTitle"
> & { dragProps?: SidebarSurfaceDragProps }) {
  const { t } = useI18n();
  const readOnly = useReadOnly();
  const libraryReadOnly = useLibraryReadOnly();
  const reducedMotion = useReducedMotion();
  const worktree = props.worktree;
  const cloud = props.cloud;
  const name = worktree ? t("worktree.threadWorkspace", { branch: worktree.branch }) : undefined;
  const state = worktree?.state;
  const label = name
    ? name +
      (state
        ? " · " +
          t(
            state === "ready"
              ? "worktree.ready"
              : state === "failed"
                ? "worktree.failed"
                : state === "unknown"
                  ? "worktree.unknown"
                  : state === "cancelled"
                    ? "worktree.cancelled"
                    : state === "cancelling"
                      ? "worktree.cancelling"
                      : "worktree.creating",
          )
        : "")
    : undefined;
  return (
    <View
      {...props}
      readOnly={libraryReadOnly || props.readOnly}
      onArchive={readOnly ? undefined : props.onArchive}
      reducedMotion={reducedMotion}
      worktreeTitle={worktree ? name + " · " + worktree.directory : undefined}
      worktreeLabel={label}
      cloudTitle={cloud ? t("resources.cloud") : undefined}
      cloudLabel={cloud ? t("resources.cloud") : undefined}
      renderSurface={(element) => (
        <SidebarDragSurface
          as="li"
          {...dragProps}
          dragId={props.instanceId ?? dragProps?.dragId}
          {...element}
        />
      )}
    />
  );
});
