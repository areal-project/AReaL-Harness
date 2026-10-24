// 组件成熟度守卫：stable / experimental 必须反映真实使用，而不是停留在初始标签。
// 规则（design/components/README.md#成熟度）：
// - core 层组件在 ≥3 个生产文件中使用，就应进入稳定入口 @areal/ui；
//   暂不升级时在合同 front matter 写 `hold: <原因>`，原因会出现在审计输出中。
// - 领域层（conversation/settings/workbench/worktree）保持 @areal/ui/wip，不受此规则约束。
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";

export const STABLE_THRESHOLD = 3;
const gui = fileURLToPath(new URL("../", import.meta.url));
const ui = resolve(gui, "packages/ui/src");
const renderer = resolve(gui, "renderer/src");

async function components() {
  const out = [];
  for (const file of (await readdir(ui, { recursive: true })).filter(file => file.endsWith(".md") && !file.startsWith("generated/"))) {
    const front = (await readFile(resolve(ui, file), "utf8")).match(/^---\n([\s\S]+?)\n---\n/);
    const data = Object.fromEntries(front[1].split("\n").map(line => line.split(/: (.*)/s).slice(0, 2)));
    out.push({ id: data.id, layer: data.layer, status: data.status, hold: data.hold, exports: data.exports ? JSON.parse(data.exports) : [data.title] });
  }
  return out;
}

// 生产消费者：renderer/src 中除设计站外、直接或经 components/ui 转接文件导入该组件的文件。
async function consumers(list) {
  const files = (await readdir(renderer, { recursive: true })).filter(file => /\.tsx?$/.test(file) && !file.startsWith("design-system/"));
  const sources = new Map(await Promise.all(files.map(async file => [file, await readFile(resolve(renderer, file), "utf8")])));
  const shim = source => /^export \{[^}]+\} from "@areal\/ui(?:\/wip)?";?\s*$/m.test(source) && source.trim().split("\n").length <= 3;
  const shims = new Set([...sources].filter(([, source]) => shim(source)).map(([file]) => file.replace(/\.tsx?$/, "")));
  const users = new Map(list.map(component => [component.id, new Set()]));
  for (const [file, source] of sources) {
    if (shims.has(file.replace(/\.tsx?$/, ""))) continue;
    for (const [, body, from] of source.matchAll(/import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*"([^"]+)"/g)) {
      if (from.startsWith(".")) {
        const target = posix.normalize(posix.join(dirname(file), from)).replace(/\.js$/, "");
        if (!shims.has(target)) continue;
      } else if (!from.startsWith("@areal/ui")) continue;
      const names = body.split(",").map(name => name.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean);
      for (const component of list) if (names.some(name => component.exports.includes(name))) users.get(component.id).add(file);
    }
  }
  return users;
}

export async function verifyMaturity() {
  const list = await components();
  const users = await consumers(list);
  const pending = [], held = [];
  for (const component of list) {
    const count = users.get(component.id).size;
    if (component.layer !== "core" || component.status !== "experimental" || count < STABLE_THRESHOLD) continue;
    if (component.hold) held.push(`${component.id}(${count}): ${component.hold}`);
    else pending.push(`${component.id}: ${count} 个生产文件使用`);
  }
  assert.deepEqual(pending, [], `以下 core 组件已达到稳定标准，请移入 @areal/ui 稳定入口，或在合同中写 hold: <原因>：\n${pending.join("\n")}`);
  const count = status => list.filter(component => component.status === status).length;
  return { passed: true, stable: count("stable"), experimental: count("experimental"), threshold: STABLE_THRESHOLD, held };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyMaturity()));
}
