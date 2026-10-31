import { z } from "zod";
import { desktopError } from "@areal/workbench/desktop-contract/transport";
import type { DesktopResult } from "@areal/workbench/desktop-contract";
import type { FileOpenTargets, Snapshot, UpdateState, WorkspaceImage } from "./services.js";

const fields = z.record(z.string(), z.unknown());
const target = z.object({
  projectId: z.string(),
  phase: z.string(),
  message: z.string().optional(),
});
const operation = z.object({
  requestId: z.string(),
  kind: z.string(),
  phase: z.string(),
  message: z.string().optional(),
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  desktopExit: z.string().optional(),
  targets: z.array(target),
});
// Historical feature projections remain opaque records; this decoder proves only
// the shared renderer envelope. ProjectionReader owns history-tree integrity.
const snapshotSchema: z.ZodType<Snapshot> = z.object({
  projects: z.array(fields),
  desktopCapabilities: z.object({ currentCommands: z.boolean() }).optional(),
  power: z
    .object({ enabled: z.boolean(), active: z.boolean(), error: z.string().nullable() })
    .nullable()
    .optional(),
  menuBar: z
    .object({ supported: z.boolean(), active: z.boolean(), error: z.string().nullable() })
    .nullable()
    .optional(),
  projectless: z.object({ directory: z.string() }).optional(),
  revision: z.number().optional(),
  connection: z
    .object({
      state: z.enum(["connecting", "ready", "unavailable"]),
      message: z.string().optional(),
      recovery: z.literal("check").optional(),
      prerequisite: z
        .object({
          kind: z.literal("macos-command-line-tools"),
          reason: z.enum(["developer-tools-unavailable", "python-unavailable"]),
          title: z.string(),
          detail: z.string(),
          installLabel: z.string(),
          retryLabel: z.string(),
          requestedMessage: z.string(),
        })
        .optional(),
    })
    .optional(),
  serviceSummary: z
    .object({ state: z.enum(["running", "stopped", "unknown"]), busy: z.boolean() })
    .optional(),
  backendUpdate: z
    .object({ state: z.enum(["applying", "pending", "failed"]), message: z.string().optional() })
    .optional(),
  lifecycle: z
    .object({
      supported: z.boolean(),
      operations: z.array(operation),
      phase: z.string().optional(),
      message: z.string().optional(),
      error: z.string().optional(),
      requestId: z.string().optional(),
      kind: z.string().optional(),
      desktopExit: z.string().optional(),
      targets: z.array(target).optional(),
      recovery: z
        .object({
          canRecover: z.boolean(),
          message: z.string(),
          projects: z.array(
            z.object({
              projectId: z.string(),
              root: z.string(),
              state: z.string(),
              message: z.string(),
            }),
          ),
        })
        .optional(),
    })
    .optional(),
  library: fields.optional(),
  computerControl: fields.nullable().optional(),
});
function isSnapshot(value: unknown): value is Snapshot {
  return snapshotSchema.safeParse(value).success;
}
export function readSnapshot(value: unknown): Snapshot {
  if (!isSnapshot(value)) throw new Error("Invalid Desktop snapshot envelope");
  return value;
}
export function readFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Desktop object response");
  return fields.parse(value);
}
export function readCommandResult(value: unknown): DesktopResult<unknown> {
  const result = readFields(value);
  if (result.ok === true && Object.hasOwn(result, "value"))
    return { ok: true, value: result.value };
  if (result.ok === false) {
    const error = readFields(result.error);
    if (typeof error.message === "string") return { ok: false, error: desktopError(error) };
  }
  throw new Error("Invalid Desktop command envelope");
}
const updateSchema: z.ZodType<UpdateState> = z
  .object({
    enabled: z.boolean(),
    status: z.enum([
      "idle",
      "available",
      "downloading",
      "validating",
      "deferred",
      "installing",
      "error",
    ]),
    version: z.string().optional(),
    downloaded: z.string().optional(),
    installing: z.boolean().optional(),
    percent: z.number().nullable().optional(),
    detail: z.string().optional(),
  })
  .passthrough();
export const readUpdateState = (value: unknown) => updateSchema.parse(value);
export const readTheme = (value: unknown) =>
  z
    .object({ platform: z.string().optional(), id: z.string(), dark: z.boolean() })
    .passthrough()
    .parse(value);
export const readInstallation = (value: unknown) =>
  z.object({ started: z.boolean(), message: z.string().optional() }).parse(value);
export const readProject = (value: unknown) => z.string().nullable().parse(value);
export const readTaskDirectory = (value: unknown) =>
  z.object({ cwd: z.string() }).nullable().parse(value);
export const readProjectlessDirectory = (value: unknown) =>
  z.object({ directory: z.string() }).nullable().parse(value);
export const readProjectionMessage = (value: unknown) =>
  z
    .object({ requestId: z.number().optional(), frame: z.unknown() })
    .refine((value) => Object.hasOwn(value, "frame"))
    .parse(value);
export function readFileOpenResult(
  value: unknown,
): FileOpenTargets | { saved: boolean } | WorkspaceImage | Record<string, never> {
  return z
    .union([
      z.object({
        mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
        bytes: z.instanceof(Uint8Array),
      }),
      z.object({
        targets: z.array(z.object({ id: z.string(), label: z.string() })),
        preferred: z.string(),
        preferredLabel: z.string(),
      }),
      z.object({ saved: z.boolean() }),
      z.record(z.string(), z.never()),
    ])
    .parse(value);
}
