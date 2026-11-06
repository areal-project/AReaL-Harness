import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { observeResize } from "@areal/ui/observe-resize";
import type { McpAppPlacement } from "./McpAppHost.js";
import { genUiSourceKey, type GenUiDescriptor, type GenUiSource } from "./mcp-app-services.js";
import type { PlatformServices } from "./services.js";
import { Textarea } from "./components/ui/textarea.js";
import { Button } from "./components/ui/button.js";
import { useI18n } from "./i18n/IntlProvider.js";

type Binding = { element: HTMLDivElement; send?: (prompt: string) => Promise<void>; dark: boolean };
type Confirmation = { prompt: string; resolve: () => void; reject: (error: Error) => void };
export type Entry = {
  source: GenUiSource;
  title: string;
  phase: "idle" | "opening" | "open" | "closed" | "error";
  app?: GenUiDescriptor;
  binding?: Binding;
  placement: McpAppPlacement | null;
  clip?: string;
  height: number;
  error?: string;
  pending?: Confirmation;
  sending?: boolean;
};
export type Owner = {
  services: PlatformServices;
  entries: Map<string, Entry>;
  changed(): void;
  acquire(entry: Entry): Promise<void>;
  close(entry: Entry): void;
  visible(entry: Entry): boolean;
  confirm(entry: Entry, prompt: string): Promise<void>;
};
const GenUiHost = lazy(() =>
  import("./GenUiHost.js").then(({ GenUiHost }) => ({ default: GenUiHost })),
);
const Context = createContext<{ owner: Owner; revision: number } | null>(null);
export function currentEntry(owner: Owner, entry: Entry) {
  if (
    owner.entries.get(genUiSourceKey(entry.source)) !== entry ||
    !entry.binding?.element.isConnected ||
    !entry.placement
  )
    throw Error("Generated answer is no longer visible");
}
export function GenUiWorkspace({
  services,
  children,
}: {
  services: PlatformServices;
  children: ReactNode;
}) {
  const [revision, changed] = useState(0);
  const owner = useMemo<Owner>(
    () => ({
      services,
      entries: new Map(),
      changed: () => changed((value) => value + 1),
      visible: (entry) => !!entry.binding?.element.isConnected && !!entry.placement,
      async acquire(entry) {
        if (!services.mcpApp || entry.phase === "opening" || entry.app) return;
        entry.phase = "opening";
        entry.error = undefined;
        this.changed();
        try {
          const app = await services.mcpApp({ operation: "openGenUi", ...entry.source });
          if (this.entries.get(genUiSourceKey(entry.source)) !== entry) {
            await services.mcpApp({ operation: "close", token: app.token });
            return;
          }
          entry.app = app;
          entry.phase = "open";
          await services.mcpApp({
            operation: "genUiVisibility",
            token: app.token,
            visible: this.visible(entry),
          });
        } catch {
          entry.phase = "error";
          entry.error = "unavailable";
        }
        this.changed();
      },
      close(entry) {
        entry.pending?.reject(Error("Generated answer closed"));
        entry.pending = undefined;
        if (entry.app)
          void services.mcpApp?.({ operation: "close", token: entry.app.token }).catch(() => {});
        entry.app = undefined;
        entry.phase = "closed";
        this.changed();
      },
      async confirm(entry, prompt) {
        currentEntry(this, entry);
        if (!entry.binding?.send || entry.app?.readOnly || entry.pending || entry.sending)
          throw Error("Conversation cannot submit this request");
        await new Promise<void>((resolve, reject) => {
          entry.pending = { prompt, resolve, reject };
          this.changed();
        });
      },
    }),
    [services],
  );
  useEffect(
    () => () => {
      for (const entry of owner.entries.values()) owner.close(entry);
      owner.entries.clear();
    },
    [owner],
  );
  return (
    <Context.Provider value={{ owner, revision }}>
      {children}
      <Suspense fallback={null}>
        {[...owner.entries].map(
          ([, entry]) =>
            entry.app && <GenUiHost key={entry.app.token} owner={owner} entry={entry} />,
        )}
      </Suspense>
    </Context.Provider>
  );
}
export function GenUiCard({
  source,
  title,
  send,
  dark,
}: {
  source: GenUiSource;
  title: string;
  send?: (prompt: string) => Promise<void>;
  dark: boolean;
}) {
  const context = useContext(Context),
    slot = useRef<HTMLDivElement>(null),
    { t } = useI18n();
  const key = genUiSourceKey(source),
    owner = context?.owner;
  const binding = useRef({ send, dark });
  binding.current = { send, dark };
  const entry = owner?.entries.get(key);
  useLayoutEffect(() => {
    if (!owner || !slot.current) return;
    let entry = owner.entries.get(key);
    if (!entry) {
      entry = { source, title, phase: "idle", placement: null, height: 320 };
      owner.entries.set(key, entry);
    }
    const current = entry;
    current.binding = { element: slot.current, ...binding.current };
    const measure = () => {
      if (!current.binding) return;
      const element = current.binding.element,
        rect = element.getBoundingClientRect();
      let top = Math.max(0, rect.top),
        bottom = Math.min(innerHeight, rect.bottom),
        left = Math.max(0, rect.left),
        right = Math.min(innerWidth, rect.right);
      let shown = element.isConnected && getComputedStyle(element).visibility !== "hidden";
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent),
          bounds = parent.getBoundingClientRect();
        if (style.display === "none" || parent.hidden || parent.inert) shown = false;
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          top = Math.max(top, bounds.top);
          bottom = Math.min(bottom, bounds.bottom);
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          left = Math.max(left, bounds.left);
          right = Math.min(right, bounds.right);
        }
      }
      const placement =
        shown && bottom > top && right > left
          ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
          : null;
      const visibilityChanged = !!placement !== !!current.placement;
      const clip = `inset(${Math.max(0, top - rect.top)}px ${Math.max(0, rect.right - right)}px ${Math.max(0, rect.bottom - bottom)}px ${Math.max(0, left - rect.left)}px)`;
      if (
        JSON.stringify(placement) !== JSON.stringify(current.placement) ||
        clip !== current.clip
      ) {
        current.placement = placement;
        current.clip = clip;
        owner.changed();
      }
      if (!placement && current.pending) {
        current.pending.reject(Error("Generated answer hidden"));
        current.pending = undefined;
        owner.changed();
      }
      if (visibilityChanged && current.app)
        void owner.services
          .mcpApp?.({
            operation: "genUiVisibility",
            token: current.app.token,
            visible: !!placement,
          })
          .catch(() => {});
      if (placement && current.phase === "idle") void owner.acquire(current);
    };
    const targets: HTMLElement[] = [];
    for (let element: HTMLElement | null = slot.current; element; element = element.parentElement)
      targets.push(element);
    const stopResize = observeResize(targets, measure);
    const intersection = new IntersectionObserver(measure);
    intersection.observe(slot.current);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    measure();
    owner.changed();
    return () => {
      stopResize();
      intersection.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      current.pending?.reject(Error("Generated answer detached"));
      current.pending = undefined;
      current.binding = undefined;
      current.placement = null;
      if (current.app)
        void owner.services
          .mcpApp?.({
            operation: "genUiVisibility",
            token: current.app.token,
            visible: false,
          })
          .catch(() => {});
      else if (current.phase !== "opening") owner.entries.delete(key);
      owner.changed();
    };
  }, [owner, key]);
  useLayoutEffect(() => {
    if (entry?.binding) {
      const themeChanged = entry.binding.dark !== dark;
      entry.binding.send = send;
      entry.binding.dark = dark;
      if (themeChanged) owner?.changed();
    }
  }, [owner, entry, send, dark]);
  const confirm = useCallback(async () => {
    if (!owner || !entry?.pending || entry.sending) return;
    const pending = entry.pending;
    try {
      currentEntry(owner, entry);
      const submit = entry.binding?.send;
      if (!submit || !pending.prompt.trim()) throw Error("Conversation is not available");
      entry.sending = true;
      owner.changed();
      await submit(pending.prompt.trim());
      pending.resolve();
      entry.pending = undefined;
    } catch (error) {
      pending.reject(error instanceof Error ? error : Error(String(error)));
      entry.pending = undefined;
      entry.error = "submission";
    } finally {
      entry.sending = false;
      owner.changed();
    }
  }, [owner, entry]);
  if (!owner?.services.mcpApp) return <p role="status">{t("genUi.unavailable")}</p>;
  return (
    <section data-testid="gen-ui-card" className="gen-ui-card" aria-label={title}>
      <header className="utility-actions">
        <span>{title}</span>
        {entry?.app && (
          <Button variant="ghost" size="sm" onClick={() => owner.close(entry)}>
            {t("genUi.close")}
          </Button>
        )}
      </header>
      <div ref={slot} style={{ height: entry?.height ?? 320, minWidth: 0 }} />
      {entry?.phase === "opening" && <p role="status">{t("genUi.loading")}</p>}
      {(entry?.phase === "closed" || entry?.phase === "error") && (
        <Button variant="secondary" size="sm" onClick={() => void owner.acquire(entry)}>
          {t("genUi.reopen")}
        </Button>
      )}
      {entry?.error && (
        <p role="status">
          {t(entry.error === "submission" ? "genUi.submission" : "genUi.unavailable")}
        </p>
      )}
      {entry?.pending && (
        <div className="gen-ui-confirmation">
          <label>
            {t("genUi.confirm")}
            <Textarea
              data-testid="gen-ui-confirm-input"
              value={entry.pending.prompt}
              disabled={entry.sending}
              onChange={(event) => {
                if (entry.pending) {
                  entry.pending.prompt = event.target.value;
                  owner.changed();
                }
              }}
            />
          </label>
          <div className="utility-actions">
            <Button
              data-testid="gen-ui-confirm-send"
              disabled={entry.sending || !send || !entry.pending.prompt.trim()}
              onClick={() => void confirm()}
            >
              {t("genUi.send")}
            </Button>
            <Button
              variant="ghost"
              disabled={entry.sending}
              onClick={() => {
                entry.pending?.reject(Error("Cancelled"));
                entry.pending = undefined;
                owner.changed();
              }}
            >
              {t("genUi.cancel")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
