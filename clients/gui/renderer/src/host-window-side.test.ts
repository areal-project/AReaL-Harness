import { describe, expect, it, vi } from "vite-plus/test";
import type { HostClient } from "@areal/client";
import type { PlatformServices } from "./services.js";
import { desktopWindowCommand, windowSideOwnership } from "./host-workbench.js";

function fixture() {
  let connection: string | undefined = "first";
  let closing!: () => Promise<boolean>;
  let opened!: () => void;
  const workbench = vi.fn(async () => ({ settled: true, connection }));
  const client = {
    snapshot: () =>
      connection
        ? { connection: "ready", identity: { connectionId: connection } }
        : { connection: "offline" },
    workbench,
  } as unknown as HostClient;
  const desktop = {
    onWindowClosing: (listener: () => Promise<boolean>) => {
      closing = listener;
      return () => {};
    },
    onWindowOpened: (listener: () => void) => {
      opened = listener;
      return () => {};
    },
  } as unknown as PlatformServices;
  const native = vi.fn(async () => ({ ok: true as const, value: null }));
  const host = vi.fn(async () => ({ ok: true as const, value: null }));
  const run = windowSideOwnership(client, desktop, () => true, native, host);
  return {
    run,
    workbench,
    native,
    host,
    close: () => closing(),
    open: () => opened(),
    connect: (value: string | undefined) => {
      connection = value;
    },
  };
}

describe("Side window ownership", () => {
  it("uses the current Host source after the projection becomes ready", async () => {
    let sourceId: string | undefined;
    const client = {
      snapshot: () => ({ connection: "ready", identity: { connectionId: "first" } }),
      writable: () => true,
    } as unknown as HostClient;
    const desktop = {} as PlatformServices;
    const host = vi.fn(async () => ({ ok: true as const, value: null }));
    const run = desktopWindowCommand(client, desktop, host, () => sourceId);
    expect(() => run("side", { operation: "create" })).toThrow();
    expect(host).not.toHaveBeenCalled();
    sourceId = "source";
    await run("side", { operation: "create" });
    expect(host).toHaveBeenCalledOnce();
  });
  it("allows an offline empty window to close and fences creation until reopened", async () => {
    const f = fixture();
    f.connect(undefined);
    expect(await f.close()).toBe(true);
    f.connect("first");
    expect(() => f.run("side", { operation: "create" })).toThrow();
    f.open();
    await f.run("side", { operation: "create" });
    expect(f.host).toHaveBeenCalledOnce();
    expect(f.native).not.toHaveBeenCalled();
  });
  it("does not accept a close receipt after the connection changes", async () => {
    const f = fixture();
    await f.run("side", { operation: "create" });
    let release!: (value: { settled: boolean; connection: string }) => void;
    f.workbench.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const closing = f.close();
    f.connect("second");
    release({ settled: true, connection: "first" });
    expect(await closing).toBe(false);
    expect(await f.close()).toBe(false);
    expect(() => f.run("side", { operation: "create" })).toThrow();
  });
  it("reopens the same owner when a timed-out close later settles", async () => {
    const f = fixture();
    await f.run("side", { operation: "create" });
    let release!: (value: { settled: boolean; connection: string }) => void;
    f.workbench.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const closing = f.close();
    f.open();
    release({ settled: true, connection: "first" });
    expect(await closing).toBe(true);
    await vi.waitFor(() => expect(f.workbench).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(() => f.run("side", { operation: "create" })).not.toThrow());
  });
});
