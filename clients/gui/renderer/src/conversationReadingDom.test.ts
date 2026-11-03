import { expect, test } from "vite-plus/test";
import { firstTurnBelow, lastTurnAbove } from "./conversationReadingDom.js";

const turns = (...ranges: [number, number][]) =>
  ranges.map(
    ([top, bottom]) => ({ getBoundingClientRect: () => ({ top, bottom }) }) as HTMLElement,
  );

test("turn lookups bisect vertically ordered sections", () => {
  const sections = turns([0, 100], [120, 300], [320, 900], [920, 1000]);
  expect(firstTurnBelow(sections, -10)).toBe(0);
  expect(firstTurnBelow(sections, 100)).toBe(1);
  expect(firstTurnBelow(sections, 500)).toBe(2);
  expect(firstTurnBelow(sections, 2000)).toBe(4);
  expect(lastTurnAbove(sections, -10)).toBe(-1);
  expect(lastTurnAbove(sections, 120)).toBe(1);
  expect(lastTurnAbove(sections, 500)).toBe(2);
  expect(lastTurnAbove(sections, 2000)).toBe(3);
});
