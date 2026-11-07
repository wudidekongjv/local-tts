import esbuild from "esbuild";

const result = await esbuild.build({
    entryPoints: ["src/index.js"],
    bundle: true,
    format: "esm",
    outfile: "dist/local-asr.js",
    target: ["es2020"],
    minify: false,
    legalComments: "none",
    logLevel: "warning",
});

console.log("built dist/local-asr.js", result.errors.length ? "with errors" : "ok");
