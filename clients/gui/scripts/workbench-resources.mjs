// 打包工作台服务：只带 src 下的 .cjs 与 package.json，并写入 bundle.json 清单供 Host 校验。
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** @param {{source:string,destination:string}} options */
export async function buildWorkbenchResources({ source, destination }) {
  /** @type {Map<string,Buffer>} */
  const files = new Map();
  async function tree(root, prefix) {
    for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.isDirectory()) await tree(join(root, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isFile() && entry.name.endsWith(".cjs"))
        files.set(`${prefix}${entry.name}`, await readFile(join(root, entry.name)));
      else if (!entry.isFile()) throw new Error("工作台服务资源不能包含符号链接");
    }
  }
  await tree(join(source, "src"), "src/");
  files.set("package.json", await readFile(join(source, "package.json")));
  const manifest = [...files]
    .map(([path, bytes]) => ({ path, sha256: digest(bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const version = digest(JSON.stringify(manifest));
  files.set(
    "bundle.json",
    Buffer.from(JSON.stringify({ version, files: manifest }, null, 2) + "\n"),
  );
  await mkdir(destination, { mode: 0o700 });
  for (const [path, bytes] of files) {
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  }
  return { bundleDir: destination, version };
}
