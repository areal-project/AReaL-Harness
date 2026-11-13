import { describe, expect, it, vi } from "vite-plus/test";
import { call, type PlatformServices } from "./services.js";

describe("platform command validation", () => {
  it("rejects invalid input before dispatch after loading the command schema", async () => {
    const command = vi.fn();
    const services = { command } as unknown as PlatformServices;
    await expect(
      call(services, "library", {
        operation: "renameThread",
        projectId: "project",
        threadId: "thread",
        title: 42,
      } as never),
    ).rejects.toMatchObject({ code: "INVALID_DESKTOP_REQUEST" });
    expect(command).not.toHaveBeenCalled();
  });

  it("rejects an invalid response before returning the command result", async () => {
    const command = vi.fn(async () => ({ ok: true, value: 42 }));
    const services = { command } as unknown as PlatformServices;
    await expect(call(services, "list", { projectId: "project" })).rejects.toThrow();
    expect(command).toHaveBeenCalledOnce();
  });
});
