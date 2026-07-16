// Bundles the extension (and its runtime deps: axios, simple-git) into a single
// dist/extension.js, so the packaged .vsix ships ~5 files instead of ~300.
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    outfile: "dist/extension.js",
    // vscode is provided by the host at runtime and must NOT be bundled.
    external: ["vscode"],
    sourcemap: !production,
    minify: production,
    logLevel: "info",
  });

  if (watch) {
    await ctx.watch();
    console.log("[esbuild] watching…");
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
