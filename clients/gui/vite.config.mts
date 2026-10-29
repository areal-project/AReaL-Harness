import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: [
      "renderer/src/**/*.test.{ts,tsx}",
      "packages/ui/src/**/*.test.{ts,tsx}",
      "oxlint-plugin-areal/**/*.test.ts",
    ],
    environment: "node",
  },
  lint: {
    jsPlugins: ["./oxlint-plugin-areal/index.ts"],
    rules: { "areal/require-suppression-reason": "error" },
    overrides: [
      {
        files: ["renderer/src/**/*.{js,jsx,ts,tsx}", "packages/ui/src/**/*.{js,jsx,ts,tsx}"],
        excludeFiles: ["packages/ui/src/lib/observe-resize.ts"],
        rules: { "areal/no-raw-resize-observer": "error" },
      },
    ],
    settings: {
      "jsx-a11y": {
        components: {
          Input: "input",
          Textarea: "textarea",
        },
      },
    },
    ignorePatterns: [
      "**/dist/**",
      "**/vendor/**",
      "**/generated/**",
      "packages/gen-ui/assets/**",
      "renderer/public/**",
    ],
  },
  fmt: {
    ignorePatterns: [
      "**/dist/**",
      "**/vendor/**",
      "**/generated/**",
      "packages/gen-ui/assets/**",
      "renderer/public/**",
      "pnpm-lock.yaml",
      "patches/**",
      "**/*.md",
    ],
    sortPackageJson: false,
    tabWidth: 2,
  },
  run: {
    cache: { scripts: false, tasks: true },
    tasks: {
      "ui-build": {
        command: "pnpm run build",
        cwd: "packages/ui",
        cache: {
          input: [
            { pattern: "packages/ui/src/**", base: "workspace" },
            { pattern: "packages/ui/scripts/**", base: "workspace" },
            { pattern: "packages/ui/*.json", base: "workspace" },
            { pattern: "packages/ui/*.md", base: "workspace" },
            { pattern: "pnpm-lock.yaml", base: "workspace" },
          ],
          output: [{ pattern: "packages/ui/dist/**", base: "workspace" }],
        },
      },
      "browser-automation-build": {
        command: "node scripts/build.mjs",
        cwd: "packages/browser-automation",
        cache: {
          input: [
            { pattern: "packages/browser-automation/src/**", base: "workspace" },
            { pattern: "packages/browser-automation/scripts/build.mjs", base: "workspace" },
            { pattern: "packages/browser-automation/*.json", base: "workspace" },
            { pattern: "pnpm-lock.yaml", base: "workspace" },
          ],
          output: [{ pattern: "packages/browser-automation/dist/**", base: "workspace" }],
        },
      },
      "browser-data-build": {
        command: "node scripts/build.mjs",
        cwd: "packages/browser-data",
        cache: {
          input: [
            { pattern: "packages/browser-data/src/**", base: "workspace" },
            { pattern: "packages/browser-data/scripts/build.mjs", base: "workspace" },
            { pattern: "packages/browser-data/*.json", base: "workspace" },
            { pattern: "pnpm-lock.yaml", base: "workspace" },
          ],
          output: [{ pattern: "packages/browser-data/dist/**", base: "workspace" }],
        },
      },
      "desktop-build": {
        command: "node build.mjs",
        cwd: "packages/gen-ui",
        dependsOn: ["browser-automation-build", "browser-data-build"],
        cache: {
          input: [
            { pattern: "packages/gen-ui/*.ts", base: "workspace" },
            { pattern: "packages/gen-ui/build.mjs", base: "workspace" },
            { pattern: "packages/gen-ui/assets/**", base: "workspace" },
            { pattern: "packages/gen-ui/*.json", base: "workspace" },
            { pattern: "pnpm-lock.yaml", base: "workspace" },
          ],
          output: [{ pattern: "packages/gen-ui/dist/**", base: "workspace" }],
        },
      },
      "computer-helper-build": {
        command: "node scripts/build-computer-helper.mjs",
        cache: false,
      },
      "build-suite": {
        command: "vp build",
        cwd: "renderer",
        dependsOn: ["ui-build", "desktop-build", "computer-helper-build"],
        cache: false,
      },
      "design-build": {
        command: "vp build --mode design-system",
        cwd: "renderer",
        dependsOn: ["ui-build"],
        cache: false,
      },
      "verify-suite": {
        command: [
          "pnpm contracts:check",
          "pnpm --filter @areal/ui check",
          "node scripts/verify-public.mjs",
          "node scripts/verify-i18n.mjs",
          "node scripts/test-manifest.mjs",
          "node scripts/design-system-audit.mjs",
          "node scripts/a11y-lint.mjs",
          "node scripts/state-projection-smoke.mjs",
          "node --test scripts/conversation-content.test.mjs scripts/activity-runs.test.mjs scripts/bundle.test.mjs scripts/provider-affinity.test.mjs scripts/provider-status.test.cjs scripts/side-restore.test.mjs scripts/operation-contract.test.cjs scripts/side-model-intent.test.mjs scripts/startup-recovery.test.mjs scripts/service-connection-recovery.test.mjs scripts/core-read-recovery.test.mjs scripts/bounded-history-client.test.mjs scripts/desktop-projection-transport.test.mjs scripts/lifecycle-bounded-history.test.mjs scripts/backend-status.test.mjs scripts/system-proxy.test.mjs scripts/history.test.mjs scripts/macos-service.test.mjs scripts/macos-signing-paths.test.mjs scripts/application-cleanup.test.mjs scripts/feedback.test.mjs scripts/scoped-resources-mcp.test.cjs",
          "pnpm test:worktree",
          "pnpm test:health",
          "pnpm test:manifest",
          "pnpm test:unit",
        ],
        dependsOn: ["ui-build", "desktop-build"],
        cache: false,
      },
      "design-suite": {
        command: [
          "pnpm --filter @areal/ui check",
          "node --test scripts/design-system-catalog.test.mjs scripts/design-system-changes.test.mjs scripts/design-system-accessibility.test.mjs scripts/a11y-lint.test.mjs scripts/popup-anchor-lint.test.mjs scripts/design-system-baseline.test.mjs scripts/design-verified.test.mjs scripts/activity-runs.test.mjs",
          "node scripts/design-system-audit.mjs",
          "node scripts/a11y-lint.mjs",
          "node scripts/popup-anchor-lint.mjs",
          "node scripts/design-rules.mjs",
          "node scripts/design-generated.mjs",
          "node scripts/design-verified.mjs",
        ],
        dependsOn: ["ui-build"],
        cache: false,
      },
      "types-suite": {
        command: [
          "pnpm --filter @areal/gen-ui typecheck",
          "pnpm --filter @areal/gui-renderer typecheck",
          "pnpm --filter @areal/gui-renderer exec tsc --ignoreConfig --project ../app/tsconfig.json",
          "pnpm --filter @areal/gui-renderer exec tsc --ignoreConfig --allowJs --checkJs --noEmit --skipLibCheck --target ES2022 --module NodeNext ../packages/workbench/client/desktop-contract.cjs",
        ],
        dependsOn: ["ui-build"],
        cache: false,
      },
    },
  },
});
