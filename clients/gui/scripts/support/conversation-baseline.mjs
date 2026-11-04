import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 两个产品共享内容，不共享内部状态注入；协议适配器只负责交付这些素材。
export const baselineContent = {
  version: 1,
  shortDraft: "Explain this project. Keep my draft and attached context intact.",
  longDraft: "Baseline paragraph: preserve every character and reference.\n"
    .repeat(600)
    .slice(0, 30000),
  note: "CONTEXT_NOTE_V1\nExpected attachment content: alpha, beta, gamma.\n",
  initialResponse: Array.from(
    { length: 80 },
    (_, i) =>
      `Paragraph ${String(i + 1).padStart(3, "0")}: keep this reading anchor stable while more content arrives.\n\n`,
  ).join(""),
  stream: Array.from(
    { length: 40 },
    (_, i) => `Update ${String(i + 1).padStart(3, "0")}: deterministic streamed content.\n\n`,
  ),
  intervalMs: 100,
  richResponse: [
    "# Result reading",
    "",
    "```mermaid",
    "flowchart LR",
    "  A[Draft] --> B[Submit]",
    "  B --> C[Accepted]",
    "  C --> D[Stream]",
    "  D --> E[Read result]",
    "```",
    "",
    "| ID | State | Owner | Description | Input | Output | Duration | Result |",
    "| --- | --- | --- | --- | --- | --- | ---: | --- |",
    ...Array.from(
      { length: 30 },
      (_, i) =>
        `| row-${i + 1} | complete | fixture | A wide cell for local horizontal scrolling | input-${i + 1} | output-${i + 1} | ${i + 1} | retained |`,
    ),
    "",
    "```typescript",
    'export const result = "BASELINE_CODE_COMPLETE";',
    "```",
  ].join("\n"),
};

export async function writeBaselineContent(directory) {
  await mkdir(directory, { recursive: true });
  const files = {
    "short-draft.txt": baselineContent.shortDraft,
    "long-draft.txt": baselineContent.longDraft,
    "note.txt": baselineContent.note,
    "initial-response.md": baselineContent.initialResponse,
    "rich-response.md": baselineContent.richResponse,
    "stream.json": JSON.stringify({
      intervalMs: baselineContent.intervalMs,
      chunks: baselineContent.stream,
    }),
    "image.png": await readFile(new URL("../fixtures/folder-vision/a.png", import.meta.url)),
  };
  const manifest = { version: baselineContent.version, files: {} };
  for (const [name, value] of Object.entries(files)) {
    const bytes = Buffer.from(value);
    await writeFile(resolve(directory, name), bytes);
    manifest.files[name] = {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  await writeFile(resolve(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  if (!directory) throw new Error("Usage: node conversation-baseline.mjs <output-directory>");
  console.log(JSON.stringify(await writeBaselineContent(resolve(directory)), null, 2));
}
