import { defineConfig, type Plugin, type UserConfig } from "vite";
import { remoteStaticAssets } from "../scripts/remote-static-assets.mjs";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const libraryAsset = (file: string) => new URL(`../packages/ui/dist/${file}`, import.meta.url);
async function libraryFiles() {
  const manifest: { components: { id: string }[] } = JSON.parse(await readFile(libraryAsset("components.json"), "utf8"));
  return new Map([
    ["components.json", "components.json"], ["llms.txt", "llms.txt"], ["docs/ui/agent-guide.md", "docs/agent-guide.md"],
    ...manifest.components.map(({ id }) => [`docs/ui/${id}.md`, `docs/${id}.md`] as const),
  ]);
}
const designLibraryAssets: Plugin = {
  name: "design-library-assets",
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const path = new URL(request.url ?? "/", "http://design.invalid").pathname.slice(1);
      try {
        const file = (await libraryFiles()).get(path);
        if (!file) return next();
        response.setHeader("Content-Type", path.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8");
        response.end(await readFile(libraryAsset(file)));
      } catch (error) { next(error); }
    });
  },
  async generateBundle() {
    for (const [fileName, source] of await libraryFiles()) this.emitFile({ type: "asset", fileName, source: await readFile(libraryAsset(source), "utf8") });
  },
};

const remoteShell: Plugin = {
  name: "remote-static-shell",
  apply: "build",
  enforce: "post",
  generateBundle: { order: "post", handler(_options, bundle) {
    const { files } = remoteStaticAssets(bundle);
    for (const [fileName, source] of files) {
      if (fileName === "remote.html" && bundle[fileName].type === "asset")
        bundle[fileName].source = source;
      else if (!bundle[fileName]) this.emitFile({ type: "asset", fileName, source });
    }
  } },
};
export default defineConfig(({ mode }): UserConfig => ({
  base: "./",
  plugins: [react(), tailwindcss(), ...(mode === "design-system" ? [designLibraryAssets] : [remoteShell])],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  optimizeDeps: mode === "design-system" ? {
    include: [
      "@areal/workbench/desktop-contract",
      "@areal/workbench/model-selection",
      "@areal/workbench/state-projection",
      "@areal/provider-config",
    ],
  } : undefined,
  build: {
    outDir: mode === "design-system" ? "../dist/design-system" : "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: mode === "design-system" ? {
        design: fileURLToPath(new URL("./design-system.html", import.meta.url)),
        libraryExample: fileURLToPath(new URL("./ui-library.html", import.meta.url)),
      } : {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        remote: fileURLToPath(new URL("./remote.html", import.meta.url)),
      },
    },
    commonjsOptions: { include: [/node_modules/, /(?:desktop-contract|model-selection|state-projection|connections)\.cjs$/] },
  },
}));
