import { Input } from "@areal/ui";
import { composerDraftStorage } from "./composerDraftStorage.js";
import { useI18n } from "./i18n/IntlProvider.js";
import {
  BrowserToolbar,
  BrowserEmptyState,
  BrowserLoadErrorState,
} from "./EmbeddedBrowserPaneParts.js";
// Core owns isolated native pages; the copied ZCode parts own the presentation.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.js";
import type { PlatformServices, Data } from "./services.js";
import { BrowserRegionAnnotation, type RegionDraft } from "./BrowserRegionAnnotation.js";
import { attachmentDrafts, sending, stageThreadDraft } from "./Composer.js";
import { isComposerFile } from "./ComposerAttachments.js";
import {
  attachBrowserAnnotation,
  browserAnnotation,
  setBrowserAnnotationEditing,
} from "./browserAnnotations.js";
import { BrowserVerificationCard } from "./BrowserVerificationCard.js";
import { uninspectedToolCalls } from "./toolInspection.js";
import "./BrowserFileHandoff.layout.css";
import { BrowserStyleTrial, type StyleTrialDraft } from "./BrowserStyleTrial.js";
import { BrowserKeyboardElementPicker } from "./BrowserKeyboardElementPicker.js";
import type { Action } from "./services.js";
import type { PreviewRequest } from "@areal/workbench/desktop-contract";
import type { BrowserWorkspaceRequest } from "./app-shell/useBrowserWorkspace.js";
type WithoutPage<Request> = Request extends unknown ? Omit<Request, "pageId"> : never;
type PagePreviewRequest = WithoutPage<BrowserWorkspaceRequest>;
const locations = new Map<string, { url: string }>();
const regionDrafts = new Map<string, RegionDraft>();
const styleTrialDrafts = new Map<string, StyleTrialDraft>();
export function Preview({
  services,
  projectId,
  threadId,
  pageId,
  state,
  requestPage,
  fullAddress = false,
  thread,
  action,
  onReview,
  onTool,
}: {
  services: PlatformServices;
  projectId: string;
  threadId: string;
  pageId: string;
  state: Data;
  requestPage: (request: BrowserWorkspaceRequest) => Promise<Data>;
  fullAddress?: boolean;
  thread?: Data;
  action: Action;
  onReview: (turnId: string) => void;
  onTool: (itemId: string) => void;
  onError: (s: string) => void;
}) {
  const { t } = useI18n();
  const owner = `${projectId}:${threadId}:${pageId}`;
  const draftKey = `areal-gui:draft:${projectId}:${threadId}`;
  const stagedAnnotations = (attachmentDrafts.get(draftKey) ?? [])
    .filter(isComposerFile)
    .flatMap((file) => {
      const note = browserAnnotation(file);
      return note ? [note] : [];
    });
  const [url, setUrl] = useState(locations.get(owner)?.url ?? state.url ?? "");
  const [error, setError] = useState("");
  const [responsive, setResponsive] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [width, setWidth] = useState(390);
  const [addressFocused, setAddressFocused] = useState(false);
  const [annotationState, setAnnotationState] = useState<{
    owner: string;
    draft: RegionDraft | null;
  }>(() => ({ owner, draft: regionDrafts.get(owner) ?? null }));
  const annotating =
    annotationState.owner === owner ? annotationState.draft : (regionDrafts.get(owner) ?? null);
  const [annotationBusyOwner, setAnnotationBusyOwner] = useState<string | null>(null);
  const annotationBusy = annotationBusyOwner === owner;
  const [annotationErrorState, setAnnotationErrorState] = useState<{
    owner: string;
    message: string;
  } | null>(null);
  const annotationError = annotationErrorState?.owner === owner ? annotationErrorState.message : "";
  useEffect(() => {
    setBrowserAnnotationEditing(draftKey, !!annotating?.region);
    return () => setBrowserAnnotationEditing(draftKey, false);
  }, [draftKey, !!annotating?.region]);
  const annotationControl = useRef<HTMLButtonElement>(null);
  const annotationFocusOwner = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (annotationFocusOwner.current !== owner) {
      annotationFocusOwner.current = null;
      return;
    }
    if (annotationBusy || annotating) return;
    annotationFocusOwner.current = null;
    annotationControl.current?.focus();
  }, [owner, annotationBusy, annotating]);
  const [styleTrialState, setStyleTrialState] = useState<{
    owner: string;
    draft: StyleTrialDraft | null;
  }>(() => ({ owner, draft: styleTrialDrafts.get(owner) ?? null }));
  const styleTrial =
    styleTrialState.owner === owner ? styleTrialState.draft : (styleTrialDrafts.get(owner) ?? null);
  const [styleBusyOwner, setStyleBusyOwner] = useState<string | null>(null);
  const styleBusy = styleBusyOwner === owner;
  const [keyboardCapture, setKeyboardCapture] = useState<RegionDraft["capture"] | null>(null);
  const keyboardCaptureRef = useRef<RegionDraft["capture"] | null>(null);
  const styleControl = useRef<HTMLButtonElement>(null);
  const styleFocusOwner = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (styleFocusOwner.current !== owner) {
      styleFocusOwner.current = null;
      return;
    }
    if (styleBusy || styleTrial || keyboardCapture) return;
    styleFocusOwner.current = null;
    styleControl.current?.focus();
  }, [owner, styleBusy, styleTrial, keyboardCapture]);
  useEffect(() => {
    setKeyboardCapture(null);
    return () => {
      const capture = keyboardCaptureRef.current;
      keyboardCaptureRef.current = null;
      if (capture)
        void services
          .preview({
            operation: "endRegion",
            projectId,
            threadId,
            pageId: capture.pageId,
            captureId: capture.captureId,
          })
          .catch(() => {});
    };
  }, [services, projectId, threadId]);
  const styleTrialRef = useRef(styleTrial);
  styleTrialRef.current = styleTrial;
  const annotatingRef = useRef(annotating);
  annotatingRef.current = annotating;
  const box = useRef<HTMLDivElement>(null);
  const editing = useRef(false);
  const current = useRef(owner);
  current.current = owner;
  const mounted = useRef(false);
  const sequence = useRef(0);
  const request = async (request: PagePreviewRequest) => {
    const operation = request.operation;
    if (
      ["navigate", "back", "forward", "reload", "selectPage", "newPage", "release"].includes(
        operation,
      )
    )
      editing.current = false;
    if (
      ["navigate", "back", "forward", "reload", "devtools"].includes(operation) &&
      annotatingRef.current
    ) {
      if (annotationBusy) return;
      await cancelAnnotation();
      if (annotatingRef.current) return;
    }
    const seq = ++sequence.current;
    try {
      await requestPage({ ...request, pageId });
      if (!mounted.current || current.current !== owner || seq !== sequence.current) return;
      if (operation !== "state") setError("");
    } catch (e) {
      if (mounted.current && current.current === owner)
        setError(e instanceof Error ? e.message : String(e));
    }
  };
  const stateRef = useRef(state);
  stateRef.current = state;
  const errorRef = useRef(error);
  errorRef.current = error;
  useEffect(() => {
    mounted.current = true;
    let active = true;
    let lastDisplay = "";
    const update = () => {
      if (!active || !box.current) return;
      if (keyboardCaptureRef.current || annotatingRef.current) {
        lastDisplay = "";
        return;
      }
      const r = box.current.getBoundingClientRect();
      // Native pages sit above the renderer, so keep them hidden through popup exit animations.
      const overlay = document.querySelector(
        ':is([role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]):is([data-open], [data-ending-style])',
      );
      const value = stateRef.current;
      const workspace = box.current.closest(".work-area");
      const composer =
        workspace?.getAttribute("data-workspace-view") === "panel"
          ? workspace.querySelector(".active-composer, .draft-composer")
          : null;
      // A native view is above Renderer paint: hiding its parent in CSS does
      // not hide the page, and a floating input must retain its actual space.
      const height = Math.max(
        0,
        Math.min(r.bottom, composer?.getBoundingClientRect().top ?? r.bottom) - r.top,
      );
      const display: PreviewRequest = {
        operation: "show",
        projectId,
        threadId,
        pageId,
        visible:
          !!value.url &&
          !value.error &&
          !errorRef.current &&
          !overlay &&
          !annotatingRef.current &&
          !styleTrialRef.current?.after &&
          height > 0 &&
          box.current.checkVisibility({ visibilityProperty: true }),
        bounds: { x: r.x, y: r.y, width: r.width, height },
      };
      const signature = JSON.stringify(display);
      if (signature === lastDisplay) return;
      lastDisplay = signature;
      void services.preview(display).catch((e) => {
        lastDisplay = "";
        if (active) setError(e.message);
      });
    };
    const resize = new ResizeObserver(update);
    resize.observe(box.current!);
    const composer = box.current
      ?.closest(".work-area")
      ?.querySelector(".active-composer, .draft-composer");
    if (composer) resize.observe(composer);
    const mutation = new MutationObserver(update);
    mutation.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-open", "data-ending-style", "data-workspace-view"],
    });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    update();
    const timer = setInterval(update, 500);
    return () => {
      active = false;
      mounted.current = false;
      setBrowserAnnotationEditing(draftKey, false);
      sequence.current++;
      clearInterval(timer);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      void services.preview({ operation: "hide", projectId, threadId, pageId }).catch(() => {});
      void services
        .preview({ operation: "cancelElementSelection", projectId, threadId, pageId })
        .catch(() => {});
    };
  }, [services, projectId, threadId, pageId]);
  const updateAnnotation = (draft: RegionDraft | null) => {
    annotatingRef.current = draft;
    setBrowserAnnotationEditing(draftKey, !!draft?.region);
    if (draft) regionDrafts.set(owner, draft);
    else regionDrafts.delete(owner);
    setAnnotationState({ owner, draft });
  };
  const updateStyleTrial = (draft: StyleTrialDraft | null) => {
    styleTrialRef.current = draft;
    if (draft) styleTrialDrafts.set(owner, draft);
    else styleTrialDrafts.delete(owner);
    setStyleTrialState({ owner, draft });
  };
  const startStyleTrial = async (keyboard = false) => {
    if (styleBusy || styleTrial || annotating || annotationBusy || keyboardCaptureRef.current)
      return;
    setStyleBusyOwner(owner);
    setError("");
    let capture: RegionDraft["capture"] | null = null;
    try {
      const pageId = stateRef.current.browser?.pageId;
      if (!pageId) throw new Error("请选择当前页面");
      if (stateRef.current.browser?.control === "agent")
        await services.preview({ operation: "takeover", projectId, threadId, pageId });
      if (keyboard) {
        capture = (await services.preview({
          operation: "captureRegion",
          projectId,
          threadId,
          pageId,
        })) as RegionDraft["capture"];
        if (!mounted.current || current.current !== owner) throw new Error("选择所属聊天已变化");
        // 本地选择器覆盖原生页面期间，保持截图对应的视口不变。
        keyboardCaptureRef.current = capture;
        await services.preview({
          operation: "hide",
          projectId,
          threadId,
          pageId,
          captureId: capture.captureId,
        });
        if (!mounted.current || current.current !== owner) throw new Error("选择所属聊天已变化");
        setKeyboardCapture(capture);
        return;
      }
      const selected = await services.preview({
        operation: "captureElement",
        projectId,
        threadId,
        pageId,
      });
      capture = selected.capture as RegionDraft["capture"];
      if (!selected.element?.available)
        throw new Error(selected.element?.reason || "此元素不支持页面试改");
      const begun = await services.preview({
        operation: "beginStyleTrial",
        projectId,
        threadId,
        pageId,
        captureId: capture.captureId,
        elementId: selected.element.elementId,
      });
      if (!mounted.current || current.current !== owner) {
        await services.preview({
          operation: "clearStyleTrial",
          projectId,
          threadId,
          pageId,
          trialId: begun.trialId,
        });
        return;
      }
      updateStyleTrial({
        trialId: begun.trialId,
        before: capture,
        element: selected.element,
        edits: [],
        canUndo: false,
        canRedo: false,
        stale: false,
        intent: "",
      });
    } catch (e) {
      if (keyboardCaptureRef.current === capture) keyboardCaptureRef.current = null;
      if (mounted.current && current.current === owner) styleFocusOwner.current = owner;
      if (capture)
        void services
          .preview({
            operation: "endRegion",
            projectId,
            threadId,
            pageId: capture.pageId,
            captureId: capture.captureId,
          })
          .catch(() => {});
      if (mounted.current && current.current === owner)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStyleBusyOwner((value) => (value === owner ? null : value));
    }
  };
  const finishKeyboardSelection = async (point?: { x: number; y: number }) => {
    const capture = keyboardCaptureRef.current;
    if (!capture || styleBusy) return;
    setStyleBusyOwner(owner);
    setError("");
    try {
      if (point) {
        const element = await services.preview({
          operation: "selectElement",
          projectId,
          threadId,
          pageId: capture.pageId,
          captureId: capture.captureId,
          ...point,
        });
        if (!mounted.current || current.current !== owner || keyboardCaptureRef.current !== capture)
          return;
        if (!element.available) throw new Error(element.reason || "此元素不支持页面试改");
        const begun = await services.preview({
          operation: "beginStyleTrial",
          projectId,
          threadId,
          pageId: capture.pageId,
          captureId: capture.captureId,
          elementId: element.elementId,
        });
        if (
          !mounted.current ||
          current.current !== owner ||
          keyboardCaptureRef.current !== capture
        ) {
          await services.preview({
            operation: "clearStyleTrial",
            projectId,
            threadId,
            pageId: capture.pageId,
            trialId: begun.trialId,
          });
          return;
        }
        updateStyleTrial({
          trialId: begun.trialId,
          before: capture,
          element: element as NonNullable<RegionDraft["element"]>,
          edits: [],
          canUndo: false,
          canRedo: false,
          stale: false,
          intent: "",
        });
      } else {
        await services.preview({
          operation: "endRegion",
          projectId,
          threadId,
          pageId: capture.pageId,
          captureId: capture.captureId,
        });
      }
      if (mounted.current && current.current === owner && keyboardCaptureRef.current === capture) {
        keyboardCaptureRef.current = null;
        setKeyboardCapture(null);
        if (!point) styleFocusOwner.current = owner;
        // 选择器期间保留了旧显示签名，此处强制刷新可见状态。
        window.dispatchEvent(new Event("resize"));
      }
    } catch (e) {
      if (mounted.current && current.current === owner)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStyleBusyOwner((value) => (value === owner ? null : value));
    }
  };
  const changeStyleTrial = async (
    change:
      | { operation: "applyStyleTrial"; property: string; value: string }
      | { operation: "undoStyleTrial" | "redoStyleTrial" },
  ) => {
    const draft = styleTrialRef.current;
    if (!draft || styleBusy) return;
    setStyleBusyOwner(owner);
    setError("");
    try {
      const next = await services.preview({
        ...change,
        projectId,
        threadId,
        pageId: draft.before.pageId,
        trialId: draft.trialId,
      });
      if (mounted.current && current.current === owner && styleTrialRef.current === draft)
        updateStyleTrial({
          ...draft,
          edits: next.edits,
          canUndo: next.canUndo,
          canRedo: next.canRedo,
          stale: next.stale,
        });
    } catch (e) {
      if (mounted.current && current.current === owner) {
        setError(e instanceof Error ? e.message : String(e));
        const latest = styleTrialRef.current;
        if (latest?.trialId === draft.trialId && /失效|已修改|已替换/.test(String(e)))
          updateStyleTrial({ ...latest, stale: true });
      }
    } finally {
      setStyleBusyOwner((value) => (value === owner ? null : value));
    }
  };
  const cancelStyleTrial = async () => {
    const draft = styleTrialRef.current;
    if (!draft || styleBusy) return;
    setStyleBusyOwner(owner);
    setError("");
    try {
      if (!draft.cleared) {
        try {
          const cleared = await services.preview({
            operation: "clearStyleTrial",
            projectId,
            threadId,
            pageId: draft.before.pageId,
            trialId: draft.trialId,
          });
          if (!cleared.cleared) throw new Error("试改目标已变化，请刷新页面清除残留效果");
        } catch (error) {
          const currentPage = await services.preview({
            operation: "state",
            projectId,
            threadId,
            pageId: draft.before.pageId,
          });
          if (currentPage.browser?.trialActive) throw error;
          // A navigation or page closure already discarded the old document.
        }
      }
      if (draft.after)
        await services.preview({
          operation: "endRegion",
          projectId,
          threadId,
          pageId: draft.before.pageId,
          captureId: draft.after.capture.captureId,
        });
      if (mounted.current && current.current === owner) {
        updateStyleTrial(null);
        styleFocusOwner.current = owner;
      }
    } catch (e) {
      if (mounted.current && current.current === owner)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStyleBusyOwner((value) => (value === owner ? null : value));
    }
  };
  const cropStyleEvidence = async (
    capture: RegionDraft["capture"],
    bounds: NonNullable<RegionDraft["region"]>,
  ) => {
    const image = new Image();
    image.src = `data:image/png;base64,${capture.imageBase64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = bounds.width;
    canvas.height = bounds.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法生成页面试改证据");
    context.drawImage(
      image,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      0,
      0,
      bounds.width,
      bounds.height,
    );
    return new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("无法生成页面试改证据"))),
        "image/png",
      ),
    );
  };
  const stageStyleTrial = async () => {
    const original = styleTrialRef.current;
    if (
      !original ||
      styleBusy ||
      original.stale ||
      !original.intent.trim() ||
      !original.edits.length
    )
      return;
    setStyleBusyOwner(owner);
    setError("");
    try {
      let draft = original;
      if (!draft.after) {
        const after = await services.preview({
          operation: "captureStyleTrialAfter",
          projectId,
          threadId,
          pageId: draft.before.pageId,
          trialId: draft.trialId,
        });
        if (!mounted.current || current.current !== owner || styleTrialRef.current !== draft)
          throw new Error("试改所属聊天已变化");
        await services.preview({
          operation: "hide",
          projectId,
          threadId,
          pageId: draft.before.pageId,
        });
        if (!mounted.current || current.current !== owner || styleTrialRef.current !== draft)
          throw new Error("试改所属聊天已变化");
        draft = { ...draft, after: { capture: after.capture, element: after.element } };
        updateStyleTrial(draft);
      }
      const beforeBlob = await cropStyleEvidence(draft.before, draft.element.bounds);
      const afterBlob = await cropStyleEvidence(draft.after!.capture, draft.after!.element.bounds);
      if (!mounted.current || current.current !== owner || styleTrialRef.current !== draft)
        throw new Error("试改所属聊天已变化");
      if (!draft.cleared) {
        const cleared = await services.preview({
          operation: "clearStyleTrial",
          projectId,
          threadId,
          pageId: draft.before.pageId,
          trialId: draft.trialId,
        });
        if (!cleared.cleared) throw new Error("试改目标已变化，请刷新页面后重新核查");
        if (!mounted.current || current.current !== owner || styleTrialRef.current !== draft)
          throw new Error("试改所属聊天已变化");
        draft = { ...draft, cleared: true };
        updateStyleTrial(draft);
      }
      if (!mounted.current || current.current !== owner || styleTrialRef.current !== draft)
        throw new Error("试改所属聊天已变化");
      const capture = draft.before;
      const description = `页面试改意图（已清除临时效果，未写入代码）\nURL: ${capture.url}\n截图时间: ${capture.capturedAt}\nCore: ${capture.coreInstanceId}; Page: ${capture.pageId}; pageGeneration: ${capture.pageGeneration}; documentEpoch: ${capture.documentEpoch}; controlEpoch: ${capture.controlEpoch}; viewportRevision: ${capture.viewportRevision}\n选择时元素: role=${JSON.stringify(draft.element.role)}; name=${JSON.stringify(draft.element.name)}; historicalRef=${draft.element.evidenceRef}; sourceMapping=${draft.element.sourceMapping}; React 源码位置未知。Agent 必须重新 observe 并取得新 Ref。\n属性值: ${JSON.stringify(draft.edits)}\n前后证据: browser-style-before-${capture.captureId}.png; browser-style-after-${draft.after!.capture.captureId}.png\n用户意图: ${draft.intent.trim()}\n最终验证必须在清除试改后基于真实页面执行。`;
      const draftKey = `areal-gui:draft:${projectId}:${threadId}`;
      if (sending.has(draftKey) || composerDraftStorage.getItem(`${draftKey}:pending`))
        throw new Error("当前聊天有结果待核对的发送；请先确认结果，再加入试改意图");
      const files = [
        ...(attachmentDrafts.get(draftKey) ?? []),
        new File([beforeBlob], `browser-style-before-${capture.captureId}.png`, {
          type: "image/png",
        }),
        new File([afterBlob], `browser-style-after-${draft.after!.capture.captureId}.png`, {
          type: "image/png",
        }),
      ];
      const existing = composerDraftStorage.getItem(draftKey) ?? "";
      const key = stageThreadDraft(
        projectId,
        threadId,
        [existing, description].filter(Boolean).join("\n\n"),
        files,
      );
      window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: key }));
      updateStyleTrial(null);
      await services.preview({
        operation: "endRegion",
        projectId,
        threadId,
        pageId: capture.pageId,
        captureId: draft.after!.capture.captureId,
      });
    } catch (e) {
      if (mounted.current && current.current === owner)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStyleBusyOwner((value) => (value === owner ? null : value));
    }
  };
  const cancelAnnotation = async () => {
    if (!annotating || annotationBusy) return;
    setAnnotationBusyOwner(owner);
    setError("");
    try {
      await services.preview({
        operation: "endRegion",
        projectId,
        threadId,
        pageId: annotating.capture.pageId,
        captureId: annotating.capture.captureId,
      });
      updateAnnotation(null);
      if (mounted.current && current.current === owner) annotationFocusOwner.current = owner;
    } catch (e) {
      if (mounted.current && current.current === owner)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnnotationBusyOwner((value) => (value === owner ? null : value));
    }
  };
  const startAnnotation = async () => {
    if (annotationBusy || annotating) return;
    setAnnotationBusyOwner(owner);
    let captured: RegionDraft["capture"] | null = null;
    try {
      const pageId = stateRef.current.browser?.pageId;
      if (!pageId) throw new Error("请选择当前页面");
      if (stateRef.current.browser?.control === "agent") {
        await services.preview({ operation: "takeover", projectId, threadId, pageId });
      }
      const capture = await services.preview({
        operation: "captureRegion",
        projectId,
        threadId,
        pageId,
      });
      if (
        capture.projectId !== projectId ||
        capture.threadId !== threadId ||
        capture.pageId !== pageId ||
        typeof capture.imageBase64 !== "string" ||
        !Number.isInteger(capture.viewportRevision) ||
        !Number.isFinite(capture.viewport?.bitmapWidth) ||
        !Number.isFinite(capture.viewport?.bitmapHeight)
      )
        throw new Error("截图所属页面已变化");
      captured = capture as RegionDraft["capture"];
      if (!mounted.current || current.current !== owner) {
        await services.preview({
          operation: "endRegion",
          projectId,
          threadId,
          pageId,
          captureId: captured.captureId,
        });
        return;
      }
      await services.preview({
        operation: "hide",
        projectId,
        threadId,
        pageId,
        captureId: captured.captureId,
      });
      if (!mounted.current || current.current !== owner) {
        await services.preview({
          operation: "endRegion",
          projectId,
          threadId,
          pageId,
          captureId: captured.captureId,
        });
        return;
      }
      setAnnotationErrorState(null);
      updateAnnotation({
        capture: captured,
        comment: "",
        region: null,
        mode: capture.frameEvidence ? "region" : "element",
        unavailableReason:
          typeof capture.unavailableReason === "string" ? capture.unavailableReason : undefined,
      });
    } catch (e) {
      if (captured)
        void services
          .preview({
            operation: "endRegion",
            projectId,
            threadId,
            pageId: captured.pageId,
            captureId: captured.captureId,
          })
          .catch(() => {});
      if (mounted.current && current.current === owner)
        setAnnotationErrorState({ owner, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setAnnotationBusyOwner((value) => (value === owner ? null : value));
    }
  };
  const selectAnnotationElement = async (point: { x: number; y: number }) => {
    const draft = annotatingRef.current;
    if (!draft || annotationBusy) return;
    setAnnotationBusyOwner(owner);
    setBrowserAnnotationEditing(draftKey, true);
    setError("");
    try {
      const element = await services.preview({
        operation: "selectElement",
        projectId,
        threadId,
        pageId: draft.capture.pageId,
        captureId: draft.capture.captureId,
        ...point,
      });
      if (!mounted.current || current.current !== owner || annotatingRef.current !== draft) return;
      updateAnnotation({
        ...draft,
        point,
        region: element.available ? element.bounds : null,
        element: element.available ? (element as RegionDraft["element"]) : undefined,
        mode: element.available ? "element" : "region",
        unavailableReason: element.available ? undefined : element.reason,
      });
    } catch (cause) {
      if (mounted.current && current.current === owner) setError((cause as Error).message);
    } finally {
      if (current.current === owner)
        setBrowserAnnotationEditing(draftKey, !!annotatingRef.current?.region);
      setAnnotationBusyOwner((value) => (value === owner ? null : value));
    }
  };
  const stageAnnotation = async (draft: RegionDraft) => {
    if (annotationBusy || !draft.region?.width || !draft.region.height || !draft.comment.trim())
      return;
    setAnnotationBusyOwner(owner);
    setError("");
    try {
      const image = new Image();
      image.src = `data:image/png;base64,${draft.capture.imageBase64}`;
      await image.decode();
      const { x, y, width, height } = draft.region!;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法生成标注缩略图");
      context.drawImage(image, x, y, width, height, 0, 0, width, height);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error("无法生成标注缩略图"))),
          "image/png",
        ),
      );
      const capture = draft.capture;
      const scaleX = capture.viewport.width / capture.viewport.bitmapWidth;
      const scaleY = capture.viewport.height / capture.viewport.bitmapHeight;
      const elementCheck =
        draft.element && draft.mode === "element"
          ? await services
              .preview({
                operation: "checkElement",
                projectId,
                threadId,
                pageId: capture.pageId,
                captureId: capture.captureId,
                elementId: draft.element.elementId,
              })
              .catch(() => ({ stale: true }))
          : null;
      if (!mounted.current || current.current !== owner || annotatingRef.current !== draft)
        throw new Error("标注所属聊天已变化");
      const elementDescription =
        draft.element && draft.mode === "element"
          ? `\n选择时元素: role=${JSON.stringify(draft.element.role)}; name=${JSON.stringify(draft.element.name)}; bounds bitmap(px)=${x},${y},${width},${height}; frame=${draft.element.frameId}; historicalRef=${draft.element.evidenceRef}; sourceMapping=${draft.element.sourceMapping}; ${elementCheck?.stale ? "stale: 页面元素已变化，保留原证据。" : "确认时仍命中同一节点；页面之后仍可能变化。"} Agent 必须重新 observe 并取得新 Ref，禁止用 historicalRef 动作。React 源码位置未知。`
          : "";
      const frameDescription = capture.frameEvidence
        ? `\n嵌入站点截图检查: ${JSON.stringify(capture.frameEvidence)}；仅区域证据，无选择器或 Agent 跨源授权。`
        : "";
      const description = `页面${draft.element && draft.mode === "element" ? "元素" : "区域"}标注（冻结截图，页面之后可能变化；仅分享选中区域）\nURL: ${capture.url}\n截图时间: ${capture.capturedAt}\nCore: ${capture.coreInstanceId}; Page: ${capture.pageId}; pageGeneration: ${capture.pageGeneration}; documentEpoch: ${capture.documentEpoch}; controlEpoch: ${capture.controlEpoch}; viewportRevision: ${capture.viewportRevision}; captureId: ${capture.captureId}\n原截图 bitmap(px): ${capture.viewport.bitmapWidth}×${capture.viewport.bitmapHeight}; CSS viewport(px): ${capture.viewport.width}×${capture.viewport.height}; scroll(px): ${capture.viewport.scrollX},${capture.viewport.scrollY}; pageZoom: ${capture.viewport.pageZoom}; GUI zoom: ${capture.viewport.guiZoom}; DPR: ${capture.viewport.deviceScaleFactor}; native DIP bounds: ${JSON.stringify(capture.viewport.nativeBounds)}\n选区 bitmap(px): ${x},${y},${width},${height}; viewport CSS(px): ${(x * scaleX).toFixed(1)},${(y * scaleY).toFixed(1)},${(width * scaleX).toFixed(1)},${(height * scaleY).toFixed(1)}${elementDescription}${frameDescription}\n裁图: browser-region-${capture.captureId}.png`;
      if (composerDraftStorage.getItem(`${draftKey}:queue-edit`))
        throw new Error("请先结束排队消息编辑，再加入标注");
      if (sending.has(draftKey) || composerDraftStorage.getItem(`${draftKey}:pending`))
        throw new Error("当前聊天有结果待核对的发送；请先确认结果，再加入标注草稿");
      // 附件及其说明在同一同步段加入所属草稿；不覆盖用户正在编辑的正文。
      const existingFiles = attachmentDrafts.get(draftKey) ?? [];
      if (existingFiles.length >= 16) throw new Error("每条消息最多 16 个附件，请先发送已有标注");
      const id = crypto.randomUUID();
      const file = new File([blob], `browser-region-${id}.png`, { type: "image/png" });
      attachBrowserAnnotation(file, {
        id,
        comment: draft.comment.trim(),
        label:
          draft.element?.name ||
          (draft.mode === "element" ? draft.element?.role || "页面元素" : "区域标注"),
        url: capture.url,
        capturedAt: capture.capturedAt,
        captureId: capture.captureId,
        region: draft.region!,
        point: draft.point,
        evidence: description.replace(`browser-region-${capture.captureId}.png`, file.name),
      });
      const key = stageThreadDraft(
        projectId,
        threadId,
        composerDraftStorage.getItem(draftKey) ?? "",
        [...existingFiles, file],
      );
      window.dispatchEvent(new CustomEvent("areal-draft-change", { detail: key }));
      updateAnnotation({
        ...draft,
        comment: "",
        region: null,
        element: undefined,
        point: undefined,
      });
    } catch (e) {
      if (mounted.current && current.current === owner)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnnotationBusyOwner((value) => (value === owner ? null : value));
    }
  };
  useEffect(() => {
    if (!editing.current && state.browser?.pageId === pageId) {
      setUrl(state.url ?? "");
      locations.set(owner, { url: state.url ?? "" });
    }
  }, [state.url, state.browser?.pageId, owner, pageId]);
  const failure = error || state.error;
  const uninspectedUnknown = uninspectedToolCalls(thread ?? {}).some(
    (item) => item.tool === "browser_v1",
  );
  const batch = state.workspace?.pages?.find(
    (page: Data) => page.pageId === state.browser?.pageId,
  )?.operation;
  let address = url;
  if (!fullAddress && !addressFocused && !editing.current) {
    try {
      address = new URL(url).host;
    } catch {
      /* Keep a not-yet-valid user draft. */
    }
  }
  return (
    <div className="preview-panel">
      {state.browser?.stateLoss && (
        <div className="preview-viewport-toolbar" role="status">
          {state.browser.stateLoss}
        </div>
      )}
      <BrowserToolbar
        addressValue={address}
        browserState={{
          canGoBack: !!state.canGoBack,
          canGoForward: !!state.canGoForward,
          isReady: !!state.url,
          isLoading: !!state.loading,
          currentUrl: state.url ?? "",
        }}
        formatMessage={browserLabel}
        onToggleDetails={() => setDetailsOpen((value) => !value)}
        onAddressChange={(value) => {
          editing.current = true;
          setUrl(value);
        }}
        onAddressFocus={() => {
          editing.current = true;
          setAddressFocused(true);
        }}
        onAddressBlur={() => {
          if (url === state.url) editing.current = false;
          setAddressFocused(false);
        }}
        onAddressEscape={() => {
          setUrl(state.url || "");
          editing.current = false;
        }}
        onGoBack={() => void request({ operation: "back" })}
        onGoForward={() => void request({ operation: "forward" })}
        onOpenExternal={() => void request({ operation: "external" })}
        onOpenDevTools={() => void request({ operation: "devtools" })}
        onReload={() => void request({ operation: state.loading ? "stop" : "reload" })}
        onToggleResponsiveMode={() => setResponsive(!responsive)}
        isResponsiveMode={responsive}
        annotationControl={annotationControl}
        annotationDisabled={
          !state.url ||
          !!state.error ||
          annotationBusy ||
          styleBusy ||
          !!keyboardCapture ||
          !!styleTrial ||
          state.browser?.control === "transferring"
        }
        annotating={!!annotating}
        onAnnotation={() => void (annotating ? cancelAnnotation() : startAnnotation())}
        onSubmit={(event) => {
          event.preventDefault();
          editing.current = false;
          void request({ operation: "navigate", url });
        }}
      />
      {annotationError && (
        <div className="preview-viewport-toolbar" role="alert">
          <span>{annotationError}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setAnnotationErrorState(null)}
          >
            {t("common.close")}
          </Button>
        </div>
      )}
      {state.browser?.control === "transferring" && (
        <div className="preview-viewport-toolbar browser-transfer-status" role="status">
          <span>{state.browser.transferError || "正在停止浏览器动作…"}</span>
          <Button type="button" size="sm" onClick={() => void request({ operation: "stop" })}>
            停止加载
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void request({ operation: "release", userIntent: true })}
          >
            关闭页面
          </Button>
        </div>
      )}
      {uninspectedUnknown && (
        <div className="preview-viewport-toolbar" role="status">
          {t("operations.browserRecovery")}
        </div>
      )}
      {annotationBusy && !annotating && (
        <div className="sr-only" role="status">
          在页面中点击要标注的元素；按 Esc 取消。
        </div>
      )}
      {batch?.status === "running" && (
        <div className="sr-only" role="status">
          正在浏览 · {batch.completed}/{batch.total}
        </div>
      )}
      {detailsOpen && (
        <div className="browser-details" aria-label="浏览器详情">
          <div className="preview-viewport-toolbar">
            <span>{t("settings.browserData.sharedShort")}</span>
            <Button type="button" size="sm" variant="ghost" onClick={() => setDetailsOpen(false)}>
              关闭详情
            </Button>
          </div>
          {state.url && (
            <div className="preview-viewport-toolbar" role="group" aria-label="网页文件交接">
              {state.browser?.control === "human" ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    disabled={
                      !!state.browser?.downloadIntentExpiresAt || !!annotating || !!styleTrial
                    }
                    onClick={() =>
                      void request({ operation: "allowNextDownload", userIntent: true })
                    }
                  >
                    允许下一次下载
                  </Button>
                  {state.browser?.downloadIntentExpiresAt && (
                    <>
                      <span role="status">30 秒内在当前网页触发一次下载，随后选择保存位置。</span>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void request({ operation: "cancelFileHandoff" })}
                      >
                        取消下载许可
                      </Button>
                    </>
                  )}
                  <span>上传请在网页中使用文件选择控件；系统选择器取消后可继续操作。</span>
                </>
              ) : (
                <span>直接操作页面可选择文件。</span>
              )}
            </div>
          )}
          {(state.workspace?.fileReceipts ?? []).length > 0 && (
            <div
              className="preview-viewport-toolbar preview-file-status"
              role="list"
              aria-label="网页下载状态"
            >
              {(state.workspace.fileReceipts as Data[]).map((receipt: Data) => (
                <div role="listitem" key={receipt.id}>
                  {receipt.name || "未命名下载"} · 页面 {receipt.pageOrigin || "未知"} · 发起者{" "}
                  {receipt.initiator === "unknown" ? "未知" : receipt.initiator}
                  {" · "}
                  {receipt.source || "来源网址未知"}
                  {" · "}
                  {receipt.sizeBytes == null ? "大小未知" : `${receipt.sizeBytes} B`}
                  {" · "}
                  {(
                    {
                      choosing: "选择保存位置",
                      downloading: "下载中",
                      completed: "已完成",
                      cancelled: "已取消",
                      interrupted: "已中断",
                      unknown: "结果待核对",
                    } as Record<string, string>
                  )[receipt.status] ?? "状态未知"}
                  {receipt.target ? ` · 保存为 ${receipt.target}` : ""}
                  {["choosing", "downloading", "interrupted"].includes(receipt.status) &&
                    receipt.pageId === state.browser?.pageId &&
                    state.browser?.control === "human" && (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() =>
                          void request({
                            operation: "cancelDownload",
                            downloadId: receipt.id,
                            userIntent: true,
                          })
                        }
                      >
                        取消下载
                      </Button>
                    )}
                </div>
              ))}
            </div>
          )}
          {state.url && state.browser?.control === "human" && (
            <div className="preview-viewport-toolbar" role="group" aria-label="嵌入站点授权">
              {state.browser.frameOriginGrant ? (
                <>
                  <span role="status">
                    嵌入站点 {state.browser.frameOriginGrant.origin}{" "}
                    {t("common.browser.manualFrame")}
                  </span>
                  {state.browser.frameOriginGrant.status === "pending" && (
                    <Button
                      type="button"
                      size="sm"
                      disabled={!!annotating || !!styleTrial}
                      onClick={() =>
                        void request({ operation: "reloadFrameOrigin", userIntent: true })
                      }
                    >
                      重载并应用嵌入授权
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    disabled={!!annotating || !!styleTrial}
                    onClick={() =>
                      void request({ operation: "revokeFrameOrigin", userIntent: true })
                    }
                  >
                    撤销嵌入授权并关闭页面
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  disabled={!!annotating || !!styleTrial || annotationBusy}
                  onClick={() =>
                    void request({ operation: "authorizeFrameOrigin", userIntent: true })
                  }
                >
                  授权当前页面的嵌入站点
                </Button>
              )}
            </div>
          )}
          {state.url && (
            <div className="preview-viewport-toolbar" role="group" aria-label="页面标注">
              <Button
                ref={styleControl}
                type="button"
                size="sm"
                disabled={
                  annotationBusy ||
                  styleBusy ||
                  !!keyboardCapture ||
                  !!styleTrial ||
                  !!annotating ||
                  state.browser?.control === "transferring"
                }
                onClick={(event) => void startStyleTrial(event.detail === 0)}
              >
                选择元素并试改
              </Button>
              <span>F6 返回应用；键盘选择使用截图坐标。</span>
              <span
                role="status"
                aria-hidden={!annotationBusy || !!annotating}
                style={{ visibility: annotationBusy && !annotating ? "visible" : "hidden" }}
              >
                在页面中点击要标注的元素；按 Esc 取消。
              </span>
            </div>
          )}
          {thread && (
            <BrowserVerificationCard
              thread={thread}
              projectId={projectId}
              action={action}
              onReview={onReview}
              onTool={onTool}
              trialActive={(!!styleTrial && !styleTrial.cleared) || !!state.browser?.trialActive}
            />
          )}
        </div>
      )}
      {styleTrial && (
        <BrowserStyleTrial
          draft={styleTrial}
          busy={styleBusy}
          onApply={(property, value) =>
            void changeStyleTrial({ operation: "applyStyleTrial", property, value })
          }
          onUndo={() => void changeStyleTrial({ operation: "undoStyleTrial" })}
          onRedo={() => void changeStyleTrial({ operation: "redoStyleTrial" })}
          onIntent={(value) => updateStyleTrial({ ...styleTrial, intent: value })}
          onStage={() => void stageStyleTrial()}
          onCancel={() => void cancelStyleTrial()}
        />
      )}
      {responsive && (
        <div className="preview-viewport-toolbar">
          <label>
            宽度{" "}
            <Input
              unstyled
              data-slot={undefined}
              aria-label="预览宽度"
              type="number"
              min={240}
              max={2560}
              value={width}
              onChange={(e) =>
                setWidth(Math.min(2560, Math.max(240, Number(e.target.value) || 240)))
              }
            />{" "}
            px
          </label>
          <Button variant="ghost" size="sm" onClick={() => setResponsive(false)}>
            自适应
          </Button>
        </div>
      )}
      <div className="preview-stage">
        <div
          ref={box}
          className="preview-webview"
          style={responsive ? { width: `min(100%, ${width}px)`, flex: "none" } : undefined}
        />
        {keyboardCapture?.projectId === projectId && keyboardCapture.threadId === threadId && (
          <BrowserKeyboardElementPicker
            key={keyboardCapture.captureId}
            capture={keyboardCapture}
            busy={styleBusy}
            onSelect={(x, y) => void finishKeyboardSelection({ x, y })}
            onCancel={() => void finishKeyboardSelection()}
          />
        )}
        {annotating && (
          <BrowserRegionAnnotation
            draft={annotating}
            busy={annotationBusy}
            notes={stagedAnnotations}
            nextNumber={stagedAnnotations.length + 1}
            onSelectElement={(point) => void selectAnnotationElement(point)}
            onChange={updateAnnotation}
            onCancel={() => void cancelAnnotation()}
            onStage={(draft) => void stageAnnotation(draft)}
          />
        )}
        {failure ? (
          <BrowserLoadErrorState
            errorMessage={failure}
            isCertificateError={false}
            formatMessage={browserLabel}
            onRetry={() => void request({ operation: "navigate", url })}
          />
        ) : !state.url ? (
          <BrowserEmptyState
            browserState={{
              isReady: true,
              canGoBack: false,
              canGoForward: false,
              isLoading: false,
              currentUrl: "",
            }}
            isGuestStarting={false}
            formatMessage={browserLabel}
          />
        ) : null}
      </div>
    </div>
  );
}

function browserLabel({ id }: { id: string }): string {
  return (
    (
      {
        "browser.back": "后退",
        "browser.forward": "前进",
        "browser.reload": "刷新预览",
        "browser.stop": "停止加载",
        "browser.addressPlaceholder": "输入网址，按 Enter 打开",
        "browser.responsive.enter": "响应式预览",
        "browser.responsive.exit": "退出响应式预览",
        "browser.more": "浏览器更多操作",
        "browser.openExternal": "在默认浏览器打开",
        "browser.devtools": "开发者工具",
        "browser.details": "浏览器详情",
        "browser.title": "浏览器",
        "browser.empty": "粘贴或输入网址，按 Enter 打开页面。",
        "browser.loadError.title": "无法打开网页",
        "browser.loadError.retry": "重试",
      } as Record<string, string>
    )[id] ?? id
  );
}
