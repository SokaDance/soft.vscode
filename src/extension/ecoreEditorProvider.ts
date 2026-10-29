// *****************************************************************************
// Copyright(c) 2026 MASA Group
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// *****************************************************************************

import { URI } from "@masagroup/ecore"
import * as path from "node:path"
import * as vscode from "vscode"
import type { HostMessage, ModelDiagnostic, WebviewMessage } from "../shared/protocol"
import { EcoreModel, registeredPackage, serializePackage } from "./model/ecoreModel"

export const VIEW_TYPE = "ecorium.ecoreEditor"
/** Scheme of the read-only documents showing a registered package (query: its nsURI). */
export const PACKAGE_SCHEME = "ecorium-package"

/** One open document: its Soft TS model plus the webviews showing it. */
class EditorSession {
    readonly model: EcoreModel
    readonly panels = new Set<vscode.WebviewPanel>()
    /** Text we last wrote ourselves, to distinguish our own edits from external ones. */
    private lastWritten: string | undefined
    private reloadTimer: NodeJS.Timeout | undefined
    /** Fragment to select once the first webview is ready (Ctrl+Click from another document). */
    private pendingFragment: string | undefined
    /** Object selected in the webviews, so "Open as Text" can show it. */
    private selectedId: string | null = null
    private ready = false

    constructor(
        readonly document: vscode.TextDocument,
        private readonly diagnostics: vscode.DiagnosticCollection,
        private readonly openExternal: (uri: string) => Promise<void>
    ) {
        const readOnlyReason = document.uri.scheme === PACKAGE_SCHEME ? "This package is built into Ecorium and cannot be edited." : undefined
        this.model = new EcoreModel(documentUri(document), { autoName: autoNameSetting(), readOnlyReason })
        this.parse(document.getText())
    }

    /** Range of the selected object's start tag in the text, if any. */
    selectionRange(): vscode.Range | undefined {
        if (!this.selectedId) return undefined
        const span = this.model.locate(this.selectedId, this.document.getText())
        if (!span) return undefined
        const start = this.document.positionAt(span.offset)
        const end = this.document.positionAt(span.offset + span.length)
        return new vscode.Range(start.line, start.character, end.line, end.character)
    }

    /** Selects the object at `fragment` in every webview, now or as soon as one is ready. */
    selectFragment(fragment: string): void {
        if (!this.ready) {
            this.pendingFragment = fragment
            return
        }
        const id = this.model.idForFragment(fragment)
        if (id) this.broadcastModel(id)
    }

    /** Called for every text change of the document; ignores the ones we produced. */
    onTextChanged(): void {
        const text = this.document.getText()
        if (this.lastWritten !== undefined && normalizeEol(text) === normalizeEol(this.lastWritten)) return
        if (this.reloadTimer) clearTimeout(this.reloadTimer)
        this.reloadTimer = setTimeout(() => {
            this.reloadTimer = undefined
            this.parse(this.document.getText())
            this.broadcastModel()
        }, 250)
    }

    reload(): void {
        this.model.reset(this.document.getText())
        this.publishDiagnostics()
        this.broadcastModel()
    }

    private parse(text: string): void {
        this.model.load(text)
        this.lastWritten = undefined
        this.publishDiagnostics()
    }

    private publishDiagnostics(): void {
        this.diagnostics.set(this.document.uri, this.model.getDiagnostics().map(toVsDiagnostic))
    }

    async handle(panel: vscode.WebviewPanel, message: WebviewMessage): Promise<void> {
        switch (message.type) {
            case "ready": {
                this.ready = true
                const selectId = this.pendingFragment ? this.model.idForFragment(this.pendingFragment) : undefined
                this.pendingFragment = undefined
                if (selectId) this.selectedId = selectId
                this.post(panel, { type: "model", snapshot: this.model.snapshot(), selectId })
                if (selectId) this.post(panel, { type: "properties", object: this.model.properties(selectId) })
                return
            }
            case "openExternal":
                await this.openExternal(message.uri)
                return
            case "addPackage": {
                const uris = message.uri ? [message.uri] : await pickPackages(this.document)
                for (const uri of uris) {
                    try {
                        this.model.addExternalPackage(uri)
                    } catch (e) {
                        this.post(panel, { type: "error", message: e instanceof Error ? e.message : String(e) })
                    }
                }
                if (uris.length) this.broadcastModel()
                return
            }
            case "removePackage":
                try {
                    this.model.removeExternalPackage(message.uri)
                    this.broadcastModel()
                } catch (e) {
                    this.post(panel, { type: "error", message: e instanceof Error ? e.message : String(e) })
                }
                return
            case "select":
                this.selectedId = message.id
                this.post(panel, { type: "properties", object: message.id ? this.model.properties(message.id) : null })
                return
            case "openText":
                await openAsText(this.document.uri, this.selectionRange())
                return
            case "edit": {
                if (this.model.isReadOnly()) {
                    this.post(panel, { type: "error", message: this.model.readOnlyReason ?? "The model is read-only because the file has errors. Fix it in the text editor first." })
                    return
                }
                console.log("[ecorium] edit", JSON.stringify(message.command))
                let selectId: string | null | undefined
                try {
                    selectId = this.model.apply(message.command).selectId
                } catch (e) {
                    this.post(panel, { type: "error", message: e instanceof Error ? e.message : String(e) })
                    return
                }
                const ok = await this.writeBack()
                if (!ok) {
                    this.post(panel, { type: "error", message: "VS Code refused the edit." })
                    return
                }
                this.broadcastModel(selectId)
                return
            }
        }
    }

    private async writeBack(): Promise<boolean> {
        let text = this.model.serialize()
        if (this.document.eol === vscode.EndOfLine.CRLF) text = text.replace(/\r?\n/g, "\r\n")
        this.lastWritten = text
        const edit = new vscode.WorkspaceEdit()
        const fullRange = new vscode.Range(0, 0, this.document.lineCount, 0)
        edit.replace(this.document.uri, fullRange, text)
        return vscode.workspace.applyEdit(edit)
    }

    private broadcastModel(selectId?: string | null): void {
        if (selectId !== undefined) this.selectedId = selectId
        const snapshot = this.model.snapshot()
        for (const panel of this.panels) {
            this.post(panel, { type: "model", snapshot, selectId })
            if (selectId) this.post(panel, { type: "properties", object: this.model.properties(selectId) })
        }
    }

    private post(panel: vscode.WebviewPanel, message: HostMessage): void {
        void panel.webview.postMessage(message)
    }

    dispose(): void {
        if (this.reloadTimer) clearTimeout(this.reloadTimer)
        this.diagnostics.delete(this.document.uri)
    }
}

export class EcoreEditorProvider implements vscode.CustomTextEditorProvider {
    private readonly sessions = new Map<string, EditorSession>()
    private readonly diagnostics: vscode.DiagnosticCollection

    constructor(private readonly context: vscode.ExtensionContext) {
        this.diagnostics = vscode.languages.createDiagnosticCollection("ecorium")
        context.subscriptions.push(this.diagnostics)
        context.subscriptions.push(
            vscode.workspace.registerTextDocumentContentProvider(PACKAGE_SCHEME, {
                provideTextDocumentContent: (uri) => {
                    const pkg = registeredPackage(uri.query)
                    return pkg ? serializePackage(pkg) : ""
                }
            }),
            vscode.workspace.onDidChangeTextDocument((e) => this.sessions.get(e.document.uri.toString())?.onTextChanged()),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (!e.affectsConfiguration("ecorium.autoNameNewElements")) return
                for (const s of this.sessions.values()) s.model.autoName = autoNameSetting()
            })
        )
    }

    static register(context: vscode.ExtensionContext): EcoreEditorProvider {
        const provider = new EcoreEditorProvider(context)
        context.subscriptions.push(
            vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: true
            })
        )
        return provider
    }

    /**
     * Opens the declaration at `uri` ("<resource>#<fragment>") in Ecorium and selects it: another .ecore
     * file, or a package registered in Soft TS (Ecore itself) shown as a read-only document.
     */
    async openExternal(uri: string): Promise<void> {
        const hash = uri.indexOf("#")
        const resource = hash >= 0 ? uri.slice(0, hash) : uri
        const fragment = hash >= 0 ? uri.slice(hash + 1) : ""
        let target: vscode.Uri
        if (resource.startsWith("file:")) {
            target = vscode.Uri.parse(resource)
        } else {
            const pkg = registeredPackage(resource)
            if (!pkg) {
                void vscode.window.showWarningMessage(`Ecorium cannot open '${resource}'.`)
                return
            }
            target = vscode.Uri.from({ scheme: PACKAGE_SCHEME, path: `/${pkg.getName()}.ecore`, query: resource })
        }
        await vscode.commands.executeCommand("vscode.openWith", target, VIEW_TYPE)
        if (fragment) this.sessions.get(target.toString())?.selectFragment(fragment)
    }

    /** Opens `uri` in the text editor, on the element selected in Ecorium when there is one. */
    async openAsText(uri: vscode.Uri): Promise<void> {
        await openAsText(uri, this.sessions.get(uri.toString())?.selectionRange())
    }

    /** Reloads the model shown for `uri` (or the active editor's document). */
    reload(uri?: vscode.Uri): void {
        const key = uri?.toString()
        for (const [k, session] of this.sessions) if (!key || k === key) session.reload()
    }

    async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
        const key = document.uri.toString()
        let session = this.sessions.get(key)
        if (!session) {
            session = new EditorSession(document, this.diagnostics, (uri) => this.openExternal(uri))
            this.sessions.set(key, session)
        }
        session.panels.add(panel)

        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist"), vscode.Uri.joinPath(this.context.extensionUri, "media")]
        }
        panel.webview.html = this.html(panel.webview, document)

        const subscriptions: vscode.Disposable[] = [
            panel.webview.onDidReceiveMessage((m: WebviewMessage) => void session!.handle(panel, m)),
            panel.onDidDispose(() => {
                subscriptions.forEach((s) => s.dispose())
                session!.panels.delete(panel)
                if (session!.panels.size === 0) {
                    session!.dispose()
                    this.sessions.delete(key)
                }
            })
        ]
    }

    private html(webview: vscode.Webview, document: vscode.TextDocument): string {
        const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"))
        const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.css"))
        const nonce = makeNonce()
        const title = escapeHtml(document.uri.path.split("/").pop() ?? "Ecore")
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>${title}</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`
    }
}

async function openAsText(uri: vscode.Uri, selection: vscode.Range | undefined): Promise<void> {
    if (selection) await vscode.commands.executeCommand("vscode.openWith", uri, "default", { selection })
    else await vscode.commands.executeCommand("vscode.openWith", uri, "default")
}

/** Asks for .ecore files to add as external packages; returns their resource URIs. */
async function pickPackages(document: vscode.TextDocument): Promise<string[]> {
    const picked = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: "Add package",
        filters: { "Ecore models": ["ecore"] },
        defaultUri: document.uri.scheme === "file" ? vscode.Uri.file(path.dirname(document.uri.fsPath)) : undefined
    })
    return (picked ?? []).map((u) => fileUri(u).toString())
}

/** The Soft TS URI of a file: "file:///D:/models/x.ecore" whatever the platform. */
function fileUri(uri: vscode.Uri): URI {
    return new URI({ scheme: "file", path: "/" + uri.fsPath.replace(/\\/g, "/").replace(/^\/+/, "") })
}

function documentUri(document: vscode.TextDocument): URI {
    if (document.uri.scheme === "file") return fileUri(document.uri)
    // untitled or virtual documents: keep the ".ecore" extension so the XMI codec is selected
    const name = document.uri.path.split("/").pop() || "model.ecore"
    return new URI({ scheme: document.uri.scheme || "untitled", path: "/" + (name.endsWith(".ecore") ? name : name + ".ecore") })
}

function autoNameSetting(): boolean {
    return vscode.workspace.getConfiguration("ecorium").get<boolean>("autoNameNewElements", true)
}

function normalizeEol(text: string): string {
    return text.replace(/\r\n/g, "\n")
}

function toVsDiagnostic(d: ModelDiagnostic): vscode.Diagnostic {
    const line = Math.max(0, (d.line || 1) - 1)
    const column = Math.max(0, (d.column || 1) - 1)
    const range = new vscode.Range(line, column, line, column + 1)
    const severity = d.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error
    const diagnostic = new vscode.Diagnostic(range, d.message, severity)
    diagnostic.source = "ecorium"
    return diagnostic
}

function makeNonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    let out = ""
    for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)]
    return out
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string)
}
