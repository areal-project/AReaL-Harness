import { defineConfig, type Plugin, type UserConfig } from "vite";
import { remoteStaticAssets } from "../scripts/remote-static-assets.mjs";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

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
  plugins: [react(), tailwindcss(), ...(mode === "design-system" ? [] : [remoteShell])],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: mode === "design-system" ? "../dist/design-system" : "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: mode === "design-system" ? {
        design: fileURLToPath(new URL("./design-system.html", import.meta.url)),
      } : {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        remote: fileURLToPath(new URL("./remote.html", import.meta.url)),
      },
    },
    commonjsOptions: { include: [/node_modules/, /(desktop-contract|reasoning-effort)\.cjs$/] },
  },
}));
