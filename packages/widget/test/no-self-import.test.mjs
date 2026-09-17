// Next.js (Turbopack) splits a module's code from its re-exports and can run the code first.
// 0.6.1's index.ts imported itself and spread its own exports at load, so the spread hit
// re-exports that did not exist yet and `import("@page-assistant/widget")` threw
// "Cannot read properties of undefined (reading 'ASSISTANT_SETTINGS_STORAGE_KEY')".
// Only the script-tag entry, src/global.ts, may import the module's own index.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const IMPORTS_INDEX = /\bfrom\s*["']\.\/index(?:\.js)?["']|\bimport\s*\(\s*["']\.\/index(?:\.js)?["']\s*\)/;

async function filesIn(dir, ext) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) out.push(...(await filesIn(path, ext)));
    else if (entry.name.endsWith(ext)) out.push(path);
  }
  return out;
}

test("no module the package exports imports the package index", async () => {
  const src = new URL("../src/", import.meta.url);
  const offenders = [];
  for (const file of await filesIn(src, ".ts")) {
    if (file.pathname.endsWith("/src/global.ts")) continue;
    if (IMPORTS_INDEX.test(await readFile(file, "utf8"))) offenders.push(file.pathname.split("/src/")[1]);
  }
  assert.deepEqual(offenders, [], `these import ./index.js and form a cycle through the package entry: ${offenders.join(", ")}`);
});

test("the built package entry does not import itself", async () => {
  const code = await readFile(new URL("../dist/index.js", import.meta.url), "utf8");
  assert.ok(!IMPORTS_INDEX.test(code), "dist/index.js imports ./index.js");
});
