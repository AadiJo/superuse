// Maintainer script: publish the driver build that fork/release.json pins, so installs download it
// instead of compiling Rust.
//
//   node scripts/release-driver.ts            clean build and server check; prints the manifest
//   node scripts/release-driver.ts --publish  also creates the GitHub release, writes fork/release.json
//
// The tag is driver-<first 12 hex of the source fingerprint> (scripts/setup/driver.ts defines it).
// Published tags and assets are never replaced: if the tag exists, this downloads its asset and
// writes the manifest from what's there. Publishing needs gh signed in and the current commit
// pushed, because the tag points at it. Commit the new fork/release.json afterwards.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fingerprint, type ReleaseManifest } from "./setup/driver.ts";
import { PLUGIN, REPO, readJson, run, sha256File, writeAtomic } from "./setup/lib.ts";
import { checkServer } from "./setup/verify.ts";

const { values: opts } = parseArgs({ options: { publish: { type: "boolean", default: false } } });

function die(message: string): never {
  throw new Error(message);
}

const fp = fingerprint();
const repository = readJson<{ repository: string }>(path.join(PLUGIN, ".claude-plugin", "plugin.json")).repository;
const base = { repo: repository.replace(/^https:\/\/github\.com\//, ""), tag: `driver-${fp.slice(0, 12)}`, target: "x86_64-pc-windows-gnu", asset: "cua-driver-x86_64-pc-windows-gnu.exe", fingerprint: fp };
const manifestFile = path.join(REPO, "fork", "release.json");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bcu-release-"));
const write = (m: ReleaseManifest) => {
  writeAtomic(manifestFile, JSON.stringify(m, null, 2) + "\n");
  console.log(`wrote fork/release.json for ${m.tag} (sha256 ${m.sha256}); commit it`);
};

async function main() {
  if (run("gh", ["release", "view", base.tag, "-R", base.repo]).code === 0) {
    const got = run("gh", ["release", "download", base.tag, "-R", base.repo, "-p", base.asset, "-D", tmp]);
    if (got.code !== 0) die(`release ${base.tag} exists but its asset didn't download: ${got.stderr}`);
    const sha = sha256File(path.join(tmp, base.asset))!;
    const pinned = fs.existsSync(manifestFile) ? readJson<ReleaseManifest>(manifestFile) : null;
    if (pinned?.tag === base.tag && pinned.sha256 !== sha) die(`release ${base.tag} holds sha256 ${sha}, but fork/release.json says ${pinned.sha256}. Releases are immutable; investigate before changing either.`);
    console.log(`release ${base.tag} already exists; verified its asset`);
    write({ ...base, sha256: sha });
    return;
  }

  const built = run(path.join(REPO, "fork", "build.sh"), ["--clean"], { stdio: "inherit" });
  if (built.code !== 0) die("fork/build.sh --clean failed");
  if (fingerprint() !== fp) die("the fork sources changed during the build; rerun");
  const exe = path.join(tmp, base.asset);
  fs.copyFileSync(path.join(REPO, "tools", "clean", "out", "cua-driver.exe"), exe);
  const manifest: ReleaseManifest = { ...base, sha256: sha256File(exe)! };

  // The release candidate must work before anyone downloads it.
  process.env.BCU_NODE ??= process.execPath;
  const server = await checkServer(exe);
  if (server.status !== "ok") die(`the built driver failed the server check: ${server.summary}\n${(server.evidence ?? []).join("\n")}`);
  console.log(`server check: ${server.summary}`);

  if (!opts.publish) {
    console.log(`release candidate ${base.tag}:\n${JSON.stringify(manifest, null, 2)}\nRerun with --publish to create the release.`);
    return;
  }
  // The tag must reproduce the asset: every fingerprint input has to be committed as built.
  const dirty = run("git", ["-C", REPO, "status", "--porcelain", "--untracked-files=all", "--", "fork/UPSTREAM", "fork/build.sh", "fork/patches"]).stdout.trim();
  if (dirty) die(`commit the driver's build inputs before publishing:\n${dirty}`);
  const head = run("git", ["-C", REPO, "rev-parse", "HEAD"]).stdout.trim();
  if (run("gh", ["api", `repos/${base.repo}/commits/${head}`, "--silent"]).code !== 0) die(`commit ${head} isn't on GitHub yet; push it first`);
  const created = run("gh", ["release", "create", base.tag, exe, "-R", base.repo, "--target", head, "--title", `cua-driver ${fp.slice(0, 12)}`,
    "--notes", `Cua Driver fork for ${base.target}, built by fork/build.sh --clean from fork/UPSTREAM and fork/patches at ${head}.\n\nsha256 ${manifest.sha256}\nsource fingerprint ${fp}`]);
  if (created.code !== 0) die(`gh release create failed: ${created.stderr}`);
  console.log(created.stdout.trim());
  write(manifest);
}

try {
  await main();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
