import { expect, test, vi } from "vite-plus/test";
import { createScheduleEditorLoader, type ScheduleEditorState } from "./schedule-editor-loader.js";

const deferred = () => {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test("explicit editing loads once, reports loading, and reopens cached code", async () => {
  const request = deferred(),
    publish = vi.fn(),
    load = vi.fn(() => request.promise);
  const loader = createScheduleEditorLoader(load, publish);
  expect(load).not.toHaveBeenCalled();
  const first = loader.open();
  await loader.open();
  expect(load).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenLastCalledWith({
    editor: null,
    loading: true,
    error: "",
    editing: false,
  });
  request.resolve("editor");
  await first;
  expect(publish).toHaveBeenLastCalledWith({
    editor: "editor",
    loading: false,
    error: "",
    editing: true,
  });
  loader.reset();
  await loader.open();
  expect(load).toHaveBeenCalledTimes(1);
  expect(publish.mock.lastCall?.[0].editing).toBe(true);
});

test("failed loading exposes the error and an explicit retry can succeed", async () => {
  const load = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce("editor");
  const publish = vi.fn();
  const loader = createScheduleEditorLoader(load, publish);
  await loader.open();
  expect(publish).toHaveBeenLastCalledWith({
    editor: null,
    loading: false,
    error: "offline",
    editing: false,
  });
  expect(load).toHaveBeenCalledTimes(1);
  await loader.open();
  expect(load).toHaveBeenCalledTimes(2);
  expect(publish.mock.lastCall?.[0]).toEqual({
    editor: "editor",
    loading: false,
    error: "",
    editing: true,
  });
});

for (const method of ["reset", "invalidate"] as const) {
  test(`${method} prevents stale success and failure from opening a different or unmounted task`, async () => {
    for (const fail of [false, true]) {
      const old = deferred(),
        current = deferred();
      const publish = vi.fn<(state: ScheduleEditorState<string>) => void>();
      const load = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
      const loader = createScheduleEditorLoader<string>(load, publish);
      const first = loader.open();
      loader[method]();
      const second = loader.open();
      const before = publish.mock.calls.length;
      if (fail) old.reject(new Error("stale"));
      else old.resolve("stale");
      await first;
      expect(publish).toHaveBeenCalledTimes(before);
      await loader.open();
      expect(load).toHaveBeenCalledTimes(2);
      current.resolve("current");
      await second;
      expect(publish.mock.lastCall?.[0]).toEqual({
        editor: "current",
        loading: false,
        error: "",
        editing: true,
      });
    }
  });
}
