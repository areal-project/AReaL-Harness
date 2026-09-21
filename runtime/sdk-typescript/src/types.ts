export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Limits {
  wallTimeMs: number;
  outputBytes: number;
  maxProcesses: number;
}
export interface Owner {
  taskId: string;
  pluginInstanceId?: string | null;
}
export interface Permissions {
  readRoots?: string[] | null;
  writeRoots?: string[] | null;
  network?: "deny" | "inherit";
}
export interface CreateScope {
  operationId: string;
  parentScopeId: string;
  owner: Owner;
  permissions?: Permissions;
  limits?: Partial<Limits>;
}
export interface ScopeInfo {
  scopeId: string;
  parentScopeId: string | null;
  state: "active" | "revoking" | "closed";
  owner: Owner;
  readRoots: string[];
  writeRoots: string[];
  network: "deny" | "inherit";
  limits: Limits;
  activeProcesses: number;
  outputBytes: number;
  cleanupError: string | null;
}
export interface StartProcess {
  operationId: string;
  scopeId: string;
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  tty?: boolean;
  pipeStdin?: boolean;
  limits?: Partial<Pick<Limits, "wallTimeMs" | "outputBytes">>;
}
export interface ProcessRef {
  processId: string;
  scopeId: string;
}
export interface ProcessInfo extends ProcessRef {
  state: "starting" | "running" | "exited" | "unknown";
  exitCode: number | null;
  signal: string | null;
  sandboxDenied: boolean;
  stopReason: string | null;
  cleanupError: string | null;
}
export interface ProcessInput {
  operationId: string;
  processId: string;
  dataBase64: string;
}
export interface ResizeProcess {
  operationId: string;
  processId: string;
  cols: number;
  rows: number;
}
export interface CloseStdin {
  operationId: string;
  processId: string;
}
export interface ReadOutput {
  processId: string;
  after?: string | null;
  maxBytes: number;
  waitMs?: number;
}
export type OutputStream = "stdout" | "stderr" | "pty";
export interface OutputChunk {
  cursor: string;
  stream: OutputStream;
  dataBase64: string;
}
export interface OutputPage {
  chunks: OutputChunk[];
  nextCursor: string;
  gap: boolean;
  truncated: boolean;
  closed: boolean;
}
export interface OperationInfo {
  operationId: string;
  state: "accepted" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  result: Json | null;
  error: RuntimeErrorData | null;
}
export interface RuntimeErrorData {
  code:
    | "INVALID_REQUEST"
    | "INVALID_ARGUMENT"
    | "UNAUTHENTICATED"
    | "PERMISSION_DENIED"
    | "SCOPE_CLOSED"
    | "STALE_HANDLE"
    | "NOT_FOUND"
    | "CONFLICT"
    | "RESOURCE_EXHAUSTED"
    | "UNSUPPORTED"
    | "UNAVAILABLE"
    | "CLEANUP_FAILED";
  message: string;
  details?: Json;
}
export interface ConnectionInfo {
  protocolVersion: string;
  runtimeEpoch: string;
  connectionId: string;
  rootScopeId: string;
  capabilities: { methods: string[]; [key: string]: Json };
}
export type ExpectedFile = { kind: "absent" } | { kind: "sha256"; value: string };
export type FileCommand =
  | { kind: "read"; path: string; offset?: number; maxBytes: number }
  | { kind: "stat"; path: string }
  | { kind: "list"; path: string; after?: string | null; limit: number }
  | { kind: "write"; path: string; dataBase64: string; expected: ExpectedFile }
  | {
      kind: "applyPatch";
      path: string;
      oldText: string;
      newText: string;
      expectedSha256: string;
    };
export interface FileRequest<C extends FileCommand = FileCommand> {
  operationId: string;
  scopeId: string;
  command: C;
}
export interface FileRead {
  dataBase64: string;
  sha256: string;
  size: number;
  nextOffset: number;
  eof: boolean;
}
export interface FileWrite {
  sha256: string;
  size: number;
}
export type FileKind = "file" | "directory" | "symlink" | "other";
export interface FileList {
  entries: { name: string; kind: FileKind }[];
  nextCursor: string | null;
}
export type FileResult<C extends FileCommand> = C extends { kind: "read" }
  ? FileRead
  : C extends { kind: "list" }
    ? FileList
    : C extends { kind: "stat" }
      ? { kind: FileKind; size: number }
      : FileWrite;
