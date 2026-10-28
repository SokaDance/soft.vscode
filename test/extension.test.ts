import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { registrations, Uri, EndOfLine, workspace, commands, window } from "./vscode.stub"
import { activate } from "../src/extension/extension"
import { PACKAGE_SCHEME, VIEW_TYPE } from "../src/extension/ecoreEditorProvider"

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<ecore:EPackage xmi:version="2.0" xmlns:xmi="http://www.omg.org/XMI" xmlns:ecore="http://www.eclipse.org/emf/2002/Ecore" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" name="p" nsURI="http://p" nsPrefix="p">
  <eClassifiers xsi:type="ecore:EClass" name="A"/>
</ecore:EPackage>
`

interface Provider {
    resolveCustomTextEditor(document: unknown, panel: unknown): Promise<void>
    openExternal(uri: string): Promise<void>
}

function fakeDocument(text: string) {
    return {
        uri: Uri.file("C:/tmp/p.ecore"),
        eol: EndOfLine.LF,
        lineCount: text.split("\n").length,
        getText: () => text,
        positionAt: (offset: number) => {
            const before = text.slice(0, offset).split("\n")
            return { line: before.length - 1, character: before[before.length - 1].length }
        }
    }
}

function fakePanel() {
    const posted: unknown[] = []
    let onMessage: ((m: unknown) => void) | undefined
    const panel = {
        webview: {
            options: {},
            html: "",
            cspSource: "vscode-webview:",
            asWebviewUri: (u: Uri) => u,
            postMessage: async (m: unknown) => {
                posted.push(m)
                return true
            },
            onDidReceiveMessage: (fn: (m: unknown) => void) => {
                onMessage = fn
                return { dispose: () => {} }
            }
        },
        onDidDispose: () => ({ dispose: () => {} })
    }
    return { panel, posted, send: (m: unknown) => onMessage?.(m) }
}

describe("extension activation", () => {
    it("registers the custom editor and the commands", () => {
        const context = { subscriptions: [] as unknown[], extensionUri: Uri.file("C:/ext") }
        activate(context as never)
        expect(registrations.customEditors.has(VIEW_TYPE)).toBe(true)
        for (const id of ["ecorium.openWithEcorium", "ecorium.openAsText", "ecorium.newModel", "ecorium.reload"]) {
            expect(registrations.commands.has(id)).toBe(true)
        }
        expect(context.subscriptions.length).toBeGreaterThan(0)
    })

    it("serves a CSP protected page and answers the webview protocol", async () => {
        const provider = registrations.customEditors.get(VIEW_TYPE) as Provider
        const document = fakeDocument(SAMPLE)
        const { panel, posted, send } = fakePanel()
        await provider.resolveCustomTextEditor(document, panel)
        expect(panel.webview.html).toContain("Content-Security-Policy")
        expect(panel.webview.html).toMatch(/nonce-[A-Za-z0-9]{32}/)
        expect(registrations.diagnostics.get(document.uri.toString())).toEqual([])

        send({ type: "ready" })
        await new Promise((r) => setTimeout(r, 0))
        const model = posted.find((m) => (m as { type: string }).type === "model") as {
            snapshot: { roots: { label: string; children: { id: string }[] }[] }
        }
        expect(model.snapshot.roots[0].label).toBe("p")

        const classId = model.snapshot.roots[0].children[0].id
        send({ type: "edit", command: { type: "set", id: classId, feature: "name", value: "B" } })
        await new Promise((r) => setTimeout(r, 10))
        expect(workspace.applyEdit).toHaveBeenCalledTimes(1)
        const edit = (workspace.applyEdit as unknown as { mock: { calls: [{ edits: { text: string }[] }][] } }).mock.calls[0][0]
        expect(edit.edits[0].text).toContain('name="B"')
        const last = posted[posted.length - 1] as { type: string; object: { label: string } }
        expect(last.type).toBe("properties")
        expect(last.object.label).toBe("B")
    })

    it("opens the text on the selected element", async () => {
        const provider = registrations.customEditors.get(VIEW_TYPE) as Provider
        const { panel, send, posted } = fakePanel()
        const document = fakeDocument(SAMPLE)
        await provider.resolveCustomTextEditor(document, panel)
        const calls = (commands.executeCommand as unknown as { mock: { calls: unknown[][] } }).mock.calls
        const tick = () => new Promise((r) => setTimeout(r, 0))
        send({ type: "ready" })
        await tick()
        const snapshot = (posted.find((m) => (m as { type: string }).type === "model") as { snapshot: { roots: { id: string; children: { id: string }[] }[] } }).snapshot

        // nothing selected: the text opens as usual
        send({ type: "select", id: null })
        calls.length = 0
        send({ type: "openText" })
        await tick()
        expect(calls[0]).toEqual(["vscode.openWith", document.uri, "default"])

        // a selected class: the text opens on its start tag
        const cls = snapshot.roots[0].children[0]
        send({ type: "select", id: cls.id })
        send({ type: "openText" })
        await tick()
        const range = (calls[1][3] as { selection: { startLine: number; startCharacter: number; endCharacter: number } }).selection
        const line = SAMPLE.split("\n")[range.startLine]
        expect(line.slice(range.startCharacter, range.endCharacter)).toBe("eClassifiers")
        expect(line).toContain('name="A"')

        // the editor title command goes through the same path
        calls.length = 0
        await (provider as unknown as { openAsText(u: Uri): Promise<void> }).openAsText(document.uri)
        expect((calls[0][3] as { selection: unknown }).selection).toEqual(range)
    })

    it("adds and removes external packages", async () => {
        const provider = registrations.customEditors.get(VIEW_TYPE) as Provider
        const { panel, send, posted } = fakePanel()
        await provider.resolveCustomTextEditor(fakeDocument(SAMPLE), panel)
        const tick = () => new Promise((r) => setTimeout(r, 0))
        type Model = { type: string; snapshot: { externalPackages: { label: string; referenced: boolean }[] } }
        const lastModel = () => posted.filter((m) => (m as Model).type === "model").pop() as Model

        const extra = pathToFileURL(fileURLToPath(new URL("./fixtures/extra.ecore", import.meta.url))).href
        send({ type: "addPackage", uri: extra })
        await tick()
        expect(lastModel().snapshot.externalPackages.map((p) => p.label)).toContain("extra")

        send({ type: "removePackage", uri: extra })
        await tick()
        expect(lastModel().snapshot.externalPackages.map((p) => p.label)).not.toContain("extra")

        // without a uri the host asks for the files (the stub picks none)
        send({ type: "addPackage" })
        await tick()
        expect(window.showOpenDialog).toHaveBeenCalled()

        // a file that cannot be read is reported to the webview
        send({ type: "addPackage", uri: "file:///C:/nowhere/missing.ecore" })
        await tick()
        expect(posted.some((m) => (m as { type: string; message?: string }).type === "error" && /Cannot load/.test((m as { message: string }).message))).toBe(true)
    })

    it("opens external declarations in Ecorium", async () => {
        const provider = registrations.customEditors.get(VIEW_TYPE) as Provider
        const { panel, send } = fakePanel()
        await provider.resolveCustomTextEditor(fakeDocument(SAMPLE), panel)
        const calls = (commands.executeCommand as unknown as { mock: { calls: unknown[][] } }).mock.calls
        calls.length = 0

        // another .ecore file
        send({ type: "openExternal", uri: "file:///C:/other.ecore#//Foo" })
        await new Promise((r) => setTimeout(r, 0))
        expect(calls[0][0]).toBe("vscode.openWith")
        expect((calls[0][1] as Uri).toString()).toBe("file:///C:/other.ecore")
        expect(calls[0][2]).toBe(VIEW_TYPE)

        // the Ecore package itself, served as a read-only document
        send({ type: "openExternal", uri: "http://www.eclipse.org/emf/2002/Ecore#//EString" })
        await new Promise((r) => setTimeout(r, 0))
        const target = calls[1][1] as Uri
        expect(target.scheme).toBe(PACKAGE_SCHEME)
        expect(target.path).toBe("/ecore.ecore")
        const content = registrations.contentProviders.get(PACKAGE_SCHEME)!.provideTextDocumentContent(target)
        expect(content).toContain('name="EString"')

        // the Ecore document selects the requested object once its webview is ready
        const ecoreDocument = { ...fakeDocument(content), uri: target }
        const ecoreView = fakePanel()
        await provider.resolveCustomTextEditor(ecoreDocument as never, ecoreView.panel)
        await provider.openExternal("http://www.eclipse.org/emf/2002/Ecore#//EString")
        ecoreView.send({ type: "ready" })
        await new Promise((r) => setTimeout(r, 0))
        const model = ecoreView.posted.find((m) => (m as { type: string }).type === "model") as {
            snapshot: { readOnlyReason?: string; roots: { children: { id: string; label: string }[] }[] }
            selectId?: string
        }
        expect(model.snapshot.readOnlyReason).toBeTruthy()
        expect(model.selectId).toBe(model.snapshot.roots[0].children.find((c) => /^EString\b/.test(c.label))!.id)

        // unknown packages are reported, not opened
        send({ type: "openExternal", uri: "http://nowhere#//X" })
        await new Promise((r) => setTimeout(r, 0))
        expect(window.showWarningMessage).toHaveBeenCalled()
        expect(calls.length).toBe(3) // the two openExternal messages and the direct call above
    })
})
