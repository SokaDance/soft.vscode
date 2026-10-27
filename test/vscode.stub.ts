// Minimal stand-in for the "vscode" module, enough to activate the extension in unit tests.
import { vi } from "vitest"

export const registrations = {
    commands: new Map<string, (...args: unknown[]) => unknown>(),
    customEditors: new Map<string, unknown>(),
    diagnostics: new Map<string, unknown[]>(),
    contentProviders: new Map<string, { provideTextDocumentContent: (uri: Uri) => string }>()
}

export class Uri {
    private constructor(
        readonly scheme: string,
        readonly path: string,
        readonly query: string = ""
    ) {}
    static file(p: string): Uri {
        return new Uri("file", p.replace(/\\/g, "/"))
    }
    static parse(s: string): Uri {
        const m = /^([a-z][a-z0-9+.-]*):\/*(.*)$/i.exec(s)
        if (!m) throw new Error("not a uri: " + s)
        return new Uri(m[1], "/" + m[2].replace(/^\/+/, ""))
    }
    static from(parts: { scheme: string; path: string; query?: string }): Uri {
        return new Uri(parts.scheme, parts.path, parts.query ?? "")
    }
    static joinPath(base: Uri, ...segments: string[]): Uri {
        return new Uri(base.scheme, [base.path, ...segments].join("/"))
    }
    get fsPath(): string {
        return this.path
    }
    toString(): string {
        return `${this.scheme}://${this.path}${this.query ? "?" + this.query : ""}`
    }
}

export class Range {
    constructor(
        readonly startLine: number,
        readonly startCharacter: number,
        readonly endLine: number,
        readonly endCharacter: number
    ) {}
}

export class Diagnostic {
    source?: string
    constructor(
        readonly range: Range,
        readonly message: string,
        readonly severity: number
    ) {}
}

export enum DiagnosticSeverity {
    Error = 0,
    Warning = 1
}

export enum EndOfLine {
    LF = 1,
    CRLF = 2
}

export class WorkspaceEdit {
    edits: { uri: Uri; range: Range; text: string }[] = []
    replace(uri: Uri, range: Range, text: string): void {
        this.edits.push({ uri, range, text })
    }
}

export class Disposable {
    constructor(private readonly fn: () => void = () => {}) {}
    dispose(): void {
        this.fn()
    }
}

const noopEvent = () => new Disposable()

export const languages = {
    createDiagnosticCollection: (name: string) => ({
        name,
        set: (uri: Uri, items: unknown[]) => registrations.diagnostics.set(uri.toString(), items),
        delete: (uri: Uri) => registrations.diagnostics.delete(uri.toString()),
        dispose: () => {}
    })
}

export const window = {
    registerCustomEditorProvider: (viewType: string, provider: unknown) => {
        registrations.customEditors.set(viewType, provider)
        return new Disposable()
    },
    showSaveDialog: vi.fn(),
    showOpenDialog: vi.fn(),
    showWarningMessage: vi.fn(),
    tabGroups: { activeTabGroup: { activeTab: undefined } },
    activeTextEditor: undefined
}

export const commands = {
    registerCommand: (id: string, fn: (...args: unknown[]) => unknown) => {
        registrations.commands.set(id, fn)
        return new Disposable()
    },
    executeCommand: vi.fn(async () => undefined)
}

export const workspace = {
    registerTextDocumentContentProvider: (scheme: string, provider: { provideTextDocumentContent: (uri: Uri) => string }) => {
        registrations.contentProviders.set(scheme, provider)
        return new Disposable()
    },
    onDidChangeTextDocument: noopEvent,
    onDidChangeConfiguration: noopEvent,
    getConfiguration: () => ({ get: <T>(_key: string, fallback: T) => fallback }),
    applyEdit: vi.fn(async () => true),
    workspaceFolders: undefined,
    fs: { writeFile: vi.fn(async () => undefined) }
}
