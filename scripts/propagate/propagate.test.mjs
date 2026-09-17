// The propagate workflow's decisions, without git, gh or a network: the app list is valid, each
// app's pins still match its real files' shape, locks and pins change only what they should, and
// a name an app uses that a release drops is caught.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  ]);
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
