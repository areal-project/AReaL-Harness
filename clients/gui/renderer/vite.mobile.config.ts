import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const workbench = JSON.parse(
  readFileSync(new URL("../packages/workbench/package.json", import.meta.url), "utf8"),
);

export default defineConfig(() => ({
  root: fileURLToPath(new URL("./mobile", import.meta.url)),
  base: "./",
  plugins: [
    {
      name: "mobile-development",
      apply: "serve",
      enforce: "pre",
      transformIndexHtml: {
        order: "pre",
        handler: (html) =>
          html
            .replace(
              "../src/mobile.ts",
              `/@fs/${fileURLToPath(new URL("./src/mobile.ts", import.meta.url))}`,
            )
            .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
            .replace("connect-src wss:", "connect-src 'self' ws: wss:")
            .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
      },
      // 脚本更新重建连接所有者，避免 Fast Refresh 留下已 dispose 的单例。
      handleHotUpdate({ file, server }) {
        if (/\.(?:[cm]?[jt]sx?)$/.test(file)) {
          server.ws.send({ type: "full-reload" });
          return [];
        }
      },
    },
    react(),
    tailwindcss(),
  ],
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  optimizeDeps: {
    include: [
      "@areal/workbench/desktop-contract",
      ...Object.keys(workbench.exports)
        .filter((key) => key.startsWith("./desktop-contract/"))
        .map((key) => `@areal/workbench/${key.slice(2)}`),
      "@areal/workbench/model-selection",
      "@areal/workbench/state-projection",
      "@areal/provider-config",
    ],
  },
  publicDir: false,
  build: {
    target: "safari17.4",
    outDir: "../../dist/mobile",
    emptyOutDir: true,
    rolldownOptions: { output: { entryFileNames: "assets/mobile.js" } },
  },
}));
