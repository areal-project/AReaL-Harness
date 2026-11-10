import type {
  ManagementRequest,
  ManagementRequestMap,
  ManagementResponseMap,
  ManagementResponse,
  PluginMutation,
  PluginStoreOperation,
} from "../services.js";
export type PluginDetail = ManagementResponseMap["plugin"];
export type PluginReadiness = ManagementResponseMap["pluginReadiness"];
export type PluginList = ManagementResponseMap["plugins"];
export type PluginCommand = <P extends ManagementRequest>(
  request: P,
) => Promise<ManagementResponse<P>>;
type WithoutSubmission<R> = R extends unknown ? Omit<R, "projectId" | "requestId"> : never;
/** 插件库登记写入（Host 完成）与项目里的插件操作（Core 完成）。 */
export type PluginWrite = PluginMutation | "pluginAuth" | Exclude<PluginStoreOperation, "mcp">;
export type PluginMutationRequest = WithoutSubmission<ManagementRequestMap[PluginWrite]>;
export type PluginMutate = (
  request: PluginMutationRequest,
) => Promise<ManagementResponseMap[PluginWrite] | undefined>;
export type PluginSubmission = { mutation: PluginMutation; requestId: string; projectId: string };
export type PluginOperation = Omit<PluginSubmission, "mutation"> & {
  mutation: PluginWrite;
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
