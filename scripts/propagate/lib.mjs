// Pure helpers for propagate.mjs, kept apart so they can be tested without git, gh or a network.
import vm from "node:vm";

export const KINDS = ["bundle", "dir", "submodule", "pin"];

/** -1, 0 or 1. Plain x.y.z; anything unparsable sorts first. */
export function compareVersions(a, b) {
  const parse = (v) => (/^\d+\.\d+\.\d+$/.test(v ?? "") ? v.split(".").map(Number) : null);
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/**
 * True when `to` is a patch release for an app on `from`: same major and minor, higher patch
 * (0.8.0 → 0.8.1). An app on 0.7.x getting 0.8.1 is not, whatever the release itself is.
 */
export function isPatchBump(from, to) {
  const parse = (v) => (/^\d+\.\d+\.\d+$/.test(v ?? "") ? v.split(".").map(Number) : null);
  const a = parse(from);
  const b = parse(to);
  return Boolean(a && b && a[0] === b[0] && a[1] === b[1] && b[2] > a[2]);
}

/**
 * Whether propagate should merge this app's PR itself once its checks pass, and why (not).
 * Only patch releases for that app merge themselves; minor and major ones wait for a person.
 */
export function automergePlan({ app, from, to, missing = [], enabled = true }) {
  if (!enabled) return { merge: false, reason: "PR only (auto-merge off for this run)" };
  if (app.automerge === false) return { merge: false, reason: "PR only (auto-merge off for this app in apps.json)" };
  if (missing.length) return { merge: false, reason: "PR only (draft: names missing)" };
  if (!from) return { merge: false, reason: "PR only (app's current version unknown)" };
  if (!isPatchBump(from, to)) return { merge: false, reason: `PR only (minor/major for this app: ${from} → ${to})` };
  return { merge: true, reason: `patch for this app: ${from} → ${to}` };
}

// Check-run conclusions that don't block a merge. Anything else that finished is a failure.
const PASSING = new Set(["success", "neutral", "skipped"]);

/**
 * Sums up a commit's checks: its commit statuses (Vercel, CodeRabbit) and check runs (Actions).
 * state is "none" (nothing reported yet), "pending", "failure" or "success". `key` names every
 * check, so a caller can tell a new check turning up from the same set still passing.
 */
export function evaluateChecks({ statuses = [], checkRuns = [] }) {
  const all = [
    ...statuses.map((s) => ({ name: s.context, state: s.state === "success" ? "ok" : s.state === "pending" ? "pending" : "fail" })),
    ...checkRuns.map((r) => ({
      name: r.name,
      state: r.status !== "completed" ? "pending" : PASSING.has(r.conclusion) ? "ok" : "fail",
    })),
  ];
  const failing = all.filter((c) => c.state === "fail").map((c) => c.name);
  const pending = all.filter((c) => c.state === "pending").map((c) => c.name);
  const state = !all.length ? "none" : failing.length ? "failure" : pending.length ? "pending" : "success";
  return { state, total: all.length, failing, pending, key: all.map((c) => c.name).sort().join(",") };
}

/**
 * Polls a commit's checks until they all pass and stay passing for SETTLE, one fails, nothing
 * has reported FIRST_CHECK after `since`, or `until` passes. Returns the last evaluation.
 * `read` returns { statuses, checkRuns }; a failed read is retried, three in a row end the wait
 * with that error. `now` and `sleep` are passed in so tests can run it on a fake clock.
 */
export async function waitForChecks({ read, since, until, timings, now: clock = Date.now, sleep }) {
  const { FIRST_CHECK, MIN_AGE, SETTLE, POLL } = timings;
  let green; // { key, at }: when this exact set of checks was first seen all passing
  let errors = 0;
  for (;;) {
    let checks;
    try {
      checks = evaluateChecks(await read());
      errors = 0;
    } catch (e) {
      if (++errors >= 3) throw e;
    }
    const now = clock();
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

/**
 * Whether GitHub will take the merge now ("ready"), might soon ("wait": still working out
 * mergeability or settling checks), or won't ("stop", with why). `view` is `gh pr view --json
 * state,isDraft,mergeable,mergeStateStatus,headRefOid`; `head` is the commit propagate pushed.
 */
export function mergeReadiness(view, head) {
  if (view.state !== "OPEN") return { verdict: "stop", reason: `PR is ${String(view.state).toLowerCase()}` };
  if (view.isDraft) return { verdict: "stop", reason: "PR is a draft" };
  if (head && view.headRefOid !== head) return { verdict: "stop", reason: "PR has commits propagate didn't push" };
  if (view.mergeable === "CONFLICTING" || view.mergeStateStatus === "DIRTY") return { verdict: "stop", reason: "merge conflict" };
  if (view.mergeable === "UNKNOWN" || view.mergeStateStatus === "UNKNOWN") return { verdict: "wait" };
  if (["CLEAN", "HAS_HOOKS"].includes(view.mergeStateStatus)) return { verdict: "ready" };
  if (view.mergeStateStatus === "UNSTABLE") return { verdict: "wait" };
  return { verdict: "stop", reason: `GitHub says the PR can't merge yet (${view.mergeStateStatus})` };
}

/** Everything wrong with the app list, as readable lines. Empty when it is usable. */
export function validateApps(apps) {
  const errors = [];
  if (!Array.isArray(apps) || !apps.length) return ["the app list is empty"];
  const names = new Set();
  for (const [i, app] of apps.entries()) {
    const at = `apps[${i}]${app?.name ? ` (${app.name})` : ""}`;
    if (!app?.name) errors.push(`${at}: name is required`);
    else if (names.has(app.name)) errors.push(`${at}: duplicate name`);
    names.add(app?.name);
    if (!/^[\w.-]+\/[\w.-]+$/.test(app?.repo ?? "")) errors.push(`${at}: repo must be owner/name`);
    if (!KINDS.includes(app?.kind)) errors.push(`${at}: kind must be one of ${KINDS.join(", ")}`);
    if (app?.kind === "bundle" && !app.bundle?.to) errors.push(`${at}: bundle.to is required`);
    if (app?.kind === "dir") {
      if (!Array.isArray(app.copy) || !app.copy.length) errors.push(`${at}: copy is required`);
      for (const c of app.copy ?? []) {
        if (!c.from || !c.to || !Array.isArray(c.files) || !c.files.length) {
          errors.push(`${at}: every copy needs from, to and files`);
        }
      }
    }
    if (app?.automerge !== undefined && typeof app.automerge !== "boolean") errors.push(`${at}: automerge must be true or false`);
    if (app?.kind === "submodule" && !app.submodule?.path) errors.push(`${at}: submodule.path is required`);
    if (app?.kind === "pin" && !(app.pins ?? []).some((p) => p.value === "sha")) {
      errors.push(`${at}: a "pin" app needs a pin with value "sha"`);
    }
    for (const l of app?.locks ?? []) if (!l.file || !l.prefix) errors.push(`${at}: every lock needs file and prefix`);
    for (const p of app?.pins ?? []) {
      if (!p.file || !p.pattern || !["sha", "version"].includes(p.value)) {
        errors.push(`${at}: every pin needs file, pattern and value ("sha" or "version")`);
        continue;
      }
      try {
        // `(?:pattern)|` always matches "", so the result's length is the group count + 1.
        if (new RegExp(`(?:${p.pattern})|`).exec("").length < 2) {
          errors.push(`${at}: pin pattern for ${p.file} needs a capture group around the value`);
        }
      } catch (e) {
        errors.push(`${at}: pin pattern for ${p.file} is not a valid regex (${e.message})`);
      }
    }
  }
  return errors;
}

/**
 * The CHANGELOG sections newer than `from`, up to and including `to`, newest first, as written.
 * `from` unknown → only the `to` section, so a PR body never balloons into the whole history.
 */
export function changelogBetween(changelog, from, to) {
  const parts = changelog.split(/^(?=## \d+\.\d+\.\d+)/m).slice(1);
  return parts
    .filter((section) => {
      const v = section.match(/^## (\d+\.\d+\.\d+)/)[1];
      if (compareVersions(v, to) > 0) return false;
      return compareVersions(from, "0.0.0") > 0 ? compareVersions(v, from) > 0 : v === to;
    })
    .map((s) => s.trimEnd())
    .join("\n\n");
}

/**
 * Sets `version` on every @page-assistant package in an npm lockfile that lives under
 * `prefix` (e.g. "vendor/page-assistant"). Returns the new text and how many entries changed.
 * Only touches those entries, and keeps the file's own indentation.
 */
export function patchNpmLock(text, prefix, version) {
  const lock = JSON.parse(text);
  let changed = 0;
  let matched = 0;
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith(`${prefix}/`) || !entry?.name?.startsWith("@page-assistant/")) continue;
    matched++;
    // Each package also records the version of its sibling it depends on (widget → core).
    const siblings = Object.keys(entry.dependencies ?? {}).filter((d) => d.startsWith("@page-assistant/"));
    if (entry.version === version && siblings.every((d) => entry.dependencies[d] === version)) continue;
    entry.version = version;
    for (const d of siblings) entry.dependencies[d] = version;
    changed++;
  }
  const indent = text.match(/^\{\n([ \t]+)"/)?.[1] ?? "  ";
  return { text: JSON.stringify(lock, null, indent) + (text.endsWith("\n") ? "\n" : ""), changed, matched };
}

/**
 * Replaces the first capture group of each pin's pattern with the new sha or version.
 * Throws when a pattern no longer matches: a pin that silently stops moving is how an app ends
 * up building an older SDK than the one its PR says it has.
 */
export function applyPin(text, pin, values) {
  const re = new RegExp(pin.pattern);
  const m = re.exec(text);
  if (!m || m[1] === undefined) throw new Error(`pin pattern /${pin.pattern}/ no longer matches ${pin.file}`);
  const start = m.index + m[0].indexOf(m[1]);
  return text.slice(0, start) + values[pin.value] + text.slice(start + m[1].length);
}

/** Runs the script-tag bundle against a bare window, as a classic <script> would. */
export function loadGlobalBundle(code) {
  const window = {};
  const ctx = vm.createContext({ window });
  vm.runInContext(code, ctx);
  return { PageAssistant: window.PageAssistant ?? {}, PageAssistantBundle: ctx.PageAssistantBundle ?? {} };
}

/**
 * Names an app uses that the new version lacks. `globals` are read off `window.PageAssistant`
 * (or `window.PageAssistantBundle` for `"PageAssistantBundle.x"`); `imports` map a package
 * name to the names imported from it, checked against that package's exports.
 */
export function missingNames(uses, { globals, exports }) {
  const missing = [];
  for (const name of uses?.globals ?? []) {
    const [holder, member] = name.includes(".") ? name.split(".") : ["PageAssistant", name];
    if (!(member in (globals[holder] ?? {}))) missing.push(`window.${holder}.${member}`);
  }
  for (const [pkg, names] of Object.entries(uses?.imports ?? {})) {
    const have = exports[pkg];
    if (!have) {
      missing.push(`${pkg} (package not checked)`);
      continue;
    }
    for (const n of names) if (!have.has(n)) missing.push(`${pkg}: ${n}`);
  }
  return missing;
}

const BODY_LIMIT = 60_000;

export function prBody({ app, from, to, sha, files, missing, changelog, plan }) {
  const short = sha.slice(0, 7);
  const lines = [
    `Moves page-assistant from **${from ?? "an unknown version"}** to **${to}** ([\`${short}\`](https://github.com/philipposk/page-assistant/commit/${sha})).`,
    "",
    plan?.merge
      ? `Opened by page-assistant's propagate workflow. This is a patch release for this app, so propagate merges it itself once every check here passes, then waits for the deploy before touching the next app. If anything looks off it leaves the PR open and comments why.`
      : `Opened by page-assistant's propagate workflow. Nothing here is merged automatically${plan?.reason ? ` (${plan.reason.replace(/^PR only \((.*)\)$/, "$1")})` : ""}; ${app.deploysOnMerge === false ? "merging does not deploy by itself" : "merging this deploys it"}.`,
    "",
    "**Changed:**",
    ...files.map((f) => `- \`${f}\``),
    "",
    missing.length
      ? `**⚠ This app uses names ${to} no longer has**, so this PR is a draft:\n${missing.map((m) => `- \`${m}\``).join("\n")}`
      : `**Check:** every page-assistant name this app uses exists in ${to}.`,
  ];
  if (app.checkAfterDeploy) lines.push("", `**After deploy:** ${app.checkAfterDeploy}`);
  if (changelog) lines.push("", "## What changed in page-assistant", "", changelog);
  const body = lines.join("\n");
  return body.length > BODY_LIMIT
    ? body.slice(0, BODY_LIMIT) + "\n\n…cut here; the rest is in page-assistant's CHANGELOG.md."
    : body;
}
