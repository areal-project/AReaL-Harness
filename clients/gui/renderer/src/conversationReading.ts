import type { ReadingAnchor } from "./readingViews.js";

const disclosures = new Map<string, boolean>();
const disclosureKey = "areal-gui:reading-disclosures:v1";
const disclosureLimit = 512;
const disclosureSize = 64 * 1024;
let disclosuresHydrated = false;
function hydrateDisclosures() {
  if (disclosuresHydrated) return;
  disclosuresHydrated = true;
  try {
    const raw = window.sessionStorage.getItem(disclosureKey);
    if (!raw || raw.length > disclosureSize) return;
    const saved: unknown = JSON.parse(raw);
    if (!Array.isArray(saved) || saved.length > disclosureLimit) return;
    for (const entry of saved) {
      if (
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "boolean"
      )
        disclosures.set(entry[0], entry[1]);
    }
  } catch {}
}
export function readingDisclosure(key: string) {
  hydrateDisclosures();
  return disclosures.get(key);
}
export function rememberDisclosure(key: string, open: boolean) {
  hydrateDisclosures();
  disclosures.delete(key);
  disclosures.set(key, open);
  if (disclosures.size > disclosureLimit) disclosures.delete(disclosures.keys().next().value!);
  try {
    const entries: string[] = [];
    let characters = 2;
    for (const entry of [...disclosures].reverse()) {
      const serialized = JSON.stringify(entry);
      const added = serialized.length + (entries.length ? 1 : 0);
      if (characters + added > disclosureSize) continue;
      entries.unshift(serialized);
      characters += added;
    }
    window.sessionStorage.setItem(disclosureKey, `[${entries.join(",")}]`);
  } catch {}
}

type ReadingIdentity = { owner: string; generation: string; revision: number };
export type ReadingBlock = "missing" | "limited" | "unsupported" | "layout" | "cancelled";
type ReadingIntent =
  | { kind: "following"; target?: { kind: "turnStart"; turnId: string } }
  | {
      kind: "holding";
      anchor?: ReadingAnchor;
      disclosure?: { control: HTMLElement; offset: number };
    }
  | { kind: "restoring"; anchor: ReadingAnchor; phase: "loading" | "ready"; attempts: number }
  | { kind: "blocked"; anchor: ReadingAnchor; reason: ReadingBlock };
export type ReadingState = ReadingIdentity & ReadingIntent;
export function createReadingState(owner: string, generation: string): ReadingState {
  return { owner, generation, revision: 0, kind: "following" };
}
export function changeReadingIntent(state: ReadingState, intent: ReadingIntent): ReadingState {
  return {
    owner: state.owner,
    generation: state.generation,
    revision: state.revision + 1,
    ...intent,
  };
}
export function beginReadingRestore(
  state: ReadingState,
  anchor: ReadingAnchor,
): ReadingState & { kind: "restoring" } {
  return {
    owner: state.owner,
    generation: state.generation,
    revision: state.revision + 1,
    kind: "restoring",
    anchor,
    phase: "loading",
    attempts: 0,
  };
}
export function settleReadingRestore(
  state: ReadingState,
  request: ReadingIdentity,
  result: "ready" | ReadingBlock,
): ReadingState {
  if (
    state.kind !== "restoring" ||
    state.owner !== request.owner ||
    state.generation !== request.generation ||
    state.revision !== request.revision
  )
    return state;
  return result === "ready"
    ? { ...state, phase: "ready" }
    : {
        owner: state.owner,
        generation: state.generation,
        revision: state.revision,
        kind: "blocked",
        anchor: state.anchor,
        reason: result,
      };
}
