// The propagate workflow's decisions, without git, gh or a network: the app list is valid, each
// app's pins still match its real files' shape, locks and pins change only what they should, and
// a name an app uses that a release drops is caught; only a patch release for an app, with every
// check passed, is merged without a person.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  applyPin,
  automergePlan,
  changelogBetween,
  compareVersions,
  evaluateChecks,
  isPatchBump,
  loadGlobalBundle,
  mergeReadiness,
  missingNames,
  patchNpmLock,
  prBody,
  validateApps,
} from "./lib.mjs";

const repo = new URL("../../", import.meta.url);
const read = (p) => readFile(new URL(p, repo), "utf8");

test("apps.json is valid", async () => {
  const { apps } = JSON.parse(await read("scripts/propagate/apps.json"));
  assert.deepEqual(validateApps(apps), []);
});

test("validateApps names what is wrong", () => {
  const errors = validateApps([
    { name: "a", repo: "nope", kind: "bundle" },
    { name: "a", repo: "o/r", kind: "dir", copy: [{ from: "x" }] },
    { name: "b", repo: "o/r", kind: "submodule", submodule: { path: "v" }, pins: [{ file: "f", pattern: "PIN = x", value: "sha" }] },
    { name: "c", repo: "o/r", kind: "bundle", bundle: { to: "x.js" }, automerge: "no" },
  ]);
  assert.ok(errors.some((e) => e.includes("automerge must be true or false")));
  assert.ok(errors.some((e) => e.includes("repo must be owner/name")));
  assert.ok(errors.some((e) => e.includes("bundle.to is required")));
  assert.ok(errors.some((e) => e.includes("duplicate name")));
  assert.ok(errors.some((e) => e.includes("every copy needs")));
  assert.ok(errors.some((e) => e.includes("capture group")));
});

test("compareVersions", () => {
  assert.equal(compareVersions("0.6.1", "0.7.2"), -1);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.7.2", "0.7.2"), 0);
  assert.equal(compareVersions(undefined, "0.1.0"), -1);
});

test("changelogBetween takes the sections after the app's version, up to the new one", () => {
  const log = "# Changelog\n\n## 0.7.2 — c\n\nC\n\n## 0.7.1\n\nB\n\n## 0.6.1 — a\n\nA\n\n## 0.6.0\n\nZ\n";
  assert.equal(changelogBetween(log, "0.6.1", "0.7.2"), "## 0.7.2 — c\n\nC\n\n## 0.7.1\n\nB");
  assert.equal(changelogBetween(log, "0.6.1", "0.7.1"), "## 0.7.1\n\nB");
  assert.equal(changelogBetween(log, undefined, "0.7.2"), "## 0.7.2 — c\n\nC", "unknown start: only the new section");
});

test("patchNpmLock moves only the vendored page-assistant entries", () => {
  const lock = {
    name: "app",
    packages: {
      "": { name: "app" },
      "vendor/page-assistant/packages/widget": { name: "@page-assistant/widget", version: "0.6.1", dependencies: { "@page-assistant/core": "0.6.1", express: "^4" } },
      "vendor/page-assistant/packages/core": { name: "@page-assistant/core", version: "0.6.1" },
      "node_modules/@page-assistant/widget": { resolved: "vendor/page-assistant/packages/widget", link: true },
      "node_modules/left-pad": { name: "left-pad", version: "0.6.1" },
    },
  };
  const { text, changed } = patchNpmLock(JSON.stringify(lock, null, 2) + "\n", "vendor/page-assistant", "0.7.2");
  const out = JSON.parse(text);
  assert.equal(changed, 2);
  assert.equal(out.packages["vendor/page-assistant/packages/widget"].version, "0.7.2");
  assert.deepEqual(out.packages["vendor/page-assistant/packages/widget"].dependencies, { "@page-assistant/core": "0.7.2", express: "^4" });
  assert.equal(out.packages["node_modules/left-pad"].version, "0.6.1");
  assert.ok(text.endsWith("\n") && text.startsWith('{\n  "name"'));
});

test("applyPin replaces the captured value and refuses a pattern that stopped matching", () => {
  const src = 'const PIN = "c42b6428949053f1b36752b6eea5535e9732bdd9"; // 0.6.0\n';
  const pin = { file: "scripts/ensure.mjs", pattern: 'const PIN = "([0-9a-f]{40})"', value: "sha" };
  assert.equal(applyPin(src, pin, { sha: "a".repeat(40), version: "0.7.2" }), `const PIN = "${"a".repeat(40)}"; // 0.6.0\n`);
  assert.throws(() => applyPin("const PIN = 'x'", pin, { sha: "a", version: "b" }), /no longer matches/);
});

test("missingNames catches a global or import an app uses that the release lacks", async () => {
  const globals = loadGlobalBundle(await read("packages/widget/dist/page-assistant.global.js"));
  const exports = { "@page-assistant/widget": new Set(Object.keys(globals.PageAssistantBundle)) };
  assert.deepEqual(
    missingNames(
      { globals: ["init", "supabaseChatHistoryAdapter", "PageAssistantBundle.capability"], imports: { "@page-assistant/widget": ["PageAssistant", "capability"] } },
      { globals, exports }
    ),
    []
  );
  assert.deepEqual(
    missingNames({ globals: ["noSuchThing"], imports: { "@page-assistant/widget": ["gone"], "@page-assistant/other": ["x"] } }, { globals, exports }),
    ["window.PageAssistant.noSuchThing", "@page-assistant/widget: gone", "@page-assistant/other (package not checked)"]
  );
});

test("every app's globals and imports exist in this build", async () => {
  const { apps } = JSON.parse(await read("scripts/propagate/apps.json"));
  const globals = loadGlobalBundle(await read("packages/widget/dist/page-assistant.global.js"));
  const exports = {
    "@page-assistant/widget": new Set(Object.keys(globals.PageAssistantBundle)),
    "@page-assistant/core": new Set(Object.keys(await import(new URL("packages/core/dist/index.js", repo)))),
    "@page-assistant/server": new Set(Object.keys(await import(new URL("packages/server/dist/index.js", repo)))),
  };
  for (const app of apps) assert.deepEqual(missingNames(app.uses, { globals, exports }), [], app.name);
});

test("prBody says what moved, flags missing names, and stays under GitHub's limit", () => {
  const body = prBody({
    app: { name: "x", checkAfterDeploy: "open the assistant" },
    from: "0.6.1",
    to: "0.7.2",
    sha: "c8d7e11" + "0".repeat(33),
    files: ["public/vendor/page-assistant.global.js"],
    missing: ["window.PageAssistant.gone"],
    changelog: "## 0.7.2\n\n" + "x".repeat(70_000),
  });
  assert.match(body, /from \*\*0\.6\.1\*\* to \*\*0\.7\.2\*\*/);
  assert.match(body, /no longer has/);
  assert.match(body, /After deploy:\*\* open the assistant/);
  assert.ok(body.length < 65_536);
});

test("isPatchBump: same major and minor, higher patch, for the version this app is on", () => {
  assert.equal(isPatchBump("0.8.0", "0.8.1"), true);
  assert.equal(isPatchBump("1.2.3", "1.2.10"), true);
  assert.equal(isPatchBump("0.8.1", "0.8.1"), false, "same version");
  assert.equal(isPatchBump("0.8.2", "0.8.1"), false, "downgrade");
  assert.equal(isPatchBump("0.7.4", "0.8.1"), false, "an app on 0.7.x getting 0.8.1 is a minor jump for it");
  assert.equal(isPatchBump("0.8.0", "0.9.0"), false);
  assert.equal(isPatchBump("0.8.0", "1.0.0"), false);
  assert.equal(isPatchBump("1.8.0", "2.8.1"), false);
  assert.equal(isPatchBump(undefined, "0.8.1"), false, "unknown current version");
  assert.equal(isPatchBump("0.8.0-beta.1", "0.8.1"), false);
});

test("automergePlan merges only patches, and honours both opt-outs and missing names", () => {
  const app = { name: "x" };
  assert.equal(automergePlan({ app, from: "0.8.0", to: "0.8.1" }).merge, true);
  assert.match(automergePlan({ app, from: "0.7.4", to: "0.8.1" }).reason, /minor\/major for this app: 0\.7\.4 → 0\.8\.1/);
  assert.match(automergePlan({ app, from: undefined, to: "0.8.1" }).reason, /unknown/);
  assert.match(automergePlan({ app: { automerge: false }, from: "0.8.0", to: "0.8.1" }).reason, /apps\.json/);
  assert.match(automergePlan({ app, from: "0.8.0", to: "0.8.1", enabled: false }).reason, /off for this run/);
  assert.match(automergePlan({ app, from: "0.8.0", to: "0.8.1", missing: ["window.PageAssistant.gone"] }).reason, /draft/);
});

test("evaluateChecks: nothing yet, pending, failed, passed", () => {
  const vercel = (state) => ({ context: "Vercel", state });
  const run = (status, conclusion = null) => ({ name: "test", status, conclusion });
  assert.equal(evaluateChecks({}).state, "none");
  assert.equal(evaluateChecks({ statuses: [vercel("pending")] }).state, "pending");
  assert.equal(evaluateChecks({ statuses: [vercel("success")], checkRuns: [run("in_progress")] }).state, "pending");
  const failed = evaluateChecks({ statuses: [vercel("success"), { context: "CodeRabbit", state: "error" }], checkRuns: [run("in_progress")] });
  assert.equal(failed.state, "failure", "one failure is enough, even with others still running");
  assert.deepEqual(failed.failing, ["CodeRabbit"]);
  for (const bad of ["failure", "cancelled", "timed_out", "action_required", "stale", "startup_failure"]) {
    assert.equal(evaluateChecks({ checkRuns: [run("completed", bad)] }).state, "failure", bad);
  }
  const ok = evaluateChecks({
    statuses: [vercel("success")],
    checkRuns: [run("completed", "success"), { name: "lint", status: "completed", conclusion: "skipped" }, { name: "x", status: "completed", conclusion: "neutral" }],
  });
  assert.equal(ok.state, "success");
  assert.equal(ok.total, 4);
  assert.equal(ok.key, "Vercel,lint,test,x");
});

test("mergeReadiness: merges a clean PR with propagate's own head, waits while GitHub works it out", () => {
  const view = { state: "OPEN", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: "abc" };
  assert.equal(mergeReadiness(view, "abc").verdict, "ready");
  assert.equal(mergeReadiness({ ...view, mergeStateStatus: "HAS_HOOKS" }, "abc").verdict, "ready");
  assert.equal(mergeReadiness({ ...view, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }, "abc").verdict, "wait");
  assert.equal(mergeReadiness({ ...view, mergeStateStatus: "UNSTABLE" }, "abc").verdict, "wait");
  assert.match(mergeReadiness({ ...view, headRefOid: "def" }, "abc").reason, /didn't push/);
  assert.match(mergeReadiness({ ...view, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }, "abc").reason, /conflict/);
  assert.match(mergeReadiness({ ...view, isDraft: true }, "abc").reason, /draft/);
  assert.match(mergeReadiness({ ...view, state: "MERGED" }, "abc").reason, /merged/);
  assert.match(mergeReadiness({ ...view, mergeStateStatus: "BLOCKED" }, "abc").reason, /BLOCKED/);
});

test("prBody says whether this PR merges itself", () => {
  const base = { app: { name: "x" }, from: "0.8.0", to: "0.8.1", sha: "a".repeat(40), files: [], missing: [] };
  assert.match(prBody({ ...base, plan: { merge: true } }), /merges it itself once every check here passes/);
  assert.match(prBody({ ...base, plan: automergePlan({ app: {}, from: "0.7.4", to: "0.8.1" }) }), /Nothing here is merged automatically \(minor\/major/);
});
