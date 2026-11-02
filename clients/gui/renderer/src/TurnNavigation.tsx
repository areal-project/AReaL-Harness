import { Button } from "@areal/ui";
import { useReducedMotion } from "./settings/applicationPreferences.js";
import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Data } from "./services.js";
import { goalContinuationLabel } from "./conversationPresentation.js";
import { lastTurnAbove, turnSections } from "./conversationReadingDom.js";
import { observeResize } from "@areal/ui/observe-resize";

type Preview = { turnId: string; source: "pointer" | "keyboard" };
type WaveTarget = { turnId: string; offset: number };
type MarkerMotion = { element: HTMLSpanElement; length: number; velocity: number };
type PreviewBox = { turnId: string; left: number; top: number; width: number; maxHeight: number };

export function TurnNavigation({
  turns,
  container,
  onNavigate,
}: {
  turns: Data[];
  container: RefObject<HTMLDivElement | null>;
  onNavigate: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const [activeId, setActiveId] = useState<string>();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [rovingId, setRovingId] = useState<string>();
  const [placement, setPlacement] = useState<PreviewBox | null>(null);
  const previewId = useId();
  const rail = useRef<HTMLElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const interaction = useRef({ pointer: false, focus: false });
  const ids: string[] = turns.map((turn) => turn.id);
  const identity = JSON.stringify(ids);
  const latest = useRef({ ids, reducedMotion, preview, activeId });
  latest.current = { ids, reducedMotion, preview, activeId };
  const wave = useRef<{
    target: WaveTarget | null;
    markers: Map<string, MarkerMotion>;
    frame: number | null;
    lastTime: number | null;
  }>({ target: null, markers: new Map(), frame: null, lastTime: null });

  function tickWave(now: number) {
    const state = wave.current;
    state.frame = null;
    const dt = Math.min(2, (now - (state.lastTime ?? now - 1000 / 60)) / (1000 / 60));
    state.lastTime = now;
    const { ids, reducedMotion } = latest.current;
    const index = state.target ? ids.indexOf(state.target.turnId) : -1;
    const position = index < 0 ? null : index + state.target!.offset;
    let moving = false;
    ids.forEach((id, index) => {
      const marker = state.markers.get(id);
      if (!marker) return;
      const proximity = position === null ? 0 : Math.exp(-((index - position) ** 2) / 3.2);
      const target = 6 + 19 * proximity;
      if (reducedMotion) {
        marker.length = target;
        marker.velocity = 0;
      } else {
        marker.velocity =
          (marker.velocity + (target - marker.length) * 0.19 * dt) * Math.pow(0.64, dt);
        marker.length += marker.velocity * dt;
        if (Math.abs(target - marker.length) > 0.015 || Math.abs(marker.velocity) > 0.015) {
          moving = true;
        } else {
          marker.length = target;
          marker.velocity = 0;
        }
      }
      marker.element.style.transform = `scaleX(${marker.length / 6})`;
      marker.element.style.setProperty(
        "--turn-opacity",
        String(position === null ? 0.55 : 0.4 + 0.6 * proximity),
      );
    });
    if (moving && !reducedMotion) state.frame = requestAnimationFrame(tickWave);
    else state.lastTime = null;
  }

  function animateWave() {
    const state = wave.current;
    if (latest.current.reducedMotion) {
      if (state.frame !== null) cancelAnimationFrame(state.frame);
      tickWave(performance.now());
    } else if (state.frame === null) {
      state.lastTime = null;
      state.frame = requestAnimationFrame(tickWave);
    }
  }

  function selectPreview(next: Preview | null, offset = 0) {
    const previous = latest.current.preview;
    wave.current.target = next ? { turnId: next.turnId, offset } : null;
    if (previous?.turnId !== next?.turnId || previous?.source !== next?.source) {
      latest.current.preview = next;
      setPreview(next);
    }
    animateWave();
  }

  function buttonFor(id: string) {
    return [...(rail.current?.querySelectorAll("button") ?? [])].find(
      (button) => button.dataset.navTurnId === id,
    );
  }

  function revealTurn(id: string) {
    const element = rail.current,
      button = buttonFor(id);
    if (!element || !button) return;
    const bounds = element.getBoundingClientRect(),
      rect = button.getBoundingClientRect();
    if (rect.top < bounds.top)
      element.scrollTo({ top: element.scrollTop + rect.top - bounds.top, behavior: "instant" });
    else if (rect.bottom > bounds.bottom)
      element.scrollTo({
        top: element.scrollTop + rect.bottom - bounds.bottom,
        behavior: "instant",
      });
  }

  function releaseRail() {
    if (!interaction.current.pointer && !interaction.current.focus && latest.current.activeId)
      revealTurn(latest.current.activeId);
  }

  function focusTurn(id: string) {
    setRovingId(id);
    selectPreview({ turnId: id, source: "keyboard" });
    buttonFor(id)?.focus({ preventScroll: true });
    revealTurn(id);
  }

  function measurePreview() {
    const current = latest.current.preview;
    const element = tooltip.current,
      track = rail.current;
    const shell = container.current?.closest<HTMLElement>(".messages-shell");
    const button = current && buttonFor(current.turnId);
    if (!current || !element || !track || !shell || !button) {
      setPlacement((previous) => (previous === null ? previous : null));
      return;
    }
    const bounds = shell.getBoundingClientRect(),
      railBounds = track.getBoundingClientRect(),
      anchor = button.getBoundingClientRect();
    const left = Math.max(0, bounds.left) + 8,
      right = Math.min(window.innerWidth, bounds.right) - 8;
    const top = Math.max(0, bounds.top) + 8,
      bottom = Math.min(window.innerHeight, bounds.bottom) - 8;
    const width = Math.min(280, right - left),
      maxHeight = bottom - top;
    if (
      width <= 0 ||
      maxHeight <= 0 ||
      anchor.bottom <= Math.max(railBounds.top, top) ||
      anchor.top >= Math.min(railBounds.bottom, bottom)
    ) {
      setPlacement((previous) => (previous === null ? previous : null));
      return;
    }
    element.style.width = `${width}px`;
    element.style.maxHeight = `${maxHeight}px`;
    const measured = element.getBoundingClientRect();
    if (measured.width > right - left || measured.height > maxHeight) {
      setPlacement((previous) => (previous === null ? previous : null));
      return;
    }
    const height = measured.height;
    const next = {
      turnId: current.turnId,
      width,
      maxHeight,
      left: Math.max(left, Math.min(right - width, anchor.right + 8)),
      top: Math.max(top, Math.min(bottom - height, anchor.top - height * 0.43)),
    };
    setPlacement((previous) =>
      previous &&
      previous.turnId === next.turnId &&
      previous.left === next.left &&
      previous.top === next.top &&
      previous.width === width &&
      previous.maxHeight === maxHeight
        ? previous
        : next,
    );
  }

  useLayoutEffect(() => {
    const state = wave.current;
    const valid = new Set(ids);
    for (const id of state.markers.keys()) if (!valid.has(id)) state.markers.delete(id);
    if (latest.current.preview && !valid.has(latest.current.preview.turnId)) selectPreview(null);
    if (!ids.length) {
      if (state.frame !== null) cancelAnimationFrame(state.frame);
      state.frame = state.lastTime = state.target = null;
      state.markers.clear();
      interaction.current = { pointer: false, focus: false };
      setRovingId(undefined);
      setActiveId(undefined);
      return;
    }
    if (!rovingId || !valid.has(rovingId)) {
      const next = activeId && valid.has(activeId) ? activeId : ids[0];
      setRovingId(next);
      if (interaction.current.focus) focusTurn(next);
    }
    animateWave();
  }, [identity, reducedMotion]);

  useLayoutEffect(
    () => () => {
      const state = wave.current;
      if (state.frame !== null) cancelAnimationFrame(state.frame);
      state.frame = state.lastTime = null;
    },
    [],
  );

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      const top = element.getBoundingClientRect().top + 72;
      const sections = turnSections(element);
      const atBottom =
        element.scrollHeight > element.clientHeight &&
        element.scrollHeight - element.clientHeight - element.scrollTop <= 2;
      const current = atBottom
        ? sections.at(-1)
        : (sections[lastTurnAbove(sections, top)] ?? sections[0]);
      const next = current?.dataset.turnId;
      if (latest.current.activeId !== next) {
        latest.current.activeId = next;
        setActiveId(next);
      }
      releaseRail();
    };
    const scroll = () => {
      // 一帧内的多次 scroll 只量一次位置。
      frame ??= requestAnimationFrame(update);
      if (latest.current.preview?.source === "keyboard") measurePreview();
      else selectPreview(null);
    };
    update();
    element.addEventListener("scroll", scroll, { passive: true });
    const stopObserving = observeResize(
      element.firstElementChild ? [element, element.firstElementChild] : element,
      () => update(),
    );
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      element.removeEventListener("scroll", scroll);
      stopObserving();
    };
  }, [container, identity]);

  useEffect(() => {
    if (!interaction.current.focus) setRovingId(activeId);
    releaseRail();
  }, [activeId]);

  useEffect(() => {
    if (!preview) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") selectPreview(null);
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [preview]);

  useLayoutEffect(() => {
    measurePreview();
  });
  useLayoutEffect(() => {
    if (!preview) return;
    const shell = container.current?.closest<HTMLElement>(".messages-shell");
    const stopObserving = observeResize(
      [shell, rail.current, tooltip.current].filter((target) => !!target),
      () => measurePreview(),
    );
    window.addEventListener("resize", measurePreview);
    return () => {
      stopObserving();
      window.removeEventListener("resize", measurePreview);
    };
  }, [preview?.turnId, preview?.source, container]);

  if (!turns.length) return null;
  const prompt = (turn: Data) =>
    goalContinuationLabel(turn) ??
    ((turn.items ?? []).find((item: Data) => item.type === "userMessage")?.content ?? [])
      .filter((part: Data) => part.type === "text")
      .map((part: Data) => part.text)
      .join(" ");
  const previewIndex = preview ? ids.indexOf(preview.turnId) : -1;
  const previewTurn = turns[previewIndex];
  const tabStopId =
    rovingId && ids.includes(rovingId)
      ? rovingId
      : activeId && ids.includes(activeId)
        ? activeId
        : ids[0];
  return (
    <>
      <nav
        className="turn-navigation"
        aria-label="对话轮次"
        ref={rail}
        onPointerEnter={() => {
          interaction.current.pointer = true;
        }}
        onPointerLeave={() => {
          interaction.current.pointer = false;
          if (latest.current.preview?.source === "pointer") selectPreview(null);
          releaseRail();
        }}
        onPointerMove={(event) => {
          if (event.pointerType === "touch") return;
          const first = rail.current?.querySelector("button")?.getBoundingClientRect();
          if (!first) return;
          const position = Math.max(
            0,
            Math.min(ids.length - 1, (event.clientY - first.top - first.height / 2) / first.height),
          );
          const index = Math.round(position);
          selectPreview({ turnId: ids[index], source: "pointer" }, position - index);
        }}
        onBlur={(event) => {
          if (event.currentTarget.contains(event.relatedTarget)) return;
          interaction.current.focus = false;
          if (latest.current.preview?.source === "keyboard") selectPreview(null);
          releaseRail();
        }}
        onScroll={() => {
          if (latest.current.preview?.source === "keyboard") measurePreview();
          else if (latest.current.preview) selectPreview(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            selectPreview(null);
            return;
          }
          const button = event.target instanceof Element ? event.target.closest("button") : null;
          const index = Math.max(0, ids.indexOf(button?.dataset.navTurnId ?? tabStopId));
          const next =
            event.key === "ArrowUp"
              ? Math.max(0, index - 1)
              : event.key === "ArrowDown"
                ? Math.min(ids.length - 1, index + 1)
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? ids.length - 1
                    : null;
          if (next === null) return;
          event.preventDefault();
          event.stopPropagation();
          focusTurn(ids[next]);
        }}
      >
        {turns.map((turn, index) => {
          const text = prompt(turn);
          return (
            <Button
              unstyled
              data-slot={undefined}
              type="button"
              key={turn.id}
              data-nav-turn-id={turn.id}
              aria-label={`第 ${index + 1} 轮${text ? `：${text.slice(0, 80)}` : ""}`}
              aria-current={activeId === turn.id ? "step" : undefined}
              aria-describedby={
                previewTurn && preview?.turnId === turn.id && placement?.turnId === turn.id
                  ? previewId
                  : undefined
              }
              data-running={turn.status === "inProgress"}
              tabIndex={tabStopId === turn.id ? 0 : -1}
              onFocus={() => {
                interaction.current.focus = true;
                setRovingId(turn.id);
                if (
                  latest.current.preview?.source !== "pointer" ||
                  latest.current.preview.turnId !== turn.id
                ) {
                  selectPreview({ turnId: turn.id, source: "keyboard" });
                }
              }}
              onClick={() => {
                const parent = container.current;
                const section = [
                  ...(parent?.querySelectorAll<HTMLElement>("[data-turn-id]") ?? []),
                ].find((item) => item.dataset.turnId === turn.id);
                if (!parent || !section) return;
                const anchor = section.querySelector<HTMLElement>(".user-message") ?? section;
                onNavigate();
                parent.scrollTo({
                  top:
                    anchor.getBoundingClientRect().top -
                    parent.getBoundingClientRect().top +
                    parent.scrollTop -
                    24,
                  behavior: reducedMotion ? "instant" : "smooth",
                });
              }}
            >
              <span
                className="turn-marker"
                ref={(element) => {
                  if (!element) return;
                  const marker = wave.current.markers.get(turn.id);
                  if (marker) {
                    marker.element = element;
                    element.style.transform = `scaleX(${marker.length / 6})`;
                  } else {
                    wave.current.markers.set(turn.id, { element, length: 6, velocity: 0 });
                  }
                }}
              />
            </Button>
          );
        })}
      </nav>
      {previewTurn &&
        preview &&
        createPortal(
          <div
            id={previewId}
            role="tooltip"
            className="turn-preview"
            ref={tooltip}
            style={
              placement?.turnId === preview.turnId
                ? {
                    top: placement.top,
                    left: placement.left,
                    width: placement.width,
                    maxHeight: placement.maxHeight,
                  }
                : { visibility: "hidden" }
            }
          >
            <small>
              第 {previewIndex + 1} / {turns.length} 轮
            </small>
            <strong>{prompt(previewTurn) || `第 ${previewIndex + 1} 轮`}</strong>
            <p>
              {(previewTurn.items ?? [])
                .filter((item: Data) => item.type === "agentMessage" && item.text)
                .map((item: Data) => item.text)
                .join(" ")
                .replace(/\s+/g, " ") ||
                ({
                  inProgress: "正在执行…",
                  failed: "本轮执行失败",
                  interrupted: "本轮已停止",
                }[previewTurn.status as string] ??
                  "暂无助手回复")}
            </p>
          </div>,
          document.body,
        )}
    </>
  );
}
