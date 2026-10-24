import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
for (const [prefix, name] of [["assets/", "runtime-manifest.json"], ["assets/vendor/", "manifest.json"]]) {
  const manifest = JSON.parse(await readFile(new URL(prefix + name, import.meta.url), "utf8"));
  for (const [name, entry] of Object.entries(manifest.files ?? Object.fromEntries(manifest.resources.flatMap(resource => [[resource.file, { sha256: resource.sha256 }], [resource.licenseFile, { sha256: resource.licenseSha256 }]])))) {
    const bytes = await readFile(new URL(prefix + name, import.meta.url));
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw Error(`Gen UI asset digest mismatch: ${name}`);
  }
}
await build({ absWorkingDir: root, entryPoints: ["node.ts"], outfile: "dist/node.cjs", bundle: true, platform: "node", format: "cjs", target: "node22" });
await build({ absWorkingDir: root, entryPoints: ["guest.ts"], outfile: "dist/guest.js", bundle: true, platform: "browser", format: "iife", target: "chrome130" });
