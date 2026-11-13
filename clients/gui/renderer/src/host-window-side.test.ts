import { describe, expect, it, vi } from "vite-plus/test";
import type { HostClient } from "@areal/client";
import type { PlatformServices } from "./services.js";
import { desktopWindowCommand, windowSideOwnership } from "./host-workbench.js";
import { closedSidePublisher } from "./host-snapshot.js";

function fixture() {
  let connection: string | undefined = "first";
  let closing!: () => Promise<boolean>;
  let opened!: () => void;
  const workbench = vi.fn(async () => ({
    settled: true,
    connection,
    closed: [] as { projectId: string; threadId: string; requestId: string }[],
  }));
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
  const publishClosed = vi.fn();
  const run = windowSideOwnership(client, desktop, () => true, native, host, publishClosed);
  return {
    run,
    workbench,
    native,
    host,
    publishClosed,
    close: () => closing(),
    open: () => opened(),
    connect: (value: string | undefined) => {
      connection = value;
    },
  };
}

describe("Side window ownership", () => {
  it("projects a confirmed close to its Host project and original request", () => {
    const client = {
      snapshot: () => ({ connection: "ready", identity: { hostId: "host" } }),
    } as unknown as HostClient;
    const outcomes = new Map();
    const publish = vi.fn();
    const target = vi.fn(() => ({ hostProjectId: "host-project" }));
    closedSidePublisher(
      client,
      outcomes,
      target,
      publish,
    )([{ projectId: "project", threadId: "child", requestId: "request" }]);
    expect(target).toHaveBeenCalledWith({
      projectId: "project",
      threadId: "child",
      requestId: "request",
    });
    expect(outcomes.get(JSON.stringify(["host", "host-project"]))["request"]).toEqual({
      method: "areal/side/close",
      threadId: "child",
      accepted: true,
      cleanupConfirmed: true,
    });
    expect(publish).toHaveBeenCalledOnce();
  });
  it("publishes only confirmed closures for the original connection", async () => {
    const f = fixture();
    const closed = [{ projectId: "p", threadId: "child", requestId: "close-id" }];
    await f.run("side", { operation: "create" });
    f.workbench.mockResolvedValueOnce({ settled: true, connection: "first", closed });
    expect(await f.close()).toBe(true);
    expect(f.publishClosed).toHaveBeenCalledWith(closed);
  });
  it("does not publish an unconfirmed close", async () => {
    const f = fixture();
    await f.run("side", { operation: "create" });
    f.workbench.mockRejectedValueOnce(new Error("unknown"));
    expect(await f.close()).toBe(false);
    expect(f.publishClosed).not.toHaveBeenCalled();
  });
  it("uses the current Host source after the projection becomes ready", async () => {
    let sourceId: string | undefined;
    const client = {
      snapshot: () => ({ connection: "ready", identity: { connectionId: "first" } }),
      writable: () => true,
    } as unknown as HostClient;
    const desktop = {} as PlatformServices;
    const host = vi.fn(async () => ({ ok: true as const, value: null }));
    const run = desktopWindowCommand(
      client,
      desktop,
      host,
      () => sourceId,
      () => {},
    );
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
    let release!: (value: { settled: boolean; connection: string; closed: [] }) => void;
    f.workbench.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const closing = f.close();
    f.connect("second");
    release({ settled: true, connection: "first", closed: [] });
    expect(await closing).toBe(false);
    expect(f.publishClosed).not.toHaveBeenCalled();
    expect(await f.close()).toBe(false);
    expect(() => f.run("side", { operation: "create" })).toThrow();
  });
  it("reopens the same owner when a timed-out close later settles", async () => {
    const f = fixture();
    await f.run("side", { operation: "create" });
    let release!: (value: { settled: boolean; connection: string; closed: [] }) => void;
    f.workbench.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const closing = f.close();
    f.open();
    release({ settled: true, connection: "first", closed: [] });
    expect(await closing).toBe(true);
    await vi.waitFor(() => expect(f.workbench).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(() => f.run("side", { operation: "create" })).not.toThrow());
  });
  it("waits for the original owner to reopen before dispatching a create once", async () => {
    const f = fixture();
    await f.run("side", { operation: "create" });
    expect(await f.close()).toBe(true);
    let release!: (value: { settled: boolean; connection: string; closed: [] }) => void;
    f.workbench.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    f.open();
    const create = f.run("side", { operation: "create" });
    expect(f.host).toHaveBeenCalledTimes(1);
    release({ settled: true, connection: "first", closed: [] });
    await create;
    expect(f.host).toHaveBeenCalledTimes(2);
  });
  it("does not dispatch after reopening fails or the connection changes", async () => {
    for (const changed of [false, true]) {
      const f = fixture();
      await f.run("side", { operation: "create" });
      expect(await f.close()).toBe(true);
      let release!: (value: { settled: boolean; connection: string; closed: [] }) => void;
      f.workbench.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      f.open();
      const create = f.run("side", { operation: "create" });
      if (changed) f.connect("second");
      release({ settled: changed, connection: "first", closed: [] });
      await expect(create).rejects.toThrow();
      expect(f.host).toHaveBeenCalledTimes(1);
    }
  });
  it("does not dispatch a waiting create after another close begins", async () => {
    const f = fixture();
    await f.run("side", { operation: "create" });
    expect(await f.close()).toBe(true);
    let release!: (value: { settled: boolean; connection: string; closed: [] }) => void;
    f.workbench.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    f.open();
    const create = f.run("side", { operation: "create" });
    const closing = f.close();
    release({ settled: true, connection: "first", closed: [] });
    await expect(create).rejects.toThrow();
    await closing;
    expect(f.host).toHaveBeenCalledTimes(1);
  });
});
