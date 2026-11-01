// Adapted from T3 Code. MIT, Copyright (c) 2026 T3 Tools Inc.

import * as NodeChildProcess from "node:child_process";

/** id is CGWindowNumber on macOS or HWND on Windows, matching the capture backend. */
export type ActiveWindow = {
  readonly platform: "macos" | "windows";
  readonly id: number;
  readonly title: string;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly owner: {
    readonly name: string;
    readonly processId: number;
    readonly path: string;
    readonly bundleId?: string;
  };
};

const MAC_LOOKUP_TIMEOUT_MS = 5_000;

const MAC_LOOKUP_SCRIPT = `
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
function run() {
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (app.isNil()) return "";
  const pid = app.processIdentifier;
  const list = $.CGWindowListCopyWindowInfo(
    $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements,
    $.kCGNullWindowID,
  );
  $.CFMakeCollectable(list);
  const count = $.CFArrayGetCount(list);
  for (let i = 0; i < count; i++) {
    const w = ObjC.castRefToObject($.CFArrayGetValueAtIndex(list, i));
    if (w.objectForKey("kCGWindowOwnerPID").js !== pid) continue;
    if (w.objectForKey("kCGWindowLayer").js !== 0) continue;
    const b = ObjC.deepUnwrap(w.objectForKey("kCGWindowBounds"));
    return JSON.stringify({
      id: w.objectForKey("kCGWindowNumber").js,
      title: String(ObjC.unwrap(w.objectForKey("kCGWindowName")) || ""),
      bounds: { x: b.X, y: b.Y, width: b.Width, height: b.Height },
      owner: {
        name: String(app.localizedName.js || ObjC.unwrap(w.objectForKey("kCGWindowOwnerName")) || ""),
        processId: pid,
        path: String(app.bundleURL.path.js || ""),
        bundleId: String(app.bundleIdentifier.js || ""),
      },
    });
  }
  return "";
}`;

function runMacLookup(): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", MAC_LOOKUP_SCRIPT],
      { timeout: MAC_LOOKUP_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

async function macActiveWindow(): Promise<ActiveWindow | undefined> {
  const output = (await runMacLookup()).trim();
  if (!output) return undefined;
  const window: unknown = JSON.parse(output);
  if (
    !window ||
    typeof window !== "object" ||
    !("id" in window) ||
    !("bounds" in window) ||
    !("owner" in window)
  )
    throw new Error("Invalid foreground window");
  const value = window as ActiveWindow;
  if (
    !Number.isSafeInteger(value.id) ||
    value.id <= 0 ||
    typeof value.title !== "string" ||
    !value.bounds ||
    !["x", "y", "width", "height"].every((key) =>
      Number.isFinite(value.bounds[key as keyof typeof value.bounds]),
    ) ||
    value.bounds.width <= 0 ||
    value.bounds.height <= 0 ||
    !value.owner ||
    !Number.isSafeInteger(value.owner.processId) ||
    typeof value.owner.name !== "string" ||
    typeof value.owner.path !== "string" ||
    typeof value.owner.bundleId !== "string"
  )
    throw new Error("Invalid foreground window");
  return {
    platform: "macos",
    id: value.id,
    title: value.title,
    bounds: value.bounds,
    owner: {
      name: value.owner.name,
      processId: value.owner.processId,
      path: value.owner.path,
      ...(value.owner.bundleId ? { bundleId: value.owner.bundleId } : {}),
    },
  };
}

export const activeWindow = macActiveWindow;
