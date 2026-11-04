import { z } from "zod";
import {
  CallToolResultSchema,
  JSONRPCMessageSchema,
  ResourceSchema,
  ToolSchema,
} from "@modelcontextprotocol/core";
import { McpUiHostContextSchema } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { DesktopError } from "./services.js";
import type {
  McpAppCommand,
  McpAppEvent,
  McpAppOperations,
  McpFormOwner,
  McpFormResource,
  McpFormResourceCommand,
} from "./mcp-app-services.js";

const fields = z.record(z.string(), z.unknown());
const resultSource = z
  .object({ projectId: z.string(), threadId: z.string(), turnId: z.string(), itemId: z.string() })
  .passthrough();
const mcpApp = z
  .object({
    kind: z.literal("mcp"),
    token: z.string(),
    frameUrl: z.string(),
    instanceId: z.string(),
    serverId: z.string(),
    generation: z.union([z.string(), z.number()]),
    projectId: z.string(),
    threadId: z.string(),
    toolMetadata: ToolSchema.pick({ name: true, title: true, annotations: true, icons: true })
      .partial()
      .passthrough()
      .optional(),
    initialArguments: fields,
    initialResult: CallToolResultSchema.optional(),
    hostContext: McpUiHostContextSchema,
    resourceMeta: fields.optional(),
    fileResource: z.boolean().optional(),
    resultSource: resultSource.optional(),
  })
  .passthrough();
const genUi = z
  .object({
    kind: z.literal("genUi"),
    token: z.string(),
    frameUrl: z.string(),
    projectId: z.string(),
    threadId: z.string(),
    source: resultSource.extend({ referenceOffset: z.number().int().nonnegative() }),
    artifact: z
      .object({ artifactId: z.string(), path: z.string(), digest: z.string() })
      .passthrough(),
    title: z.string(),
    readOnly: z.boolean(),
    hostContext: McpUiHostContextSchema,
  })
  .passthrough();
const resultReply = z.discriminatedUnion("status", [
  z.object({ status: z.literal("open"), app: mcpApp }).passthrough(),
  z.object({ status: z.literal("closed") }).passthrough(),
  z.object({ status: z.literal("unavailable"), reason: z.string() }).passthrough(),
]);
const requestReply = z
  .object({
    result: fields.optional(),
    error: z.object({ message: z.string().optional() }).passthrough().optional(),
    notifications: z.array(JSONRPCMessageSchema).optional(),
  })
  .passthrough()
  .refine((value) => (value.result !== undefined) !== (value.error !== undefined));
const resourceReply = z.object({ resources: z.array(ResourceSchema.passthrough()) }).passthrough();
const event = z.object({ token: z.string(), notification: JSONRPCMessageSchema }).passthrough();
const readers: {
  [Operation in keyof McpAppOperations]: (
    value: unknown,
  ) => McpAppOperations[Operation]["response"];
} = {
  open: (value) => mcpApp.parse(value),
  openGenUi: (value) => genUi.parse(value),
  openFromResult: (value) => resultReply.parse(value),
  request: (value) => requestReply.parse(value),
  metadataImage: (value) => z.string().parse(value),
  genUiVisibility: (value) => value,
  close: (value) => value,
  pageToolsReady: (value) => value,
  pageToolsUnmount: (value) => value,
  pageToolResult: (value) => value,
};

export function createMcpAppCommand(raw: (request: unknown) => Promise<unknown>): McpAppCommand {
  return async (request) => {
    const value = await raw(request);
    try {
      return readers[request.operation](value);
    } catch {
      throw unavailableResponse(
        request.operation === "metadataImage",
        request.operation === "openFromResult" &&
          "requestId" in request &&
          typeof request.requestId === "string"
          ? request.requestId
          : undefined,
      );
    }
  };
}

export function createMcpFormResourceCommand(
  raw: (operation: unknown, request: unknown) => Promise<unknown>,
): McpFormResourceCommand {
  function command(
    operation: "pick",
    request: McpFormOwner,
  ): Promise<{ resources: McpFormResource[] }>;
  function command(operation: "release", request: McpFormOwner & { uri: string }): Promise<unknown>;
  async function command(operation: "pick" | "release", request: McpFormOwner): Promise<unknown> {
    const value = await raw(operation, request);
    if (operation === "release") return value;
    try {
      return resourceReply.parse(value);
    } catch {
      throw unavailableResponse(false);
    }
  }
  return command;
}

export function readMcpAppEvent(value: unknown): McpAppEvent {
  return event.parse(value);
}

function unavailableResponse(readOnly: boolean, requestId?: string) {
  const error: DesktopError = {
    message: readOnly
      ? "MCP response data is invalid"
      : "MCP operation result is unavailable; check the original operation before trying again",
    delivery: "resultUnavailable",
    recovery: { kind: readOnly ? "retryRead" : "needsUser" },
    ...(!readOnly ? { submissionUnknown: true } : {}),
    ...(requestId ? { requestId } : {}),
  };
  return Object.assign(new Error(error.message), error);
}
