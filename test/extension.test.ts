import { describe, expect, it } from "vitest"
import { registrations, Uri, EndOfLine, workspace } from "./vscode.stub"
import { activate } from "../src/extension/extension"
import { VIEW_TYPE } from "../src/extension/ecoreEditorProvider"

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<ecore:EPackage xmi:version="2.0" xmlns:xmi="http://www.omg.org/XMI" xmlns:ecore="http://www.eclipse.org/emf/2002/Ecore" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" name="p" nsURI="http://p" nsPrefix="p">
  <eClassifiers xsi:type="ecore:EClass" name="A"/>
</ecore:EPackage>
`

interface Provider {
    resolveCustomTextEditor(document: unknown, panel: unknown): Promise<void>
}

function fakeDocument(text: string) {
    return {
        uri: Uri.file("C:/tmp/p.ecore"),
        eol: EndOfLine.LF,
        lineCount: text.split("\n").length,
        getText: () => text
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
})
