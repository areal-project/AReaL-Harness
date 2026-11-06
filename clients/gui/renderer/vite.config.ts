import { defineConfig, type Plugin, type UserConfig } from "vite-plus";
import { remoteStaticAssets } from "../scripts/remote-static-assets.mjs";
import { bundleAnalysis } from "../scripts/bundle-analysis.mjs";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";

const pdfRoot = new URL(
  "./",
  pathToFileURL(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")),
);
const pdfFiles = Promise.all(
  ["cmaps", "standard_fonts", "wasm", "iccs"].map(async (directory) =>
    (await readdir(new URL(directory + "/", pdfRoot))).map(
      (name) =>
        [`pdf-assets/${directory}/${name}`, new URL(`${directory}/${name}`, pdfRoot)] as const,
    ),
  ),
).then((groups) => new Map<string, URL>(groups.flat()));
const pdfDocumentAssets: Plugin = {
  name: "pdf-document-assets",
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const file = (await pdfFiles).get(
        new URL(request.url ?? "/", "http://pdf.invalid").pathname.slice(1),
      );
      if (!file) return next();
      response.setHeader(
        "Content-Type",
        file.pathname.endsWith(".wasm") ? "application/wasm" : "application/octet-stream",
      );
      response.end(await readFile(file));
    });
  },
  async generateBundle() {
    for (const [fileName, file] of await pdfFiles)
      this.emitFile({ type: "asset", fileName, source: await readFile(file) });
  },
};

const libraryAsset = (file: string) => new URL(`../packages/ui/dist/${file}`, import.meta.url);
async function libraryFiles() {
  const manifest: { components: { id: string }[] } = JSON.parse(
    await readFile(libraryAsset("components.json"), "utf8"),
  );
  return new Map([
    ["components.json", "components.json"],
    ["llms.txt", "llms.txt"],
    ...[
      "agent-guide.md",
      "README.md",
      "README.en.md",
      "token-reference.md",
      "tokens.md",
      "tokens.json",
      "experimental-allowlist.json",
    ].map((file) => [`docs/ui/${file}`, `docs/${file}`] as const),
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
        response.setHeader(
          "Content-Type",
          path.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8",
        );
        response.end(await readFile(libraryAsset(file)));
      } catch (error) {
        next(error);
      }
    });
  },
  async generateBundle() {
    for (const [fileName, source] of await libraryFiles())
      this.emitFile({
        type: "asset",
        fileName,
        source: await readFile(libraryAsset(source), "utf8"),
      });
  },
};

const remoteShell: Plugin = {
  name: "remote-static-shell",
  apply: "build",
  enforce: "post",
  generateBundle: {
    order: "post",
    handler(_options, bundle) {
      const { files } = remoteStaticAssets(bundle);
      for (const [fileName, source] of files) {
        if (fileName === "remote.html" && bundle[fileName].type === "asset")
          bundle[fileName].source = source;
        else if (!bundle[fileName]) this.emitFile({ type: "asset", fileName, source });
      }
    },
  },
};
export default defineConfig(({ mode }): UserConfig => ({
  base: "./",
  plugins: [
    react(),
    tailwindcss(),
    bundleAnalysis(),
    pdfDocumentAssets,
    ...(mode === "design-system" ? [designLibraryAssets] : [remoteShell]),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  optimizeDeps: {
    include: [
      "@areal/workbench/desktop-contract",
      "@areal/workbench/model-selection",
      "@areal/workbench/state-projection",
      "@areal/provider-config",
    ],
  },
  build: {
    outDir: mode === "design-system" ? "../dist/design-system" : "dist",
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "mermaid-renderer",
              test: (id) =>
                id.includes("/@streamdown/mermaid/") || id.endsWith("/mermaid.core.mjs"),
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
      input:
        mode === "design-system"
          ? {
              design: fileURLToPath(new URL("./design-system.html", import.meta.url)),
              libraryExample: fileURLToPath(new URL("./ui-library.html", import.meta.url)),
            }
          : {
              main: fileURLToPath(new URL("./index.html", import.meta.url)),
              remote: fileURLToPath(new URL("./remote.html", import.meta.url)),
            },
    },
  },
}));
