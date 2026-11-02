interface ObservedAnimation {
  element: Element & ElementCSSInlineStyle;
  intersecting: boolean;
}

const animations = new Map<Element, ObservedAnimation>();
let observer: IntersectionObserver | null = null;

function update(animation: ObservedAnimation) {
  const running = animation.intersecting && document.visibilityState === "visible";
  animation.element.style.setProperty("--visible-animation-state", running ? "running" : "paused");
}

function updateAll() {
  for (const animation of animations.values()) update(animation);
}

/**
 * 常驻动画只在元素可见且窗口在前台时播放，屏外或后台时暂停，避免长列表里不可见的转圈持续占用合成器。
 * 作为 React 19 ref 回调使用，返回值在卸载时清理。CSS 侧读取 --visible-animation-state。
 */
export function observeVisibleAnimation(element: (Element & ElementCSSInlineStyle) | null) {
  if (element === null) return;
  if (typeof IntersectionObserver === "undefined") {
    element.style.setProperty("--visible-animation-state", "running");
    return;
  }
  if (observer === null) {
    document.addEventListener("visibilitychange", updateAll);
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const animation = animations.get(entry.target);
        if (!animation) continue;
        animation.intersecting = entry.isIntersecting;
        update(animation);
      }
    });
  }
  const animation = { element, intersecting: false };
  update(animation);
  animations.set(element, animation);
  observer.observe(element);
  return () => {
    if (animations.get(element) !== animation) return;
    animations.delete(element);
    observer?.unobserve(element);
    if (animations.size > 0) return;
    observer?.disconnect();
    observer = null;
    document.removeEventListener("visibilitychange", updateAll);
  };
}
