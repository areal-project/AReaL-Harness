import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult, JSONRPCMessage } from "@modelcontextprotocol/client";

export type McpAppDescriptor = {
    kind: "mcp";
    token: string;
    frameUrl: string;
    instanceId: string;
    serverId: string;
    generation: string | number;
    projectId: string;
    threadId: string;
    toolMetadata?: {
        name?: string;
        title?: string;
        annotations?: { title?: string };
        icons?: { src: string }[];
    };
    initialArguments: Record<string, unknown>;
    initialResult?: CallToolResult;
    hostContext: McpUiHostContext;
    resourceMeta?: Record<string, unknown>;
    fileResource?: boolean;
    resultSource?: McpResultSource;
};
export type GenUiSource = { projectId: string; threadId: string; turnId: string; itemId: string; referenceOffset: number };
export type GenUiDescriptor = {
    kind: "genUi"; token: string; frameUrl: string; projectId: string; threadId: string;
    source: GenUiSource; artifact: { artifactId: string; path: string; digest: string };
    title: string; readOnly: boolean; hostContext: McpUiHostContext;
};
export type HostedPageDescriptor = McpAppDescriptor | GenUiDescriptor;
export const genUiSourceKey = (source: GenUiSource) => JSON.stringify([source.projectId, source.threadId, source.turnId, source.itemId, source.referenceOffset]);
export type McpResultSource = { projectId: string; threadId: string; turnId: string; itemId: string };
export const mcpResultKey = (source: McpResultSource) => JSON.stringify([source.projectId, source.threadId, source.turnId, source.itemId]);
export type McpResultReply = { status: "open"; app: McpAppDescriptor } | { status: "closed" } | { status: "unavailable"; reason: string };

export type McpResultState = { opening?: boolean; message?: string };
export type McpAppEvent = { token: string; notification: JSONRPCMessage };
export type McpAppDeepLink = { id: number; pluginId: string; marketplace?: string; toolName: string; path: string };
export type McpMetadataImageLoader = (source: string) => Promise<string>;
type McpAppOperations = {
    openGenUi: { request: GenUiSource; response: GenUiDescriptor };
    genUiVisibility: { request: { token: string; visible: boolean }; response: unknown };
    metadataImage: { request: { source: string }; response: string };
    open: {
        request: { projectId: string; threadId: string; serverId: string; expectedGeneration: string | number;
            toolName: string; arguments?: Record<string, unknown>; deepLink?: string; filePath?: string };
        response: McpAppDescriptor;
    };
    openFromResult: { request: McpResultSource & { requestId: string }; response: McpResultReply };
    request: {
        request: { token: string; request: { jsonrpc: "2.0"; id: string | number; method: string; params?: unknown } };
        response: { result?: Record<string, unknown>; error?: { message?: string }; notifications?: JSONRPCMessage[] };
    };
    close: { request: { token?: string }; response: unknown };
    pageToolsReady: { request: { token: string; mountId: string; declaration: unknown }; response: unknown };
    pageToolsUnmount: { request: { token: string; mountId: string }; response: unknown };
    pageToolResult: { request: { token: string; mountId: string; callId: string; reply: Record<string, unknown> }; response: unknown };
};
export type McpAppCommand = <Operation extends keyof McpAppOperations>(
    request: { operation: Operation } & McpAppOperations[Operation]["request"],
) => Promise<McpAppOperations[Operation]["response"]>;
export type McpFormResource = {
    uri: string; name: string; title?: string; description?: string; mimeType?: string; size?: number;
    icons?: { src: string; mimeType?: string; sizes?: string[]; theme?: "light" | "dark" }[];
    _meta?: Record<string, unknown>;
    [key: string]: unknown;
};
type McpFormOwner = { projectId: string; threadId: string; requestId: string; fieldName: string };
export type McpFormResourceCommand = {
    (operation: "pick", request: McpFormOwner): Promise<{ resources: McpFormResource[] }>;
    (operation: "release", request: McpFormOwner & { uri: string }): Promise<unknown>;
};
