/**
 * Workspace file listing for the panel's file tree.
 *
 * The tree is lazy: the panel asks for one directory at a time, so a huge
 * repository costs nothing until someone actually expands into it.
 *
 * Every request is confined to the workspace root. Paths are resolved through
 * realpath before the check, so a symlink inside the workspace cannot be used
 * to read somewhere else.
 */

import { readdir, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

// A directory with more entries than this is almost always machine-generated;
// listing all of it would stall the panel for no human benefit.
const MAX_ENTRIES = 1000;

// Skipped by default: huge, uninteresting, and usually what people are trying
// to look past. The panel can ask for them explicitly with `showAll`.
const NOISE = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "target",
  "__pycache__",
  ".venv",
  ".DS_Store",
]);

/** Resolve `rel` under `root`, refusing anything that escapes it. */
async function resolveInside(root, rel) {
  const realRoot = await realpath(root);
  const candidate = resolve(realRoot, rel || ".");
  let real;
  try {
    real = await realpath(candidate);
  } catch {
    return null; // missing path — treated the same as a rejected one
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
  return real;
}

/**
 * List one directory.
 *
 * @param {string} root  workspace root; nothing outside it is ever returned
 * @param {string} rel   directory to list, relative to root
 * @param {{showAll?: boolean}} [options]
 * @returns {Promise<{path: string, entries: Array, truncated: boolean, total: number}|null>}
 *          null when the path is missing or outside the workspace
 */
export async function listDirectory(root, rel, options = {}) {
  const dir = await resolveInside(root, rel);
  if (dir === null) return null;

  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  const showAll = options.showAll === true;
  const visible = dirents.filter((d) => {
    if (showAll) return !d.name.startsWith(".DS_Store");
    return !NOISE.has(d.name);
  });

  const truncated = visible.length > MAX_ENTRIES;
  const slice = visible.slice(0, MAX_ENTRIES);

  const entries = await Promise.all(
    slice.map(async (d) => {
      // A symlink reports as neither file nor directory; stat through it so
      // linked folders still expand, but keep the traversal inside the root.
      let isDir = d.isDirectory();
      let size = 0;
      const full = join(dir, d.name);
      if (d.isSymbolicLink()) {
        const target = await resolveInside(root, full);
        if (target === null) return null; // link points outside — hide it
        try {
          const st = await stat(full);
          isDir = st.isDirectory();
          size = st.size;
        } catch {
          return null;
        }
      } else if (!isDir) {
        try {
          size = (await stat(full)).size;
        } catch {
          /* raced with a delete — size stays 0 */
        }
      }
      return { name: d.name, dir: isDir, size, hidden: d.name.startsWith(".") };
    }),
  );

  const rows = entries.filter(Boolean).sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1; // directories first
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });

  return { path: rel || "", entries: rows, truncated, total: visible.length };
}

/** Bounded workspace search. Reuses the same realpath boundary as lazy listing. */
export async function searchFiles(root, query) {
  if (typeof query !== "string" || !query.trim() || query.length > 256) throw new Error("无效文件搜索");
  const needle = query.trim().toLocaleLowerCase();
  const queue = [""];
  const visited = new Set();
  const entries = [];
  let truncated = false;
  while (queue.length && visited.size < 2000 && entries.length < 500) {
    const rel = queue.shift();
    const real = await resolveInside(root, rel);
    if (!real || visited.has(real)) continue;
    visited.add(real);
    const listing = await listDirectory(root, rel);
    if (!listing) continue;
    truncated ||= listing.truncated;
    for (const item of listing.entries) {
      const path = rel ? `${rel}/${item.name}` : item.name;
      if (path.toLocaleLowerCase().includes(needle)) entries.push({ path, dir: item.dir });
      if (item.dir) queue.push(path);
      if (entries.length >= 500) { truncated = true; break; }
    }
  }
  return { entries, truncated: truncated || queue.length > 0 };
}
