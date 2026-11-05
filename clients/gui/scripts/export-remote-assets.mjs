import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import resources from "@areal/workbench-service/desktop/core/relay-resources.cjs";

export const { exportRemoteAssets } = resources;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination)
    throw new Error("用法: export-remote-assets <GUI dist> <新的 Remote 输出目录>");
  console.log(JSON.stringify(await exportRemoteAssets(source, destination)));
}
