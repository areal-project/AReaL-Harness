import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const assets = fileURLToPath(new URL("../app/assets/", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function checkIcon(directory = assets) {
  const manifest = JSON.parse(await readFile(join(directory, "icon.json"), "utf8"));
  const source = await readFile(join(directory, "icon-1024.png"));
  const icon = await readFile(join(directory, "icon.icns"));
  assert.equal(
    digest(source),
    manifest.sourceSha256,
    "App icon source changed; run pnpm --dir clients/gui icon:generate on native macOS",
  );
  assert.equal(
    digest(icon),
    manifest.iconSha256,
    "App icon changed; run pnpm --dir clients/gui icon:generate on native macOS",
  );
  assert.equal(icon.subarray(0, 4).toString(), "icns", "Invalid macOS icon");
  return join(directory, "icon.icns");
}

async function generate() {
  assert.equal(process.platform, "darwin", "Icon generation requires native macOS");
  const temporary = await mkdtemp(join(tmpdir(), "areal-icon-"));
  try {
    const iconset = join(temporary, "app.iconset");
    await mkdir(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        execFileSync(
          "/usr/bin/sips",
          [
            "-z",
            String(size * scale),
            String(size * scale),
            join(assets, "icon-1024.png"),
            "--out",
            join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
          ],
          { stdio: "ignore" },
        );
      }
    }
    const output = join(temporary, "icon.icns");
    execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", output], { stdio: "inherit" });
    const source = await readFile(join(assets, "icon-1024.png"));
    const icon = await readFile(output);
    await writeFile(join(assets, "icon.icns"), icon);
    await writeFile(
      join(assets, "icon.json"),
      JSON.stringify({ sourceSha256: digest(source), iconSha256: digest(icon) }) + "\n",
    );
    await checkIcon();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await generate();
