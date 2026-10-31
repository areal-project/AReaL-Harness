export type ReviewScope =
  | NonNullable<
      Extract<import("./services.js").CommandParams<"workspace">, { operation: "review" }>["scope"]
    >
  | "last-turn"
  | "turn";
export type TurnReviewRequest =
  | { turnId: string; scope?: never }
  | { scope: "unstaged"; turnId?: never };
export type ReviewReading = {
  activePath: string | null;
  treeQuery: string;
  treeCollapsed: string[];
  fileExpansion: Map<string, boolean>;
  expandedAll: boolean;
  scrollTop: number;
};
export const views = new Map<
  string,
  {
    readings: Map<string, ReviewReading>;
    selectedTurnId?: string;
    request?: TurnReviewRequest;
    scope: ReviewScope;
    ref: string;
    activePath: string | null;
    fileExpansion: Map<string, boolean>;
    expandedAll: boolean;
    treeQuery: string;
    treeCollapsed: string[];
    scrollTop: number;
  }
>();
export type CommitChoice = { id: string; subject: string; committedAt: number };
export type BranchChoice = { ref: string; name: string; id: string };
export const commitAge = (timestamp: number) => {
  const seconds = (timestamp * 1000 - Date.now()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  const [unit, size] = units.find(([, size]) => Math.abs(seconds) >= size) ?? ["second", 1];
  return new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto", style: "short" }).format(
    Math.trunc(seconds / size),
    unit,
  );
};
