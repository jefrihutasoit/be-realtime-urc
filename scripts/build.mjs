// Production build that is hard to reverse-engineer from the Docker image.
//
//   1. esbuild bundles every source file into ONE file, minified, with no comments and no source map. The
//      folder structure, the original names and the comments are gone.
//   2. javascript-obfuscator rewrites that file (string array, control-flow flattening, dead code) so the
//      remaining logic is very hard to read or patch (e.g. to bypass the license check).
//
// Third-party packages (express, mqtt, mysql2 …) are kept external: they are installed normally in the image,
// so they are not bundled or obfuscated. Only OUR code is protected. Run with: npm run build.

import { build } from "esbuild";
import pkg from "../package.json" with { type: "json" };
import { readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundled = join(root, "dist", "server.bundle.mjs");
const out = join(root, "dist", "server.js");
const obfuscate = process.env.OBFUSCATE !== "0";

console.log("[build] bundling + minifying…");
await build({
  entryPoints: [join(root, "src", "server.ts")],
  outfile: bundled,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  // Keep the npm packages external (installed in the image); only our own code is bundled.
  external: [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})],
  // esbuild cannot emit a CJS file with top-level await, so the output is ESM; `banner` creates the CJS
  // globals some dependencies expect when loaded from an ESM file.
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      "import { fileURLToPath as __f } from 'node:url';",
      "import { dirname as __d } from 'node:path';",
      "const require = __cr(import.meta.url);",
      "const __filename = __f(import.meta.url);",
      "const __dirname = __d(__filename);",
    ].join(""),
  },
});

if (!obfuscate) {
  await writeFile(out, await readFile(bundled));
  await rm(bundled);
  console.log("[build] done (obfuscation skipped: OBFUSCATE=0)");
  process.exit(0);
}

console.log("[build] obfuscating…");
const { default: Obfuscator } = await import("javascript-obfuscator");
const code = await readFile(bundled, "utf8");
const result = Obfuscator.obfuscate(code, {
  // Low-overhead profile: the code is already minified and renamed by esbuild; this hides the string
  // literals and keeps names mangled without the heavy transforms (control-flow flattening, dead code,
  // numbers-to-expressions, base64 string decoding, self-defending) that slow the hot paths — the OEE
  // engine runs on every poll (every 2 s) and the summary query is compute-heavy. Still not readable or
  // easy to patch. Set OBFUSCATE=heavy for the strong profile when runtime cost is not a concern.
  target: "node",
  compact: true,
  simplify: true,
  identifierNamesGenerator: "mangled",
  stringArray: true,
  stringArrayThreshold: 0.75,
  stringArrayEncoding: [], // plain (no base64 decode on every string access)
  // Off: these add real CPU cost in hot loops.
  controlFlowFlattening: false,
  deadCodeInjection: false,
  numbersToExpressions: false,
  splitStrings: false,
  stringArrayCallsTransform: false,
  transformObjectKeys: false,
  selfDefending: false,
  // ESM: do not touch the module syntax or reserved runtime names.
  reservedStrings: ["^node:"],
  ...(process.env.OBFUSCATE === "heavy"
    ? {
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.5,
        deadCodeInjection: true,
        deadCodeInjectionThreshold: 0.2,
        stringArrayEncoding: ["base64"],
        stringArrayCallsTransform: true,
        splitStrings: true,
        splitStringsChunkLength: 10,
        selfDefending: true,
      }
    : {}),
});
await writeFile(out, result.getObfuscatedCode());
await rm(bundled);
console.log(`[build] done → dist/server.js (${(result.getObfuscatedCode().length / 1024).toFixed(0)} KB)`);
