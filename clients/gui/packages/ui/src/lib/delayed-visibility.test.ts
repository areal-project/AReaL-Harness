import { describe, expect, it } from "vite-plus/test";
import {
  hiddenVisibility,
  stepDelayedVisibility,
  type DelayedVisibility,
} from "./delayed-visibility.js";

function run(steps: ReadonlyArray<readonly [active: boolean, now: number]>) {
  let state: DelayedVisibility = hiddenVisibility;
  return steps.map(([active, now]) => {
    state = stepDelayedVisibility(state, active, now);
    return state.shown;
  });
}

describe("delayed loading visibility", () => {
  it("never shows a load that finishes before the show delay", () => {
    expect(
      run([
        [true, 0],
        [true, 150],
        [false, 150],
        [false, 1000],
      ]),
    ).toEqual([false, false, false, false]);
  });

  it("shows a slow load and keeps it for the minimum time after it finishes", () => {
    expect(
      run([
        [true, 0],
        [true, 400],
        [false, 450],
        [false, 799],
        [false, 800],
      ]),
    ).toEqual([false, true, true, true, false]);
  });

  it("restarts the delay when a cancelled load starts again", () => {
    expect(
      run([
        [true, 0],
        [false, 300],
        [true, 350],
        [true, 700],
        [true, 750],
      ]),
    ).toEqual([false, false, false, false, true]);
  });

  it("returns the same state when nothing changes so render-time stepping settles", () => {
    const pending = stepDelayedVisibility(hiddenVisibility, true, 0);
    expect(stepDelayedVisibility(pending, true, 100)).toBe(pending);
    expect(stepDelayedVisibility(hiddenVisibility, false, 100)).toBe(hiddenVisibility);
  });
});
