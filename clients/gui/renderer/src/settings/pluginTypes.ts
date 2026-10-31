import type {
  ManagementRequest,
  ManagementRequestMap,
  ManagementResponseMap,
  ManagementResponse,
  PluginMutation,
} from "@areal/workbench/desktop-contract/management";
export type PluginDetail = ManagementResponseMap["plugin"];
export type PluginReadiness = ManagementResponseMap["pluginReadiness"];
export type PluginList = ManagementResponseMap["plugins"];
export type PluginCommand = <P extends ManagementRequest>(
  request: P,
) => Promise<ManagementResponse<P>>;
type WithoutSubmission<R> = R extends { projectId: string }
  ? Omit<R, "projectId" | "requestId">
  : never;
export type PluginMutationRequest = WithoutSubmission<
  ManagementRequestMap[PluginMutation | "pluginAuth"]
>;
export type PluginMutate = (
  request: PluginMutationRequest,
) => Promise<ManagementResponseMap[PluginMutation | "pluginAuth"] | undefined>;
export type PluginSubmission = { mutation: PluginMutation; requestId: string; projectId: string };
export type PluginOperation = Omit<PluginSubmission, "mutation"> & {
  mutation: PluginMutation | "pluginAuth";
  pluginId?: string;
};
export type PluginActivity = PluginOperation & { kind: "submit" | "check" };
export type PluginPreview = Pick<
  PluginDetail,
  | "id"
  | "revision"
  | "source"
  | "sourceDigest"
  | "admissionDigest"
  | "resolvedCommit"
  | "packageVersion"
  | "version"
  | "integrity"
>;
export type PluginReceipt = ManagementResponseMap["pluginSubmission"];
