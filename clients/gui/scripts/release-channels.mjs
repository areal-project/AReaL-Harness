// 把已公开的 gui-v<版本> Release 推进到更新频道：正式版进正式与 Beta 两个频道，Beta 只进 Beta 频道。
// 默认只打印计划；--publish 才写远端。频道只承载 latest-mac.yml，拒绝降级与跨频道。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(new URL("../app/package.json", import.meta.url));
const { parse } = require("yaml");
const {
  githubRepository,
  githubFeedUrl,
  githubBetaFeedUrl,
  releaseVersion,
  newer,
  validateUpdate,
} = require("../app/src/update/config.cjs");

/** @param {string} version */
export function channelsFor(version) {
  assert.ok(releaseVersion(version), `invalid GUI version ${version}`);
  return version.includes("-beta.")
    ? [{ tag: "gui-beta-channel", feed: githubBetaFeedUrl }]
    : [
        { tag: "gui-update-channel", feed: githubFeedUrl },
        { tag: "gui-beta-channel", feed: githubBetaFeedUrl },
      ];
}

/** @param {string} target @param {string|undefined} current @returns {'advance'|'unchanged'} */
export function channelStep(target, current) {
  if (current === undefined || newer(target, current)) return "advance";
  if (current === target) return "unchanged";
  throw new Error(`refusing to move channel from ${current} down to ${target}`);
}

const gh = (/** @type {string[]} */ ...args) =>
  execFileSync("gh", [...args, "--repo", githubRepository], { encoding: "utf8" });

async function main() {
  const args = process.argv.slice(2);
  const tag = args[args.indexOf("--tag") + 1] ?? "";
  const publish = args.includes("--publish");
  const match = /^gui-v(.+)$/.exec(tag);
  assert.ok(
    args.includes("--tag") && match,
    "Usage: node release-channels.mjs --tag gui-vX.Y.Z[-beta.N] [--publish]",
  );
  const version = match[1];
  const beta = version.includes("-beta.");
  const release = JSON.parse(gh("release", "view", tag, "--json", "isDraft,isPrerelease"));
  assert.equal(release.isDraft, false, "version release must be public first");
  assert.equal(release.isPrerelease, beta, "beta releases must be prereleases and stable not");
  const directory = await mkdtemp(join(tmpdir(), "areal-gui-channels-"));
  try {
    gh("release", "download", tag, "--dir", directory, "--pattern", "latest-mac.yml");
    gh("release", "download", tag, "--dir", directory, "--pattern", "SHA256SUMS");
    const manifest = join(directory, "latest-mac.yml");
    const bytes = await readFile(manifest);
    const sums = await readFile(join(directory, "SHA256SUMS"), "utf8");
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.ok(sums.includes(`${digest}  latest-mac.yml`), "latest-mac.yml checksum mismatch");
    const info = parse(bytes.toString("utf8"));
    assert.equal(info.version, version);
    for (const channel of channelsFor(version)) {
      validateUpdate(info, channel.feed, { engine: "electron" });
      let current;
      try {
        const existing = join(directory, channel.tag);
        gh("release", "download", channel.tag, "--dir", existing, "--pattern", "latest-mac.yml");
        current = parse(await readFile(join(existing, "latest-mac.yml"), "utf8")).version;
      } catch {
        current = undefined;
      }
      const step = channelStep(version, current);
      console.log(`${channel.tag}: ${current ?? "(empty)"} -> ${version} [${step}]`);
      if (!publish || step === "unchanged") continue;
      if (current === undefined)
        try {
          gh("release", "view", channel.tag, "--json", "tagName");
        } catch {
          gh(
            "release",
            "create",
            channel.tag,
            "--prerelease",
            "--latest=false",
            "--title",
            channel.tag,
            "--notes",
            "Update channel manifest; not a product release.",
          );
        }
      gh("release", "upload", channel.tag, manifest, "--clobber");
    }
    if (!publish) console.log("dry run: pass --publish to update the channels");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
