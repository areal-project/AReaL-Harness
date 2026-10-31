import type { BrowserToolInput, BrowserAction, WaitCondition } from "../preview/tool-contract.cjs";
import type {
  BrowserCommand,
  ControlledView,
  BrowserCommandResult,
  BrowserTabSummary,
  BrowserDialog,
  BrowserRecordingJob,
  BrowserRecordingArtifact,
} from "@areal/browser-automation";
import type { BrowserWindow, WebContentsView, WebContents, Session, DownloadItem } from "electron";
type WorkspaceNetworkPolicy = InstanceType<
  typeof import("../browser-network.cjs").WorkspaceNetworkPolicy
>;

export type { BrowserCommand, ControlledView, BrowserWindow, WebContentsView, WebContents };
export type KeysOfUnion<T> = T extends T ? keyof T : never;
export type CompleteUnion<T, Keys extends PropertyKey = KeysOfUnion<T>> = T extends T
  ? T & Partial<Record<Exclude<Keys, keyof T>, never>>
  : never;
export type Action = CompleteUnion<BrowserAction>;
export type Condition = CompleteUnion<WaitCondition>;
type ToolParameterKeys = KeysOfUnion<BrowserToolInput["parameters"]>;
export type ToolInput = BrowserToolInput extends infer T
  ? T extends { operation: string; parameters: object }
    ? Omit<T, "parameters"> & { parameters: CompleteUnion<T["parameters"], ToolParameterKeys> }
    : never
  : never;
export interface HostIdentity {
  coreInstanceId: string;
  coreGeneration: string;
  projectId: string;
  threadId: string;
  turnId: string;
  callId: string;
  requestId: string | number;
  pageId: string;
  browserHostId: string;
  hostGeneration: number;
  pageGeneration: number;
  controlEpoch: number;
  phase: "prepare" | "execute";
  workspacePath?: string;
  browserApproval?: { plan?: unknown };
  batchDeadline?: number;
  batchGuard?: () => boolean;
}
export type HostRequest = HostIdentity & ToolInput;
export type DiagnosticsRequest = HostIdentity & Extract<ToolInput, { operation: "diagnostics" }>;
export type ReadRequest = HostIdentity &
  Extract<ToolInput, { operation: "observe" | "capture" | "diagnostics" }>;
export type ActionRequest = HostIdentity &
  (
    | {
        operation: "act";
        parameters: {
          pageId: string;
          snapshotId: string;
          action: Action;
          condition?: never;
          timeoutMs?: never;
        };
      }
    | {
        operation: "wait";
        parameters: {
          pageId: string;
          timeoutMs: number;
          condition?: Condition;
          action?: never;
          snapshotId?: never;
        };
      }
  );
export type NavigationRequest = HostIdentity &
  Extract<ToolInput, { operation: "navigate" | "newPage" }>;
export type CommandRequest = HostIdentity & Extract<ToolInput, { operation: "command" }>;
export type BatchRequest = HostIdentity & Extract<ToolInput, { operation: "runBatch" }>;
export type DiscoveryRequest = Pick<
  HostIdentity,
  | "coreInstanceId"
  | "coreGeneration"
  | "projectId"
  | "threadId"
  | "turnId"
  | "callId"
  | "requestId"
  | "phase"
  | "browserApproval"
> & { operation: "describe" };
export type Control = "human" | "agent" | "transferring";
export type Revocation = { projectId: string; threadId: string; pageId: string };
export type Ownership = (projectId: string, threadId: string) => boolean;
export type CoreIdentity = (projectId: string, threadId: string) => string | null;
export type Bounds = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };
export type Viewport = {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  deviceScaleFactor: number;
};
export type ViewportFacts = Viewport & {
  displayScale?: number;
  pageZoom: number;
  guiZoom: number;
  nativeBounds: Bounds;
  key: string;
};
export type PromiseBound = <T>(promise: Promise<T>) => Promise<T>;
export type NativeOption = {
  identity: number;
  value: string;
  label: string;
  disabled: boolean;
  selected: boolean;
};
export type NativeControl = { identity: number } & (
  | { kind: "redacted"; enabled?: never; type?: never; checked?: never }
  | { kind: "input"; enabled: boolean; type: string; checked?: never }
  | { kind: "textarea" | "button"; enabled: boolean; type?: never; checked?: never }
  | { kind: "checkbox"; enabled: boolean; checked: boolean; type?: never }
  | {
      kind: "select";
      enabled: boolean;
      multiple: boolean;
      selectedIndex: number;
      optionsComplete: boolean;
      options: NativeOption[];
      type?: never;
      checked?: never;
    }
);
export type NativeTarget = {
  identity: string;
  backendNodeId: number;
  role: string;
  name: string;
  x: number;
  y: number;
};
export type NativeRef = { identity: string; backendNodeId: number; frameId: string };
export type PublicSemantics =
  | { kind: "edit_field" | "field_key" | "focus_field" }
  | {
      kind: "public_search";
      method: "GET";
      query: string;
      queryName: string;
      encodedQuery: string;
      submittedFields: string[][];
      targetOrigin: string;
      targetPath: string;
    }
  | {
      kind: "link_navigation";
      method: "GET";
      targetOrigin: string;
      targetPath: string;
      targetUrl: string;
    };
export type NavigationIntent = Extract<
  PublicSemantics,
  { kind: "public_search" | "link_navigation" }
> & { controlEpoch: number; pageGeneration?: number; expiresAt?: number };
export type CancelableRead = {
  requestId?: string | number;
  cancel: (reason?: string) => void;
  cancelled?: boolean;
  documentGeneration?: number;
};
export type ActionLease = {
  requestId: string | number;
  syntheticInput?: boolean;
  dispatched: boolean;
  cancelled: boolean;
  cancel: () => void;
  turnId?: string;
  controller?: AbortController;
  command?: boolean;
  controlEpoch?: number;
  navigationDocument?: number;
};
export type HumanGesture = {
  page: Page;
  generation: number;
  document: number;
  button: "left" | "middle" | "right" | undefined;
  delivered?: boolean;
  cancelled?: boolean;
};
export type Capture = { width: number; height: number } & {
  observationId: string;
  pageGeneration: number;
  documentEpoch: number;
  controlEpoch: number;
  viewportRevision: number;
  viewportKey: string;
  bitmapWidth: number;
  bitmapHeight: number;
  bitmapScale: Point;
  url: string;
};
export type AnnotationCapture = {
  documentEpoch: number;
  controlEpoch: number;
  pageGeneration: number;
  guardToken: string | null;
  guardSequence: number;
  nativeWebContentsId: number;
  sourceUrl: string;
  viewport: Viewport;
  zoom: number;
  guiZoom: number;
  nativeBounds: Bounds;
  viewportKey: string;
  viewportRevision: number;
  bitmapWidth: number;
  bitmapHeight: number;
  bitmapScale: Point;
};
export type AnnotationEvidence = {
  available: true;
  elementId: string;
  evidenceRef: string;
  role: string;
  name: string;
  bounds: Bounds;
  pageGeneration: number;
  documentEpoch: number;
  controlEpoch: number;
  frameId: string;
  sourceMapping: "unavailable";
};
export type AnnotationElement = {
  elementId: string;
  captureId: string;
  backendNodeId: number;
  result: AnnotationEvidence;
};
export type StyleValue = { value: string; priority: string };
export type StyleStep = { property: string; before: StyleValue; after: StyleValue };
export type StyleTrial = {
  trialId: string;
  backendNodeId: number;
  pageGeneration: number;
  documentEpoch: number;
  controlEpoch: number;
  nativeWebContentsId: number;
  sourceUrl: string;
  evidence: AnnotationEvidence;
  history: StyleStep[];
  cursor: number;
  commandCount: number;
  busy: boolean;
  stale: boolean;
};
export type DiagnosticEvent = {
  kind: "console" | "network";
  controlEpoch?: number;
  documentEpoch?: number;
  timestamp?: string;
  level?: string;
  message?: string;
  source?: string;
  line?: number | null;
  url?: string;
  method?: string;
  status?: number | null;
  resourceType?: string | null;
  failure?: string | null;
};
export type DiagnosticRequest = {
  url: string;
  method: string;
  documentEpoch: number;
  controlEpoch: number;
  status?: number | null;
  resourceType?: string;
};
export type FileHandoff = {
  kind: "download";
  pageGeneration: number;
  documentGeneration: number;
  controlEpoch: number;
  url: string;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
};
export type FileReceipt = {
  id: string;
  pageId: string;
  threadId: string;
  openerId: string | null;
  pageOrigin: string;
  initiator: string;
  source: string;
  name: string;
  sizeBytes: number | null;
  receivedBytes: number;
  target: string | null;
  status: string;
  reason: string | null;
  networkOutcome: string;
  timer?: ReturnType<typeof setTimeout>;
};
export type CommandDownload = {
  id: string;
  path: string;
  item?: DownloadItem;
  state: string;
  consumed?: boolean;
};
export type RecordingArtifact = BrowserRecordingArtifact;
export type Recording = {
  id: string;
  status: BrowserRecordingJob["status"];
  phase: BrowserRecordingJob["phase"];
  startedAt: number;
  controller: AbortController;
  action: ActionLease;
  promise: Promise<void> | null;
  artifact: RecordingArtifact | null;
  error: string | null;
  finishedAt?: number;
  publications?: Set<string>;
};
export type DevelopmentPromptFence = ReturnType<
  InstanceType<typeof import("./presentation.cjs").PreviewPresentation>["developmentPromptFence"]
>;
export type DevelopmentPrompt = {
  kind: "frame";
  origin: string;
  page: Page;
  fence: DevelopmentPromptFence;
};
export type PreviewPreferences = {
  blockPrivatePreviewNetworks?: boolean;
  browserLocalTarget?: "internal" | "external";
  browserLinkTarget?: "internal" | "external";
};
export type FrameGrant = {
  contents: WebContents;
  origin: string;
  status: "pending" | "reloading" | "active";
  parentURL: string;
  documentGeneration: number;
  fence: DevelopmentPromptFence;
  expiresAt: number;
  navigationStarted?: boolean;
  valid: () => boolean;
};
export interface Page {
  id: string;
  pageGeneration: number;
  view: WebContentsView | null;
  partition: string;
  session: Session;
  coreInstanceId: string | null;
  projectId: string;
  threadId: string;
  openerId: string | null;
  origin: string;
  title: string;
  error: string;
  url: string;
  committedUrl: string;
  crashed: boolean;
  control: Control;
  controlEpoch: number;
  documentGeneration: number;
  viewportRevision: number;
  refs: Map<string, string>;
  nativeControls: Map<string, NativeControl>;
  optionIds: Map<string, string>;
  nativeControlKey: string;
  observedViewportKey: string | null;
  plans: Map<string, SavedPlan>;
  lastObservation: string | null;
  needsObservation: boolean;
  nextRef: number;
  heldButtons: Map<string | undefined, { x: unknown; y: unknown }>;
  heldKeys: Map<string | undefined, NativeKey>;
  inputPending: Set<Promise<unknown>>;
  requestedVisible: boolean;
  downloads: Set<DownloadItem>;
  downloadRecords: Map<DownloadItem, FileReceipt>;
  dialogPending: boolean;
  fileHandoff: FileHandoff | null;
  commandDownloads: Map<string, CommandDownload>;
  commandFrameSessions: Map<string, string>;
  commandDialog: BrowserDialog | null;
  commandLifecycle: NonNullable<BrowserTabSummary["lifecycle"]>;
  fileChooserIntercepted: boolean;
  stateLoss: string | null;
  diagnosticsReady: boolean;
  diagnosticsStartedAt: number | null;
  diagnosticEvents: {
    record: DiagnosticEvent & { sequence: number; at: string; pageGeneration: number };
    bytes: number;
  }[];
  diagnosticRequests: Map<string, DiagnosticRequest>;
  diagnosticBytes: number;
  diagnosticSequence: number;
  diagnosticLoss: { after: number; reason: string } | null;
  networkPolicy: WorkspaceNetworkPolicy;
  dialogPresentation?: {
    assertClaimable: () => void;
    cancel: () => void;
    dispose: () => void;
  } | null;
  activeAction?: ActionLease | null;
  activeBatch?: { requestId: string | number; cancel: () => void; cancelled?: boolean } | null;
  activePrepare?: boolean;
  activeRead?: CancelableRead | null;
  activeSelection?: { cancel: () => void } | null;
  annotationCapture?: AnnotationCapture | null;
  annotationCaptureId?: string | null;
  annotationElement?: AnnotationElement | null;
  approvedActionNavigation?: NavigationIntent | null;
  approvedNavigation?: string | null;
  batchProgress?: { callId: string; total: number; completed: number; status: string } | null;
  claiming?: { cancel: () => void } | null;
  commandArtifactRoot?: string | null;
  commandDownloadIntent?: {
    controlEpoch: number;
    pageGeneration: number;
    expiresAt: number;
  } | null;
  commandRecording?: Recording | null;
  commandRecordings?: Map<string, Recording>;
  commandSurface?: boolean;
  commandViewport?: { width: number; height: number } | null;
  converging?: Promise<void> | null;
  frameDocumentGeneration?: number;
  frameGrant?: FrameGrant | null;
  guiZoom?: number;
  presentationBounds?: Bounds;
  viewportScale?: number;
  emulationKey?: string;
  humanInputPending?: Promise<unknown> | null;
  humanRevision?: number;
  lastCapture?: Capture | null;
  lastObservationTurnId?: string;
  nextGuardSequence?: number;
  onDownload?: (event: Electron.Event, item: DownloadItem) => void;
  openingDevTools?: WebContents | null;
  pendingDevelopmentPrompt?: string | null;
  styleTrial?: StyleTrial | null;
  transferError?: string | null;
  unregisterProfilePage?: (() => void) | null;
  userPopupIntentUntil?: number;
  viewportKey?: string | null;
}
export type LivePage = Page & { view: WebContentsView };
export type NativeKey = {
  type?: string;
  key?: string;
  code?: string;
  windowsVirtualKeyCode?: number;
  nativeVirtualKeyCode?: number;
  modifiers?: number;
  text?: string;
  unmodifiedText?: string;
};
export interface PlanIdentity {
  preparedActionId: string;
  operation: string;
  pageId: string;
  origin: string;
  url: string;
  pageGeneration: number;
  documentEpoch: number;
  controlEpoch: number;
  browserHostId: string;
  hostGeneration: number;
  threadId: string;
  turnId: string;
  callId: string;
  expiresAt: number;
  fingerprint?: string;
}
export type ReadPlan = PlanIdentity & {
  operation: "observe" | "capture" | "diagnostics";
  parameters: ReadRequest["parameters"];
};
export type ActionPlan = PlanIdentity & {
  operation: "act" | "wait";
  localDevelopment: boolean;
  snapshotId: string | null;
  target: ActionTarget | null;
  action: Action | { kind: "wait"; timeoutMs: number; condition?: Condition };
  viewportRevision: number;
  viewportKey: string | null;
};
export type ActionTarget = {
  ref?: string;
  role?: string;
  name?: string;
  x?: number;
  y?: number;
  semantics?: PublicSemantics;
  nativeControl?: unknown;
  kind?: "viewport";
  point?: Point;
  from?: Point;
  to?: Point;
  steps?: number;
  captureId?: string;
  bitmapWidth?: number;
  bitmapHeight?: number;
};
export type NavigationPlan = PlanIdentity & {
  operation: "navigate" | "newPage";
  targetUrl: string;
  targetOrigin: string;
  parameters?: NavigationRequest["parameters"];
};
export type CommandPageFacts = {
  pageId: string;
  pageGeneration: number;
  documentEpoch: number;
  controlEpoch: number;
  control: Control;
  url: string;
  viewportRevision: number;
  bounds: Bounds | null;
  zoom: number | null;
};
export type CommandPlan = PlanIdentity & {
  operation: "command";
  parameters: CommandRequest["parameters"];
  target: { pages: CommandPageFacts[] };
  targetUrl?: string;
  targetOrigin?: string;
};
export type BatchPlan = PlanIdentity & {
  operation: "runBatch";
  snapshotId: string;
  steps: ActionPlan[];
  parameters?: BatchRequest["parameters"];
  localDevelopment: boolean;
  viewportRevision: number;
};
export type SavedRead = { kind: "read"; plan: ReadPlan; pageUrl: string; parameters?: string };
export type SavedAction = {
  kind: "action";
  plan: ActionPlan;
  targetIdentity?: string;
  native?: NativeControl | null;
  waitNative?: NativeControl | null;
  pageUrl: string;
  waitIdentity: string | null;
};
export type SavedNavigation = { kind: "navigation"; plan: NavigationPlan; pageUrl: string };
export type SavedCommand = {
  kind: "command";
  plan: CommandPlan;
  pageUrl: string;
  targets: Page[];
  dialog?: Page["commandDialog"];
};
export type SavedBatch = { kind: "batch"; plan: BatchPlan; pageUrl: string };
export type SavedPlan = SavedRead | SavedAction | SavedNavigation | SavedCommand | SavedBatch;

export type PreparedAction = Pick<
  HostIdentity,
  | "coreInstanceId"
  | "coreGeneration"
  | "projectId"
  | "threadId"
  | "turnId"
  | "callId"
  | "pageId"
  | "browserHostId"
  | "hostGeneration"
  | "pageGeneration"
  | "controlEpoch"
> & { plan: ActionPlan };
export type ActionReceipt = {
  dispatch: string;
  verification?: string;
  preparedActionId: string;
  inputConfirmed?: boolean;
  noOp?: boolean;
  nativeControl?: unknown;
  stateMatched?: boolean;
  observationInvalidated?: boolean;
};
export type BatchReceipt = ActionReceipt & {
  stepIndex: number;
  operation: "act" | "wait";
  status: string;
};
export type BatchResult = {
  dispatch: string;
  receipts: BatchReceipt[];
  verification?: string;
  error?: string;
  failedStep?: number;
  remaining?: string;
  remainingSteps?: number;
};
export type BatchCall = {
  parameters: string;
  page: Page;
  plan: BatchPlan | null;
  result: BatchResult | null;
  executePromise: Promise<BatchResult> | null;
  preparePromise?: Promise<PreparedBatch>;
  cancelled: boolean;
};
export type PreparedBatch = Omit<PreparedAction, "plan"> & { plan: BatchPlan };

import type { CDPSession } from "playwright-core";
declare const protocolSend: CDPSession["send"];
export type CdpMethod = Parameters<CDPSession["send"]>[0];
export type CdpResult<M extends CdpMethod> = Awaited<ReturnType<typeof protocolSend<M>>>;
export type AxNode = CdpResult<"Accessibility.getFullAXTree">["nodes"][number];
export type DomNode = CdpResult<"DOM.describeNode">["node"];
export type CdpFrameTree = CdpResult<"Page.getFrameTree">["frameTree"];

export type DiscoveryPlan = Omit<PlanIdentity, "pageId"> & {
  operation: "describe";
  pageId: string | null;
  coreInstanceId: string;
  coreGeneration: string;
  projectId: string;
  alreadyControlled: boolean;
  control: Control | null;
  humanRevision: number;
};

export type ObservationEntry = {
  id: string;
  role: string;
  name: string;
  parent?: string;
  frameId?: string;
  ref?: string;
  nativeControl?: ReturnType<typeof import("./native-targets.cjs").publicNativeControl>;
  value?: string;
  description?: string;
  state: Record<string, string>;
};

export type CommandOutcome = {
  commandResult: BrowserCommandResult;
  createdPage?: PagePermit;
  controlPermits?: PagePermit[];
  closedPageIds?: string[];
  revokedPageIds?: string[];
};
export type PagePermit = { pageId: string; pageGeneration: number; controlEpoch: number };
export type CdpSend = <M extends CdpMethod>(
  method: M,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<CdpResult<M>>;
