export interface WorkspaceSidePaneTab {
  id: string;
  title: string;
  openedAt: number;
  ownerTaskId: string | null;
  workspaceKey: string;
}
export interface RecentClosedSidePaneTab {
  tab: WorkspaceSidePaneTab;
  closedAt: number;
}
