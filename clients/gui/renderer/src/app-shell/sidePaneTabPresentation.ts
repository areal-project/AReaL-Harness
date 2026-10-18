import type { WorkspaceSidePaneTab } from "./sidePaneModel.js";
export type SidePaneTabPresentationLabels = Record<string, unknown>;
export const getLocalizedSidePaneTabTitle = (
  tab: WorkspaceSidePaneTab,
  _labels: SidePaneTabPresentationLabels,
) => tab.title;
export const getSidePaneTabSearchHint = (tab: WorkspaceSidePaneTab) => tab.workspaceKey;
export const getSidePaneTabTypeLabel = (
  tab: WorkspaceSidePaneTab,
  _labels: SidePaneTabPresentationLabels,
) => tab.title;
