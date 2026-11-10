import assert from "node:assert/strict";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

// A new profile is the identity boundary; never infer ownership from a process name.
export async function findRelaunchedGui({ root, profile, browser, startedAfter, packaged = true }) {
  const canonicalRoot = await realpath(root);
  const canonicalProfile = await realpath(profile);
  const child = relative(canonicalRoot, canonicalProfile);
  assert(child && !child.startsWith("..") && !isAbsolute(child), "profile outside fixture");
  const session = await browser.newBrowserCDPSession();
  let processInfo;
  try {
    processInfo = await session.send("SystemInfo.getProcessInfo");
  } finally {
    await session.detach();
  }
  const browserPids = processInfo.processInfo.filter((process) => process.type === "browser");
  assert.equal(browserPids.length, 1, "CDP must identify exactly one browser process");
  const pid = browserPids[0].id;
  assert(Number.isSafeInteger(pid) && pid > 1);
  const diagnostics = join(canonicalProfile, "diagnostics", "main");
  const entries = await readdir(diagnostics, { withFileTypes: true });
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !uuid.test(entry.name)) continue;
    const path = join(diagnostics, entry.name, "run.json");
    const stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink(), "unsafe startup record");
    const header = JSON.parse(await readFile(path, "utf8"));
    if (
      header.role !== "main" ||
      header.runId !== entry.name ||
      !uuid.test(header.appRunId || "") ||
      !Number.isSafeInteger(header.pid) ||
      header.pid !== pid ||
      header.packaged !== packaged
    )
      continue;
    const recorded = Date.parse(header.startedAt);
    if (!Number.isFinite(recorded) || recorded < startedAfter) continue;
    matches.push({
      pid: header.pid,
      appRunId: header.appRunId,
      runId: header.runId,
      startedAt: header.startedAt,
    });
  }
  assert.equal(
    matches.length,
    1,
    "cannot uniquely identify live GUI from isolated startup records",
  );
  return matches[0];
}

export async function readIsolatedDevTools({ root, profile }) {
  const canonicalRoot = await realpath(root);
  const canonicalProfile = await realpath(profile);
  const child = relative(canonicalRoot, canonicalProfile);
  assert(child && !child.startsWith("..") && !isAbsolute(child), "profile outside fixture");
  const path = join(canonicalProfile, "DevToolsActivePort");
  const stat = await lstat(path);
  assert(stat.isFile() && !stat.isSymbolicLink(), "unsafe DevTools endpoint");
  const [port, browserPath] = (await readFile(path, "utf8")).trim().split("\n");
  assert(/^[0-9]+$/.test(port) && Number(port) > 0 && Number(port) <= 65535);
  assert(/^\/devtools\/browser\/[a-f0-9-]+$/i.test(browserPath || ""));
  return `ws://127.0.0.1:${port}${browserPath}`;
}
