import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const gui = fileURLToPath(new URL("../", import.meta.url));
const layers = ["unit", "contract", "e2e"];
const platforms = ["darwin", "linux", "win32"];

export async function readTestManifest(root = gui) {
  const manifest = JSON.parse(await readFile(resolve(root, "scripts/test-manifest.json"), "utf8"));
  const scripts = Object.keys(
    JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).scripts ?? {},
  ).filter((name) => name.startsWith("test:"));
  if (!Array.isArray(manifest)) throw new Error("Test manifest must be an array");
  const seen = new Set();
  for (const entry of manifest) {
    if (!entry || typeof entry.script !== "string")
      throw new Error("Manifest entry requires script");
    if (seen.has(entry.script)) throw new Error(`Duplicate test registration ${entry.script}`);
    seen.add(entry.script);
    if (!scripts.includes(entry.script)) throw new Error(`Stale test registration ${entry.script}`);
    if (!layers.includes(entry.layer)) throw new Error(`${entry.script} has invalid layer`);
    for (const key of ["platforms", "areas", "requires"]) {
      if (
        !Array.isArray(entry[key]) ||
        !entry[key].every((value) => typeof value === "string" && value.length > 0) ||
        new Set(entry[key]).size !== entry[key].length
      )
        throw new Error(`${entry.script} has invalid ${key}`);
      if (key !== "requires" && !entry[key].length)
        throw new Error(`${entry.script} requires ${key}`);
    }
    if (!entry.platforms.every((platform) => platforms.includes(platform)))
      throw new Error(`${entry.script} has invalid platforms`);
    for (const key of ["platformReason", "ciSmoke", "qualificationJourney"]) {
      if (entry[key] !== undefined && (typeof entry[key] !== "string" || !entry[key].trim()))
        throw new Error(`${entry.script} has invalid ${key}`);
    }
    if (entry.platforms.length === 1 && !entry.platformReason)
      throw new Error(`${entry.script} requires platformReason`);
    if ((entry.ciSmoke || entry.qualificationJourney) && entry.layer !== "e2e")
      throw new Error(`${entry.script} CI smoke must cross the e2e boundary`);
    if (entry.flaky !== undefined && typeof entry.flaky !== "boolean")
      throw new Error(`${entry.script} has invalid flaky`);
  }
  for (const key of ["ciSmoke", "qualificationJourney"]) {
    const values = manifest.map((entry) => entry[key]).filter(Boolean);
    if (new Set(values).size !== values.length) throw new Error(`Duplicate ${key}`);
  }
  const missing = scripts.filter((script) => !seen.has(script));
  if (missing.length) throw new Error(`Unregistered tests ${missing.join(", ")}`);
  return manifest;
}

export function selectTests(manifest, { platform, layer, areas = [], available = [] } = {}) {
  if (platform && !platforms.includes(platform)) throw new Error(`Invalid platform ${platform}`);
  if (layer && !layers.includes(layer)) throw new Error(`Invalid layer ${layer}`);
  return manifest
    .filter(
      (entry) =>
        (!platform || entry.platforms.includes(platform)) &&
        (!layer || entry.layer === layer) &&
        (!areas.length || entry.areas.some((area) => areas.includes(area))) &&
        entry.requires.every((requirement) => available.includes(requirement)),
    )
    .map((entry) => entry.script);
}

export function areasForPaths(paths) {
  const rules = [
    [/^clients\/gui\/renderer\/src\/(?:composer|input|references)\//, ["composer"]],
    [
      /^clients\/gui\/renderer\/src\/(?:history|timeline|conversation)\//,
      ["history", "conversation"],
    ],
    [/^clients\/gui\/renderer\/src\/(?:settings|models|providers)\//, ["provider", "desktop"]],
    [/^clients\/gui\/renderer\/src\/side-chat\//, ["side-chat"]],
    [/^clients\/gui\/renderer\/src\/(?:browser|annotations)\//, ["browser", "annotations"]],
  ];
  const matched = paths.map((path) => rules.find(([pattern]) => pattern.test(path))?.[1]);
  // Shared owners and unmapped paths retain every required smoke.
  return matched.some((areas) => !areas) ? [] : [...new Set(matched.flat())];
}

export function smokeMatrix(manifest, areas = []) {
  const entries = manifest.filter((entry) => entry.ciSmoke);
  const covered = areas.every((area) => entries.some((entry) => entry.areas.includes(area)));
  const selected = entries.filter(
    (entry) => !areas.length || !covered || entry.areas.some((area) => areas.includes(area)),
  );
  return {
    include: (selected.length ? selected : entries).map((entry) => ({
      scenario: entry.ciSmoke,
      script: entry.script,
    })),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const rootIndex = args.indexOf("--root");
  const root = resolve(value("--root") ?? (rootIndex >= 0 ? args[rootIndex + 1] : gui));
  const manifest = await readTestManifest(root);
  if (args.includes("--select-changed")) {
    const input = JSON.parse(readFileSync(0, "utf8"));
    for (const key of ["paths", "available"])
      if (!Array.isArray(input[key]) || !input[key].every((item) => typeof item === "string"))
        throw new Error(`Changed test selection requires ${key}`);
    if (!platforms.includes(input.platform)) throw new Error("Invalid changed test platform");
    const areas = areasForPaths(input.paths);
    const candidates = manifest.filter(
      (entry) =>
        entry.layer !== "e2e" &&
        (entry.layer === "unit" ||
          !areas.length ||
          entry.areas.some((area) => areas.includes(area))),
    );
    const selected = selectTests(candidates, {
      platform: input.platform,
      available: input.available,
    });
    console.log(
      JSON.stringify({
        areas,
        selected,
        unexecuted: candidates
          .filter((entry) => !selected.includes(entry.script))
          .map((entry) => ({
            script: entry.script,
            platformSupported: entry.platforms.includes(input.platform),
            missingRequirements: entry.requires.filter((item) => !input.available.includes(item)),
          })),
        deferred: manifest
          .filter(
            (entry) =>
              entry.layer === "e2e" &&
              (!areas.length || entry.areas.some((area) => areas.includes(area))),
          )
          .map((entry) => entry.script),
      }),
    );
    return;
  }
  if (args.includes("--ci-matrix")) {
    const base = value("--base");
    const paths = base
      ? execFileSync("git", ["diff", "--name-only", "--end-of-options", base, "HEAD", "--"], {
          cwd: root,
          encoding: "utf8",
        })
          .trim()
          .split("\n")
          .filter(Boolean)
      : [];
    console.log(JSON.stringify(smokeMatrix(manifest, areasForPaths(paths))));
    return;
  }
  if (!args.includes("--list")) {
    const { auditPlatformPaths } = await import("./support/platform-paths.mjs");
    const violations = await auditPlatformPaths(root);
    if (violations.length)
      throw new Error(
        violations
          .map((item) => `${item.file}:${item.line} platform-specific temporary path ${item.value}`)
          .join("\n"),
      );
    console.log(
      JSON.stringify({
        passed: true,
        scope: "GUI root package.json test:* scripts",
        registered: manifest.length,
      }),
    );
    return;
  }
  console.log(
    JSON.stringify({
      scripts: selectTests(manifest, {
        platform: value("--platform"),
        layer: value("--layer"),
        areas: value("--area")?.split(","),
        available: value("--available")?.split(","),
      }),
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
