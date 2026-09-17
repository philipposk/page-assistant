#!/usr/bin/env node
// Opens a pull request in every app that embeds page-assistant, moving it to this checkout's
// version. Run by .github/workflows/propagate.yml when a version bump lands on main; run it by
// hand with --dry-run to see what each app would get without pushing anything.
//
//   node scripts/propagate/propagate.mjs [--apps samos-companion,topia] [--dry-run] [--keep]
//
// Needs a built checkout (`npm run build`), `git`, and `gh` signed in with a token that can push
// branches and open PRs in the app repos. The apps and how each embeds the SDK are listed in
// scripts/propagate/apps.json. Nothing is ever merged: each app's own checks and preview run on
// the PR, and a person merges it.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyPin,
  changelogBetween,
  compareVersions,
  loadGlobalBundle,
  missingNames,
  patchNpmLock,
  prBody,
  validateApps,
} from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  return args[i].includes("=") ? args[i].split("=").slice(1).join("=") : args[i + 1];
};
const DRY = flag("dry-run");
const KEEP = flag("keep");
const only = (option("apps") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const run = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const git = (cwd, ...argv) => run("git", argv, { cwd });

// --- what we are propagating ---------------------------------------------------------------

const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const sha = git(ROOT, "rev-parse", "HEAD");
const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
const globalBundlePath = join(ROOT, "packages/widget/dist/page-assistant.global.js");
if (!existsSync(globalBundlePath)) fail("no built widget: run `npm run build` first");

const apps = JSON.parse(readFileSync(join(ROOT, "scripts/propagate/apps.json"), "utf8")).apps;
const problems = validateApps(apps);
if (problems.length) fail(`scripts/propagate/apps.json:\n  ${problems.join("\n  ")}`);
const unknown = only.filter((n) => !apps.some((a) => a.name === n));
if (unknown.length) fail(`no such app in apps.json: ${unknown.join(", ")}`);

// What this version offers, for the "does the app still find every name it uses" check.
const globals = loadGlobalBundle(readFileSync(globalBundlePath, "utf8"));
const exports = {
  "@page-assistant/widget": new Set(Object.keys(globals.PageAssistantBundle)),
  "@page-assistant/core": await exportNames("packages/core/dist/index.js"),
  "@page-assistant/server": await exportNames("packages/server/dist/index.js"),
};

// --- per app -------------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), "pa-propagate-"));
const results = [];
for (const app of apps.filter((a) => !only.length || only.includes(a.name))) {
  try {
    results.push({ app: app.name, ...(await propagate(app)) });
  } catch (e) {
    results.push({ app: app.name, outcome: "failed", detail: e.stderr?.toString().trim() || e.message });
  }
}
if (!KEEP) rmSync(work, { recursive: true, force: true });
report(results);
process.exit(results.some((r) => r.outcome === "failed") ? 1 : 0);

async function propagate(app) {
  const dir = join(work, app.name);
  run("gh", ["repo", "clone", app.repo, dir, "--", "--depth=1", "--quiet"]);
  const base = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
  const branch = `chore/page-assistant-${version}`;

  const from = currentVersion(dir, app);
  if (from.sha === sha || from.version === version) return { outcome: "up to date", detail: from.version ?? from.sha };
  if (from.version && compareVersions(from.version, version) > 0) {
    return { outcome: "skipped", detail: `app is on ${from.version}, newer than ${version}` };
  }
  if (!DRY) {
    const open = run("gh", ["pr", "list", "--repo", app.repo, "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url // empty"]);
    if (open) return { outcome: "PR already open", detail: open };
    if (git(dir, "ls-remote", "--heads", "origin", branch)) {
      return { outcome: "skipped", detail: `branch ${branch} exists without an open PR; delete it to retry` };
    }
  }

  git(dir, "checkout", "-q", "-b", branch);
  apply(dir, app);

  const files = git(dir, "status", "--porcelain").split("\n").filter(Boolean).map((l) => l.slice(3));
  if (!files.length) return { outcome: "up to date", detail: "no file changes" };
  const missing = missingNames(app.uses, { globals, exports });
  const title = `Update page-assistant to ${version}`;
  const body = prBody({ app, from: from.version, to: version, sha, files, missing, changelog: changelogBetween(changelog, from.version, version) });

  if (DRY) {
    return {
      outcome: "would open PR",
      detail: `${from.version ?? from.sha?.slice(0, 7) ?? "?"} → ${version}; ${files.length} file(s)${missing.length ? `; MISSING ${missing.join(", ")}` : ""}${KEEP ? `; clone at ${dir}` : ""}`,
    };
  }

  const me = JSON.parse(run("gh", ["api", "user"]));
  git(dir, "add", "-A"); // a new build can add files, not only change them
  git(dir, "-c", `user.name=${me.name || me.login}`, "-c", `user.email=${me.id}+${me.login}@users.noreply.github.com`,
    "commit", "-q", "-m", `${title}\n\nFrom philipposk/page-assistant@${sha.slice(0, 7)}.`);
  git(dir, "push", "-q", "origin", branch);
  const url = run("gh", ["pr", "create", "--repo", app.repo, "--base", base, "--head", branch, "--title", title,
    "--body", body, ...(missing.length ? ["--draft"] : [])]);
  return { outcome: missing.length ? "draft PR (names missing)" : "PR opened", detail: url };
}

/** The SDK version (and for submodules the commit) the app is on now. */
function currentVersion(dir, app) {
  if (app.kind === "bundle") {
    const file = app.bundle.versionFile && join(dir, app.bundle.versionFile);
    return { version: file && existsSync(file) ? readFileSync(file, "utf8").trim() : undefined };
  }
  if (app.kind === "dir") {
    const widget = app.copy.find((c) => c.from === "packages/widget") ?? app.copy[0];
    const pkg = join(dir, widget.to, "package.json");
    return { version: existsSync(pkg) ? JSON.parse(readFileSync(pkg, "utf8")).version : undefined };
  }
  const pinned =
    app.kind === "pin"
      ? new RegExp(app.pins.find((p) => p.value === "sha").pattern).exec(readFileSync(join(dir, app.pins.find((p) => p.value === "sha").file), "utf8"))?.[1]
      : git(dir, "ls-tree", "HEAD", app.submodule.path).split(/\s+/)[2];
  let at;
  try {
    at = JSON.parse(git(ROOT, "show", `${pinned}:package.json`)).version;
  } catch {
    /* a commit this checkout doesn't have */
  }
  return { version: at, sha: pinned };
}

function apply(dir, app) {
  if (app.kind === "bundle") {
    cpSync(globalBundlePath, join(dir, app.bundle.to));
    if (app.bundle.versionFile) writeFileSync(join(dir, app.bundle.versionFile), `${version}\n`);
  }
  if (app.kind === "dir") {
    for (const c of app.copy) {
      for (const f of c.files) {
        const src = join(ROOT, c.from, f);
        const dest = join(dir, c.to, f);
        rmSync(dest, { recursive: true, force: true }); // drop files the new build no longer has
        if (existsSync(src)) cpSync(src, dest, { recursive: true });
      }
    }
  }
  if (app.kind === "submodule") {
    git(dir, "update-index", "--cacheinfo", `160000,${sha},${app.submodule.path}`);
  }
  for (const lock of app.locks ?? []) {
    const file = join(dir, lock.file);
    const patched = patchNpmLock(readFileSync(file, "utf8"), lock.prefix, version);
    // No entries under the prefix means the list is wrong, not that there is nothing to do.
    if (!patched.matched) throw new Error(`${lock.file} has no @page-assistant entries under ${lock.prefix}/`);
    writeFileSync(file, patched.text);
  }
  for (const pin of app.pins ?? []) {
    const file = join(dir, pin.file);
    writeFileSync(file, applyPin(readFileSync(file, "utf8"), pin, { sha, version }));
  }
}

async function exportNames(rel) {
  const file = join(ROOT, rel);
  if (!existsSync(file)) return undefined;
  try {
    return new Set(Object.keys(await import(pathToFileURL(file).href)));
  } catch {
    return undefined; // reported per app as "package not checked"
  }
}

function report(rows) {
  const width = Math.max(...rows.map((r) => r.app.length), 3);
  const text = rows.map((r) => `${r.app.padEnd(width)}  ${r.outcome}${r.detail ? `: ${r.detail}` : ""}`).join("\n");
  console.log(`page-assistant ${version} (${sha.slice(0, 7)})${DRY ? " — dry run, nothing pushed" : ""}\n${text}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [`### page-assistant ${version}${DRY ? " (dry run)" : ""}`, "", "| App | Outcome | Detail |", "|---|---|---|",
      ...rows.map((r) => `| ${r.app} | ${r.outcome} | ${(r.detail ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")} |`)];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join("\n") + "\n");
  }
}

function fail(message) {
  console.error(`propagate: ${message}`);
  process.exit(1);
}
