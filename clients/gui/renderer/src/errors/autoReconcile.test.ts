import { describe, expect, it, vi } from "vite-plus/test";
import { scheduleReconcile } from "./autoReconcile";

describe("scheduleReconcile", () => {
  it("checks a fixed number of times, then gives up once", async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockRejectedValue(new Error("offline"));
    const giveUp = vi.fn();
    scheduleReconcile(run, giveUp, [10, 20]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(giveUp).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(giveUp).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("stops checking once the result is known", async () => {
    vi.useFakeTimers();
    const giveUp = vi.fn();
    let stop = () => {};
    const run = vi.fn(() => stop());
    stop = scheduleReconcile(run, giveUp, [10, 20, 30]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(giveUp).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
