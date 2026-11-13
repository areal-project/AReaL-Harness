import fixture from "../../../../../design/spec/fixtures/send-run-stop.json";
import type { Data } from "../services.js";

// 文件面板的示例后台：示例工作区的目录、读取与改动标记。
const files: Record<string, string> = {
  ...fixture.workspace.files,
  ...Object.fromEntries(fixture.review.files.map((file) => [file.path, file.after])),
};
const statuses = Object.fromEntries(
  fixture.review.files.map((file) => [file.path, file.status === "added" ? "A" : "M"]),
);

function list(path: string) {
  const prefix = path ? `${path}/` : "";
  const names = new Map<string, boolean>();
  for (const file of Object.keys(files)) {
    if (!file.startsWith(prefix)) continue;
    const [name, ...rest] = file.slice(prefix.length).split("/");
    names.set(name, (names.get(name) ?? false) || rest.length > 0);
  }
  return {
    entries: [...names]
      .map(([name, dir]) => ({ name, dir }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)),
  };
}

export function workspaceAction(name: string, request: Data): Data | undefined {
  if (name !== "workspace") return undefined;
  if (request.operation === "list") return list(request.path ?? "");
  if (request.operation === "status")
    return {
      available: true,
      entries: Object.entries(statuses).map(([path, status]) => ({ path, status })),
    };
  if (request.operation === "read" && request.path in files)
    return { text: files[request.path], revision: "1" };
  return undefined;
}
