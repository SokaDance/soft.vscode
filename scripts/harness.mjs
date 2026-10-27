// Development harness: serves the real webview bundle (dist/webview.js + media/webview.css) in a plain
// browser, with `acquireVsCodeApi` replaced by a shim that talks over HTTP to the real model layer
// running in Node. Useful to iterate on the UI without launching an Extension Development Host.
//
//   node scripts/harness.mjs [path/to/model.ecore] [--port 3939]
//
// Edits are applied to the in-memory model and written to out/harness-output.ecore (never to the input).
import * as esbuild from "esbuild"
import { createRequire } from "node:module"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const portIndex = args.indexOf("--port")
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : Number(process.env.PORT ?? 3939)
const file = path.resolve(args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--port") ?? path.join(root, "samples", "library.ecore"))
const outDir = path.join(root, "out")
fs.mkdirSync(outDir, { recursive: true })

// bundle the model layer (TypeScript) together with its own copy of @masagroup/ecore
const modelBundle = path.join(outDir, `harness-model-${process.pid}.cjs`)
process.on("exit", () => fs.rmSync(modelBundle, { force: true }))
await esbuild.build({
    stdin: {
        contents: `export { EcoreModel } from "./src/extension/model/ecoreModel"; export { URI } from "@masagroup/ecore"`,
        resolveDir: root,
        loader: "ts"
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: modelBundle,
    logLevel: "warning"
})
const { EcoreModel, URI } = createRequire(import.meta.url)(modelBundle)

const model = new EcoreModel(new URI("file:///" + file.replace(/\\/g, "/")))
model.load(fs.readFileSync(file, "utf8"))
console.log(`loaded ${file}: ${model.getDiagnostics().length} diagnostic(s), read-only=${model.isReadOnly()}`)

function handle(message) {
    switch (message.type) {
        case "ready":
            return [{ type: "model", snapshot: model.snapshot() }]
        case "select":
            return [{ type: "properties", object: message.id ? model.properties(message.id) : null }]
        case "openExternal":
            console.log("openExternal (not available in the harness):", message.uri)
            return
        case "addPackage": {
            if (!message.uri) return [{ type: "error", message: "(harness) no file picker here: post { type: \"addPackage\", uri } instead" }]
            try {
                model.addExternalPackage(message.uri)
            } catch (e) {
                return [{ type: "error", message: e.message }]
            }
            return [{ type: "model", snapshot: model.snapshot() }]
        }
        case "removePackage":
            try {
                model.removeExternalPackage(message.uri)
            } catch (e) {
                return [{ type: "error", message: e.message }]
            }
            return [{ type: "model", snapshot: model.snapshot() }]
        case "openText":
            return [{ type: "error", message: "(harness) Open as Text is not available here" }]
        case "edit": {
            if (model.isReadOnly()) return [{ type: "error", message: "The model is read-only because the file has errors." }]
            try {
                const { selectId } = model.apply(message.command)
                const text = model.serialize()
                fs.writeFileSync(path.join(outDir, "harness-output.ecore"), text)
                console.log(`edit ${message.command.type} -> ${text.length} chars`)
                const out = [{ type: "model", snapshot: model.snapshot(), selectId }]
                if (selectId) out.push({ type: "properties", object: model.properties(selectId) })
                return out
            } catch (e) {
                return [{ type: "error", message: e instanceof Error ? e.message : String(e) }]
            }
        }
    }
    return []
}

const THEME = `
:root {
  --vscode-font-family: "Segoe WPC", "Segoe UI", system-ui, sans-serif; --vscode-font-size: 13px;
  --vscode-editor-font-family: Consolas, monospace;
  --vscode-foreground: #cccccc; --vscode-editor-background: #1f1f1f; --vscode-descriptionForeground: #9d9d9d;
  --vscode-focusBorder: #0078d4; --vscode-panel-border: #2b2b2b; --vscode-widget-border: #313131; --vscode-widget-shadow: rgba(0,0,0,.36);
  --vscode-list-hoverBackground: #2a2d2e; --vscode-list-activeSelectionBackground: #04395e; --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-list-inactiveSelectionBackground: #37373d;
  --vscode-input-background: #313131; --vscode-input-foreground: #cccccc; --vscode-input-border: #3c3c3c;
  --vscode-dropdown-background: #313131; --vscode-dropdown-foreground: #cccccc; --vscode-dropdown-border: #3c3c3c;
  --vscode-button-background: #0078d4; --vscode-button-foreground: #ffffff; --vscode-button-hoverBackground: #026ec1;
  --vscode-button-secondaryBackground: #313131; --vscode-button-secondaryForeground: #cccccc; --vscode-button-secondaryHoverBackground: #3c3c3c;
  --vscode-toolbar-hoverBackground: rgba(90,93,94,.31);
  --vscode-badge-background: #616161; --vscode-badge-foreground: #f8f8f8;
  --vscode-menu-background: #1f1f1f; --vscode-menu-foreground: #cccccc; --vscode-menu-selectionBackground: #0078d4; --vscode-menu-selectionForeground: #ffffff; --vscode-menu-border: #454545; --vscode-menu-separatorBackground: #454545;
  --vscode-editorWidget-background: #202020; --vscode-notifications-background: #1f1f1f; --vscode-notifications-foreground: #cccccc;
  --vscode-inputValidation-errorBackground: #5a1d1d; --vscode-inputValidation-errorBorder: #be1100;
  --vscode-inputValidation-warningBackground: #352a05; --vscode-inputValidation-warningBorder: #b89500;
}`

const PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Ecorium harness</title>
<link rel="stylesheet" href="/webview.css"><style>${THEME}</style>
<script>
window.acquireVsCodeApi = () => ({
  postMessage: (m) => fetch("/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(m) })
    .then((r) => r.json()).then((list) => list.forEach((x) => window.postMessage(x, "*"))),
  getState: () => { try { return JSON.parse(sessionStorage.getItem("state")) ?? undefined } catch { return undefined } },
  setState: (s) => sessionStorage.setItem("state", JSON.stringify(s))
})
</script></head>
<body><div id="app"></div><script src="/webview.js"></script></body></html>`

http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/message") {
        let body = ""
        req.on("data", (c) => (body += c))
        req.on("end", () => {
            let out
            try {
                out = handle(JSON.parse(body))
            } catch (e) {
                out = [{ type: "error", message: String(e) }]
            }
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify(out))
        })
        return
    }
    const routes = {
        "/": [PAGE, "text/html"],
        "/webview.js": [path.join(root, "dist", "webview.js"), "text/javascript"],
        "/webview.css": [path.join(root, "media", "webview.css"), "text/css"]
    }
    const route = routes[req.url ?? "/"]
    if (!route) {
        res.writeHead(404)
        res.end("not found")
        return
    }
    const [source, type] = route
    res.writeHead(200, { "content-type": type })
    res.end(source.startsWith("<") ? source : fs.readFileSync(source))
}).listen(port, () => console.log(`Ecorium harness: http://localhost:${port}`))
