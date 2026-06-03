// Bundle the widget into a single IIFE for <script> embedding, plus an ESM build.
import { build } from "esbuild";

const common = { entryPoints: ["src/index.ts"], bundle: true, sourcemap: true, target: "es2020" };

await build({ ...common, format: "iife", globalName: "PageAssistantBundle", outfile: "dist/page-assistant.global.js", minify: true });
await build({ ...common, format: "esm", outfile: "dist/page-assistant.esm.js" });

console.log("widget bundled: dist/page-assistant.global.js (script tag), dist/page-assistant.esm.js (import)");
