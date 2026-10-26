import * as esbuild from "esbuild"

const production = process.argv.includes("--production")
const watch = process.argv.includes("--watch")

/** @type {import("esbuild").BuildOptions} */
const extensionConfig = {
    entryPoints: ["src/extension/extension.ts"],
    bundle: true,
    outfile: "dist/extension.js",
    format: "cjs",
    platform: "node",
    target: "node20",
    external: ["vscode"],
    sourcemap: !production,
    minify: production,
    logLevel: "info"
}

/** @type {import("esbuild").BuildOptions} */
const webviewConfig = {
    entryPoints: ["src/webview/main.ts"],
    bundle: true,
    outfile: "dist/webview.js",
    format: "iife",
    platform: "browser",
    target: "es2022",
    sourcemap: !production,
    minify: production,
    logLevel: "info"
}

if (watch) {
    const contexts = await Promise.all([esbuild.context(extensionConfig), esbuild.context(webviewConfig)])
    await Promise.all(contexts.map((c) => c.watch()))
    console.log("watching...")
} else {
    await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)])
}
