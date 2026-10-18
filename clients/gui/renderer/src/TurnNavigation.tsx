import { useReducedMotion } from "./settings/applicationPreferences.js";
import { createPortal } from "react-dom";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import type { Data } from "./services.js";
import { goalContinuationLabel } from "./conversationPresentation.js";

/** The rail follows the visible turn, independently of whether the user follows live output. */
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
  const [active, setActive] = useState<string>();
  const [hovered, setHovered] = useState<{
    position: number;
    index: number;
    top: number;
    left: number;
  } | null>(null);
  const previewId = useId();
  const rail = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = () => {
      const top = element.getBoundingClientRect().top + 72;
      const sections = [
        ...element.querySelectorAll<HTMLElement>("[data-turn-id]"),
      ];
      const current =
        sections.findLast(
          (section) => section.getBoundingClientRect().top <= top,
        ) ?? sections[0];
      setActive(current?.dataset.turnId);
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const resize = new ResizeObserver(update);
    if (element.firstElementChild) resize.observe(element.firstElementChild);
    return () => {
      element.removeEventListener("scroll", update);
      resize.disconnect();
    };
  }, [container, turns]);
  useEffect(() => {
    const marker = rail.current?.querySelector<HTMLElement>(
      '[aria-current="step"]',
    );
    if (marker && rail.current)
      rail.current.scrollTo({
        top: marker.offsetTop - rail.current.clientHeight / 2,
      });
  }, [active]);
  if (!turns.length) return null;
  const hover = (position: number) => {
    const element = rail.current;
    const index = Math.max(0, Math.min(turns.length - 1, Math.round(position)));
    const button = element?.querySelectorAll("button")[index];
    if (!element || !button) return;
    const rect = button.getBoundingClientRect();
    setHovered({
      position,
      index,
      top: Math.max(8, Math.min(window.innerHeight - 124, rect.top - 35)),
      left: Math.min(window.innerWidth - 296, rect.right + 8),
    });
  };
  const prompt = (turn: Data) =>
    goalContinuationLabel(turn) ??
    (
      (turn.items ?? []).find((i: Data) => i.type === "userMessage")?.content ??
      []
    )
      .filter((p: Data) => p.type === "text")
      .map((p: Data) => p.text)
      .join(" ");
  const preview = hovered == null ? null : turns[hovered.index];
  return (
    <>
      <nav
        className="turn-navigation"
        aria-label="对话轮次"
        ref={rail}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setHovered(null);
            e.stopPropagation();
          }
        }}
        onPointerLeave={() => setHovered(null)}
        onPointerMove={(event) => {
          if (event.pointerType === "touch") return;
          const first = rail.current
            ?.querySelector("button")
            ?.getBoundingClientRect();
          if (first)
            hover(
              (event.clientY - first.top - first.height / 2) / first.height,
            );
        }}
      >
        {turns.map((turn, index) => {
          const text = prompt(turn);
          const label = `第 ${index + 1} 轮${text ? `：${text.slice(0, 80)}` : ""}`;
          return (
            <button
              type="button"
              key={turn.id}
              aria-label={label}
              aria-current={active === turn.id ? "step" : undefined}
              data-running={turn.status === "inProgress"}
              onFocus={() => hover(index)}
              onBlur={() => setHovered(null)}
              aria-describedby={
                hovered?.index === index ? previewId : undefined
              }
              style={
                {
                  "--turn-proximity":
                    hovered == null
                      ? 0
                      : Math.max(
                          0,
                          1 - Math.abs(index - hovered.position) / 3.5,
                        ) ** 2,
                  "--turn-wave-delay":
                    hovered == null
                      ? "0ms"
                      : `${Math.min(4, Math.abs(index - hovered.position)) * 18}ms`,
                } as CSSProperties
              }
              onClick={() => {
                const parent = container.current;
                const section = [
                  ...(parent?.querySelectorAll<HTMLElement>("[data-turn-id]") ??
                    []),
                ].find((item) => item.dataset.turnId === turn.id);
                if (parent && section) {
                  onNavigate();
                  parent.scrollTo({
                    top:
                      section.getBoundingClientRect().top -
                      parent.getBoundingClientRect().top +
                      parent.scrollTop -
                      24,
                    behavior: reducedMotion
                      ? "instant"
                      : "smooth",
                  });
                }
              }}
            >
              <span className="turn-marker" />
            </button>
          );
        })}
      </nav>
      {preview &&
        hovered &&
        createPortal(
          <div
            id={previewId}
            role="tooltip"
            className="turn-preview"
            style={{ top: hovered.top, left: hovered.left }}
          >
            <strong>{prompt(preview) || `第 ${hovered.index + 1} 轮`}</strong>
            <p>
              {(preview.items ?? [])
                .filter((i: Data) => i.type === "agentMessage" && i.text)
                .map((i: Data) => i.text)
                .join(" ").replace(/\s+/g, " ") ||
                ({
                  inProgress: "正在执行…",
                  failed: "本轮执行失败",
                  interrupted: "本轮已停止",
                }[preview.status as string] ??
                  "暂无助手回复")}
            </p>
          </div>,
          document.body,
        )}
    </>
  );
}
