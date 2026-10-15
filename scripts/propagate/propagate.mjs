#!/usr/bin/env node
// Opens a pull request in every app that embeds page-assistant, moving it to this checkout's
// version. Run by .github/workflows/propagate.yml when a version bump lands on main; run it by
// hand with --dry-run to see what each app would get without pushing or merging anything.
//
//   node scripts/propagate/propagate.mjs [--apps samos-companion,topia] [--dry-run] [--keep]
//                                        [--no-automerge] [--automerge-minutes 90]
//
// Needs a built checkout (`npm run build`), `git`, and `gh` signed in with a token that can push
// branches, open and merge PRs, and read checks in the app repos. The apps and how each embeds
// the SDK are listed in scripts/propagate/apps.json.
//
// Patch releases merge themselves. When the new version is a patch for an app (0.8.0 → 0.8.1,
// judged from the version that app is on now), propagate merges that app's PR once every check
// on it has passed, then waits for the app's deploy of the merge commit to report success before
// it touches the next app: one deploy at a time, never a burst. Minor and major releases (and
// apps with "automerge": false) only get a PR, and a person merges it. GitHub's own auto-merge
// needs branch protection, which private repos on the free plan don't have, so the waiting is
// done here. Anything unexpected leaves the PR open with a comment saying why.
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
  automergePlan,
  evaluateChecks,
  mergeReadiness,
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
const AUTOMERGE = !flag("no-automerge");

// How long auto-merge waits. The run as a whole stops merging after --automerge-minutes (keep it
// under the workflow's timeout-minutes, so a run is never killed halfway through a wait).
const MIN = 60_000;
const BUDGET = Number(option("automerge-minutes") ?? 90) * MIN;
const CHECKS_TIMEOUT = 20 * MIN; // from opening the PR to every check on it finished
const FIRST_CHECK = 5 * MIN; // no check by then: the app has none, so don't merge blind
const MIN_AGE = 3 * MIN; // checks register one by one; don't trust an early "all passed"
const SETTLE = 1 * MIN; // the same set of checks must stay green this long
const DEPLOY_TIMEOUT = 15 * MIN; // from merging to the deploy of the merge commit reporting back
const POLL = 30_000;
const started = Date.now();

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
if (!DRY) await autoMerge(results);
report(results);
process.exit(results.some((r) => r.outcome === "failed" || r.deployFailed) ? 1 : 0);

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
  const plan = automergePlan({ app, from: from.version, to: version, missing, enabled: AUTOMERGE });
  const body = prBody({ app, from: from.version, to: version, sha, files, missing, plan, changelog: changelogBetween(changelog, from.version, version) });

  if (DRY) {
    return {
      outcome: "would open PR",
      merge: plan.merge ? `would auto-merge once checks pass (${plan.reason})` : plan.reason,
      detail: `${from.version ?? from.sha?.slice(0, 7) ?? "?"} → ${version}; ${files.length} file(s)${missing.length ? `; MISSING ${missing.join(", ")}` : ""}${KEEP ? `; clone at ${dir}` : ""}`,
    };
  }

  const me = JSON.parse(run("gh", ["api", "user"]));
  git(dir, "add", "-A"); // a new build can add files, not only change them
  git(dir, "-c", `user.name=${me.name || me.login}`, "-c", `user.email=${me.id}+${me.login}@users.noreply.github.com`,
    "commit", "-q", "-m", `${title}\n\nFrom philipposk/page-assistant@${sha.slice(0, 7)}.`);
  git(dir, "push", "-q", "origin", branch);
  const head = git(dir, "rev-parse", "HEAD");
  const url = run("gh", ["pr", "create", "--repo", app.repo, "--base", base, "--head", branch, "--title", title,
    "--body", body, ...(missing.length ? ["--draft"] : [])]);
  return {
    outcome: missing.length ? "draft PR (names missing)" : "PR opened",
    detail: url,
    merge: plan.merge ? "waiting" : plan.reason,
    pr: plan.merge ? { url, head, openedAt: Date.now(), repo: app.repo, deploys: app.deploysOnMerge !== false } : undefined,
  };
}

// --- auto-merge, one app at a time ---------------------------------------------------------

/**
 * Merges the PRs that are patch releases for their app, in apps.json order. Their checks have
 * been running since the PRs were opened above; each merge waits for the one before it to
 * deploy. Once a deploy doesn't confirm, the rest are left open: something is wrong, and a
 * person should look before more apps change.
 */
async function autoMerge(rows) {
  let halted;
  for (const r of rows.filter((x) => x.pr)) {
    let outcome;
    if (halted) outcome = { reason: halted };
    else {
      try {
        outcome = await mergeOne(r.pr);
      } catch (e) {
        outcome = { reason: `GitHub API error: ${errorText(e)}` };
      }
    }
    if (outcome.merged) {
      r.merge = outcome.note;
      if (outcome.deployProblem) {
        r.deployFailed = true;
        halted = `${r.app}'s deploy didn't confirm earlier in this run, so auto-merge stopped`;
        comment(r.pr.url, `Merged by propagate (patch release), but the deploy of the merge commit didn't confirm: ${outcome.deployProblem}. Check the app. Propagate stopped auto-merging the remaining apps in this run.`);
      }
    } else {
      r.merge = `left open: ${outcome.reason}`;
      comment(r.pr.url, `Not auto-merged: ${outcome.reason}. Propagate merges a patch release by itself only when every check on the PR has passed and the previous app deployed fine; merge this by hand once you're happy with it.`);
    }
    console.log(`${r.app}: ${r.merge}`);
  }
}

/** Waits for one PR's checks, merges it, and waits for the deploy. Never throws for a "no". */
async function mergeOne(pr) {
  const leftOpen = (reason) => ({ reason });

  // 1. Every check on the PR's head commit passed, and stayed that way for a minute.
  // The run must still have time to watch the deploy after merging.
  const lastMerge = started + BUDGET - DEPLOY_TIMEOUT;
  const outOfTime = "not enough time left in this run to merge and watch the deploy";
  if (Date.now() >= lastMerge) return leftOpen(outOfTime);
  const checks = await waitForChecks(pr.repo, pr.head, { since: pr.openedAt, until: Math.min(pr.openedAt + CHECKS_TIMEOUT, lastMerge) });
  if (checks.state === "failure") return leftOpen(`check failed: ${checks.failing.join(", ")}`);
  if (checks.state !== "success" && Date.now() >= lastMerge) return leftOpen(outOfTime);
  if (checks.state === "none") return leftOpen("no checks ran on this PR, so merging it would be blind");
  if (checks.state !== "success") return leftOpen(`checks still pending after ${CHECKS_TIMEOUT / MIN} min: ${checks.pending.join(", ")}`);

  // 2. GitHub agrees it can merge, and nobody pushed to the branch since propagate did.
  let ready;
  for (let i = 0; i < 8; i++) {
    const view = JSON.parse(run("gh", ["pr", "view", pr.url, "--json", "state,isDraft,mergeable,mergeStateStatus,headRefOid"]));
    ready = mergeReadiness(view, pr.head);
    if (ready.verdict !== "wait") break;
    await sleep(15_000);
  }
  if (ready.verdict !== "ready") return leftOpen(ready.reason ?? "GitHub is still working out whether it can merge");

  // 3. Merge (a merge commit; the branch stays) and find the commit it made.
  run("gh", ["pr", "merge", pr.url, "--merge", "--match-head-commit", pr.head]);
  if (!pr.deploys) return { merged: true, note: "merged (app doesn't deploy on merge)" };

  // 4. The app's checks on the merge commit (its production deploy) all passed.
  let mergeSha = "";
  let deploy;
  try {
    mergeSha = run("gh", ["pr", "view", pr.url, "--json", "mergeCommit", "--jq", ".mergeCommit.oid"]);
    deploy = await waitForChecks(pr.repo, mergeSha, { since: Date.now(), until: Date.now() + DEPLOY_TIMEOUT });
  } catch (e) {
    return { merged: true, note: `merged ${mergeSha.slice(0, 7)}; deploy unknown`, deployProblem: `couldn't read its status (${errorText(e)})` };
  }
  if (deploy.state === "success") return { merged: true, note: `merged ${mergeSha.slice(0, 7)}, deploy ok` };
  const problem =
    deploy.state === "none" ? "nothing reported a deploy for it"
    : deploy.state === "failure" ? `failed: ${deploy.failing.join(", ")}`
    : `still pending after ${DEPLOY_TIMEOUT / MIN} min: ${deploy.pending.join(", ")}`;
  return { merged: true, note: `merged ${mergeSha.slice(0, 7)}; deploy ${problem}`, deployProblem: problem };
}

/**
 * Polls a commit's checks until they all pass and stay passing for SETTLE, one fails, nothing
 * has reported FIRST_CHECK after `since`, or `until` passes. Returns the last evaluation.
 * A failed API call is retried; three in a row end the wait with that error.
 */
async function waitForChecks(repo, ref, { since, until }) {
  let green; // { key, at }: when this exact set of checks was first seen all passing
  let errors = 0;
  for (;;) {
    let checks;
    try {
      const statuses = JSON.parse(run("gh", ["api", `repos/${repo}/commits/${ref}/status?per_page=100`])).statuses;
      const checkRuns = JSON.parse(run("gh", ["api", `repos/${repo}/commits/${ref}/check-runs?per_page=100`])).check_runs;
      checks = evaluateChecks({ statuses, checkRuns });
      errors = 0;
    } catch (e) {
      if (++errors >= 3) throw e;
    }
    const now = Date.now();
    if (checks) {
      if (checks.state === "failure") return checks;
      if (checks.state === "none" && now - since >= FIRST_CHECK) return checks;
      if (checks.state === "success") {
        if (green?.key !== checks.key) green = { key: checks.key, at: now };
        if (now - green.at >= SETTLE && now - since >= Math.min(MIN_AGE, until - since)) return checks;
      } else green = undefined;
    }
    if (now >= until) {
      if (!checks) return { state: "pending", pending: ["(couldn't read checks)"], failing: [] };
      // Green but not for long enough yet still counts as waiting, not as passed.
      return checks.state === "success" ? { ...checks, state: "pending", pending: ["(not settled yet)"] } : checks;
    }
    await sleep(Math.min(POLL, Math.max(until - now, 1000)));
  }
}

function comment(url, body) {
  try {
    run("gh", ["pr", "comment", url, "--body", body]);
  } catch (e) {
    console.error(`could not comment on ${url}: ${errorText(e)}`);
  }
}

function errorText(e) {
  const text = (e.stderr?.toString().trim() || e.message).split("\n")[0];
  // A fine-grained token without these reads gets a 403 on statuses and check runs.
  return /403|Resource not accessible/i.test(text)
    ? `${text} (APPS_PR_TOKEN needs Checks: read and Commit statuses: read on this repo)`
    : text;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    // A clear message beats git's "cannot add to the index": it means the app has no submodule
    // there (yet), so either the embed change hasn't merged or apps.json names the wrong path.
    if (!git(dir, "ls-tree", "HEAD", app.submodule.path)) {
      throw new Error(`no submodule at ${app.submodule.path} on the app's default branch`);
    }
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
  const text = rows
    .map((r) => `${r.app.padEnd(width)}  ${r.outcome}${r.detail ? `: ${r.detail}` : ""}${r.merge ? `\n${" ".repeat(width)}  → ${r.merge}` : ""}`)
    .join("\n");
  console.log(`page-assistant ${version} (${sha.slice(0, 7)})${DRY ? " — dry run, nothing pushed or merged" : ""}${AUTOMERGE ? "" : " — auto-merge off"}\n${text}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const cell = (s) => (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
    const md = [`### page-assistant ${version}${DRY ? " (dry run)" : ""}`, "", "| App | Outcome | Auto-merge | Detail |", "|---|---|---|---|",
      ...rows.map((r) => `| ${r.app} | ${r.outcome} | ${cell(r.merge ?? "—")} | ${cell(r.detail)} |`)];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join("\n") + "\n");
  }
}

function fail(message) {
  console.error(`propagate: ${message}`);
  process.exit(1);
}
