// The driver binary: which one this checkout needs, and getting it there without trusting a file
// just because it exists.
//
// driver/release.json pins a published build: its release tag, asset, executable SHA-256 and the
// fingerprint of the sources it was built from. plugin/driver/cua-driver.json records where the
// installed exe came from. Setup compares both with the checkout's current fingerprint each run:
//   current     the installed exe is the recorded one, built from today's sources: reuse it
//   fetch       missing, or an older managed exe, and the pin matches today's sources: download
//   adopt       an exe without a record whose hash is the pinned release: record it
//   stale       sources changed and no release matches: needs --build or a new release
//   unknown     an exe of unknown origin: kept, reported
// BCU_CUA_DRIVER in this shell doesn't change any of this: registered clients don't inherit it, so
// setup manages and verifies the driver they actually run. To run your own build everywhere, set
// BCU_CUA_DRIVER in each client's server environment yourself.

import fs from "node:fs";
import path from "node:path";
import { PLUGIN, REPO, run, sha256, sha256File, writeAtomic, type Check } from "./lib.ts";

export type ReleaseManifest = { repo: string; tag: string; target: string; asset: string; sha256: string; fingerprint: string };
export type Provenance = { source: "release" | "build"; fingerprint: string; sha256: string; tag?: string; rustc?: string };

export const EXE = path.join(PLUGIN, "driver", "cua-driver.exe");
const RECORD = path.join(PLUGIN, "driver", "cua-driver.json");
const PENDING = `${RECORD}.pending`; // the record for an exe being swapped in; see installExe
const MANIFEST = path.join(REPO, "driver", "release.json");

/** SHA-256 over everything that decides the driver binary: the build script (toolchain pins live
 *  there) and every tracked file in driver/, in path order, as they are on disk. Each file
 *  contributes "<path>\0<byte length>\0<bytes>". driver/release.json is not an input. */
export function fingerprint(root = REPO): string {
  const listed = run("git", ["-C", root, "ls-files", "-z", "--", "driver", ":!driver/release.json"]);
  if (listed.code !== 0) throw new Error(`git ls-files failed in ${root}: ${listed.stderr.trim()}`);
  const files = ["scripts/build-driver.sh", ...listed.stdout.split("\0").filter(Boolean).sort()];
  const parts = files.flatMap((rel) => {
    const bytes = fs.readFileSync(path.join(root, rel));
    return [Buffer.from(`${rel}\0${bytes.length}\0`), bytes];
  });
  return sha256(Buffer.concat(parts));
}

/** driver/release.json, or null before the first release. BCU_RELEASE_MANIFEST reads another file. */
export function readManifest(): ReleaseManifest | null {
  try { return JSON.parse(fs.readFileSync(process.env.BCU_RELEASE_MANIFEST ?? MANIFEST, "utf8")) as ReleaseManifest; } catch { return null; }
}

function readJsonFile<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; }
}

/** The record describing the exe with this hash: the committed one, or the pending one if a swap
 *  was interrupted after the exe moved into place. */
function recordFor(sha: string | null): { record: Provenance | null; pending: boolean } {
  const pending = readJsonFile<Provenance>(PENDING);
  if (sha !== null && pending?.sha256 === sha) return { record: pending, pending: true };
  return { record: readJsonFile<Provenance>(RECORD), pending: false };
}

type State =
  | { kind: "current"; record: Provenance; pending: boolean }
  | { kind: "fetch"; manifest: ReleaseManifest; why: "missing" | "outdated" }
  | { kind: "adopt"; manifest: ReleaseManifest }
  | { kind: "stale"; installed: string | null }
  | { kind: "unknown"; sha: string };

export function driverState(fp = fingerprint()): State {
  const manifest = readManifest();
  const pinned = manifest?.fingerprint === fp ? manifest : null;
  const sha = sha256File(EXE);
  const { record, pending } = recordFor(sha);
  const managed = sha !== null && record?.sha256 === sha;
  if (managed && record.fingerprint === fp) return { kind: "current", record, pending };
  if (sha === null) return pinned ? { kind: "fetch", manifest: pinned, why: "missing" } : { kind: "stale", installed: null };
  if (pinned && sha === pinned.sha256) return { kind: "adopt", manifest: pinned };
  if (!managed) return { kind: "unknown", sha };
  return pinned ? { kind: "fetch", manifest: pinned, why: "outdated" } : { kind: "stale", installed: record.fingerprint };
}

const short = (h: string) => h.slice(0, 12);
const BUILD_HINT = "run scripts/install.sh --build (needs Rust), or publish a release with scripts/release-driver.ts --publish";

/** Report the driver without changing anything. */
export function checkDriver(): Check {
  const fp = fingerprint();
  const s = driverState(fp);
  const id = "driver";
  const shell = process.env.BCU_CUA_DRIVER ? [`BCU_CUA_DRIVER=${process.env.BCU_CUA_DRIVER} is set in this shell; registered clients don't see it, so setup checks plugin/driver`] : [];
  const c = describe(s, fp);
  return { ...c, evidence: [...(c.evidence ?? []), ...shell] };
}

function describe(s: State, fp: string): Check {
  const id = "driver";
  switch (s.kind) {
    case "current":
      return { id, status: "ok", code: "DRIVER_CURRENT", summary: `${s.record.source === "release" ? `release ${s.record.tag}` : "clean build"} for these sources`, evidence: [`sha256 ${s.record.sha256}`, `fingerprint ${short(fp)}`] };
    case "adopt":
      return { id, status: "ok", code: "DRIVER_MATCHES_RELEASE", summary: `matches release ${s.manifest.tag}; install records it`, evidence: [`sha256 ${s.manifest.sha256}`] };
    case "fetch":
      return { id, status: "action", code: s.why === "missing" ? "DRIVER_MISSING" : "DRIVER_OUTDATED", summary: `${s.why === "missing" ? "not installed" : "older than these sources"}; release ${s.manifest.tag} matches`, next: "Run scripts/install.sh." };
    case "stale":
      return { id, status: "fail", code: "DRIVER_NO_RELEASE", summary: `the driver sources (fingerprint ${short(fp)}) have no matching release${s.installed ? `; the installed driver was built from ${short(s.installed)}` : ""}`, next: BUILD_HINT };
    case "unknown":
      return { id, status: "action", code: "DRIVER_UNKNOWN", summary: "plugin/driver/cua-driver.exe has no provenance record and isn't the pinned release; bcu left it alone", evidence: [`sha256 ${s.sha}`], next: "Move it away so install can put the pinned driver there, or point BCU_CUA_DRIVER at it to keep using it." };
  }
}

/** Make the driver current: download the pinned release, or build from source with `build`. */
export function ensureDriver(build: boolean): Check {
  const fp = fingerprint();
  const s = driverState(fp);
  if (s.kind === "adopt") {
    writeAtomic(RECORD, JSON.stringify({ source: "release", fingerprint: fp, sha256: s.manifest.sha256, tag: s.manifest.tag } satisfies Provenance, null, 2) + "\n");
    return { id: "driver", status: "ok", code: "DRIVER_ADOPTED", summary: `kept the existing exe: it is release ${s.manifest.tag}`, evidence: [`sha256 ${s.manifest.sha256}`] };
  }
  if (s.kind === "current" && s.pending) fs.renameSync(PENDING, RECORD); // finish an interrupted swap
  if (build && (s.kind === "fetch" || s.kind === "stale")) return buildDriver(fp);
  if (s.kind === "fetch") return download(s.manifest, fp);
  return checkDriver();
}

/** Put a verified exe in place: stage its record, swap the exe, then commit the record. A crash at
 *  any point leaves either the old exe with its record or the new exe with its pending record, and
 *  both read as managed. */
function installExe(file: string, record: Provenance) {
  fs.chmodSync(file, 0o755);
  writeAtomic(PENDING, JSON.stringify(record, null, 2) + "\n");
  fs.renameSync(file, EXE);
  fs.renameSync(PENDING, RECORD);
}

function download(m: ReleaseManifest, fp: string): Check {
  const id = "driver";
  fs.mkdirSync(path.dirname(EXE), { recursive: true });
  const tmp = path.join(path.dirname(EXE), `.download-${process.pid}`);
  try {
    // A private release needs an authenticated gh; a public one also downloads over plain HTTPS.
    const gh = run("gh", ["auth", "status", "--hostname", "github.com"]);
    const got = gh.code === 0
      ? run("gh", ["release", "download", m.tag, "-R", m.repo, "-p", m.asset, "-O", tmp, "--clobber"])
      : run("curl", ["-fsSL", "-o", tmp, `https://github.com/${m.repo}/releases/download/${m.tag}/${m.asset}`]);
    if (got.code !== 0) {
      return gh.code === 0
        ? { id, status: "fail", code: "DRIVER_DOWNLOAD_FAILED", summary: `gh couldn't download ${m.asset} from ${m.repo} release ${m.tag}`, evidence: [got.stderr.trim()], next: "Check network access, then rerun scripts/install.sh. The existing install is unchanged." }
        : { id, status: "action", code: "DRIVER_AUTH", summary: `${m.repo} release ${m.tag} isn't public, and gh isn't signed in`, evidence: [got.stderr.trim()], next: `Run gh auth login with an account that can read ${m.repo}, then rerun scripts/install.sh. Nothing was built or changed.` };
    }
    const sha = sha256File(tmp);
    if (sha !== m.sha256) {
      return { id, status: "fail", code: "DRIVER_CHECKSUM", summary: `the downloaded ${m.asset} doesn't match driver/release.json; it was deleted`, evidence: [`expected ${m.sha256}`, `got ${sha}`], next: "Rerun scripts/install.sh. If it keeps failing, the release asset changed: report it." };
    }
    installExe(tmp, { source: "release", fingerprint: fp, sha256: m.sha256, tag: m.tag });
    return { id, status: "ok", code: "DRIVER_DOWNLOADED", summary: `installed release ${m.tag}`, evidence: [`sha256 ${m.sha256}`] };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** scripts/build-driver.sh --no-install, then install its exe with a record of the sources it came
 *  from. Build output goes to stderr so a --json report on stdout stays parseable. */
export function buildDriver(fp: string): Check {
  const id = "driver";
  const built = run(path.join(REPO, "scripts", "build-driver.sh"), ["--no-install"], { stdio: ["ignore", 2, 2] });
  if (built.code !== 0) return { id, status: "fail", code: "DRIVER_BUILD_FAILED", summary: "scripts/build-driver.sh failed; its output is above", next: "Fix the build error, then rerun with --build. The existing install is unchanged." };
  if (fingerprint() !== fp) return { id, status: "fail", code: "DRIVER_SOURCES_CHANGED", summary: "the driver sources changed during the build", next: "Rerun with --build." };
  const out = path.join(REPO, "tools", "out");
  const tmp = path.join(path.dirname(EXE), `.build-${process.pid}`);
  fs.mkdirSync(path.dirname(EXE), { recursive: true });
  fs.copyFileSync(path.join(out, "cua-driver.exe"), tmp);
  const sha = sha256File(tmp) ?? "";
  installExe(tmp, { source: "build", fingerprint: fp, sha256: sha, rustc: fs.readFileSync(path.join(out, "rustc.txt"), "utf8").trim() });
  return { id, status: "ok", code: "DRIVER_BUILT", summary: "built from source and installed", evidence: [`sha256 ${sha}`, `fingerprint ${short(fp)}`] };
}
