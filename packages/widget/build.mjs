// Bundle the widget into a single IIFE for <script> embedding, plus an ESM build.
import { build } from "esbuild";
import { rm } from "node:fs/promises";

// Drop any stale global sourcemap from a previous (sourcemap:true) build — esbuild won't
// delete it, so it would otherwise keep riding along in the published tarball.
await rm("dist/page-assistant.global.js.map", { force: true });

const common = { entryPoints: ["src/index.ts"], bundle: true, target: "es2020" };

// No sourcemap for the minified <script> bundle — it added ~490kB to the published tarball
// for no runtime benefit. The ESM build keeps its map for consumers who bundle it.
await build({ ...common, format: "iife", globalName: "PageAssistantBundle", outfile: "dist/page-assistant.global.js", minify: true, sourcemap: false });
await build({ ...common, format: "esm", outfile: "dist/page-assistant.esm.js", sourcemap: true });

console.log("widget bundled: dist/page-assistant.global.js (script tag), dist/page-assistant.esm.js (import)");
