// *****************************************************************************
// Copyright(c) 2026 MASA Group
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// *****************************************************************************

import type {
    ChildOption,
    EditCommand,
    HostMessage,
    ModelSnapshot,
    ObjectProperties,
    PropertyDescriptor,
    Ref,
    TreeNode,
    WebviewMessage
} from "../shared/protocol"

declare function acquireVsCodeApi(): {
    postMessage(message: WebviewMessage): void
    getState(): PersistedState | undefined
    setState(state: PersistedState): void
}

interface PersistedState {
    expanded: string[]
    selected: string | null
    treeWidth?: number
}

const vscode = acquireVsCodeApi()

const ICON_LETTERS: Record<string, string> = {
    package: "P",
    class: "C",
    attribute: "A",
    reference: "R",
    operation: "O",
    parameter: "p",
    enum: "E",
    literal: "L",
    datatype: "D",
    annotation: "@",
    entry: "k",
    typeparam: "T",
    generic: "G",
    object: "•"
}

// -------------------------------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------------------------------

let snapshot: ModelSnapshot | null = null
let readOnly = false
let selectedId: string | null = null
let expanded = new Set<string>()
let filter = ""
let properties: ObjectProperties | null = null
let focusNameOnNextProps = false
let firstModel = true

const nodesById = new Map<string, TreeNode>()
const parentOf = new Map<string, TreeNode | null>()

// -------------------------------------------------------------------------------------------------
// DOM helpers
// -------------------------------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Record<string, string | boolean | undefined> = {},
    ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === false) continue
        if (k === "class") node.className = String(v)
        else if (k === "text") node.textContent = String(v)
        else if (v === true) node.setAttribute(k, "")
        else node.setAttribute(k, v)
    }
    for (const c of children) if (c !== null && c !== undefined) node.append(c)
    return node
}

function icon(kind: string): HTMLElement {
    return el("span", { class: `icon ${kind}`, text: ICON_LETTERS[kind] ?? ICON_LETTERS.object })
}

function post(message: WebviewMessage): void {
    vscode.postMessage(message)
}

function edit(command: EditCommand): void {
    if (readOnly) {
        toast("The model is read-only while the file has errors.")
        return
    }
    post({ type: "edit", command })
}

function persist(): void {
    vscode.setState({ expanded: [...expanded], selected: selectedId, treeWidth: treeWidth })
}

// -------------------------------------------------------------------------------------------------
// Layout
// -------------------------------------------------------------------------------------------------

const app = document.getElementById("app")!
const banner = el("div", { id: "banner" })
const filterInput = el("input", { type: "text", placeholder: "Filter elements…", "aria-label": "Filter" })
const toolbar = el(
    "div",
    { id: "toolbar" },
    filterInput,
    el("button", { class: "tool", title: "Expand all", text: "Expand all" }),
    el("button", { class: "tool", title: "Collapse all", text: "Collapse all" }),
    el("div", { class: "spacer" }),
    el("button", { class: "tool", title: "Open the XMI source in the text editor", text: "Open as Text" })
)
const tree = el("div", { id: "tree", tabindex: "0", role: "tree" })
const splitter = el("div", { id: "splitter" })
const props = el("div", { id: "props" })
const main = el("div", { id: "main" }, tree, splitter, props)
const toastEl = el("div", { id: "toast" })
app.append(banner, toolbar, main, toastEl)

const [expandAllBtn, collapseAllBtn, openTextBtn] = toolbar.querySelectorAll("button")
expandAllBtn.addEventListener("click", () => {
    for (const id of nodesById.keys()) expanded.add(id)
    renderTree()
})
collapseAllBtn.addEventListener("click", () => {
    expanded.clear()
    renderTree()
})
openTextBtn.addEventListener("click", () => post({ type: "openText" }))

let filterTimer: number | undefined
filterInput.addEventListener("input", () => {
    window.clearTimeout(filterTimer)
    filterTimer = window.setTimeout(() => {
        filter = filterInput.value.trim().toLowerCase()
        renderTree()
    }, 120)
})
filterInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        filterInput.value = ""
        filter = ""
        renderTree()
    }
})

let treeWidth: number | undefined
splitter.addEventListener("mousedown", (e) => {
    e.preventDefault()
    splitter.classList.add("dragging")
    const onMove = (ev: MouseEvent) => {
        const rect = main.getBoundingClientRect()
        treeWidth = Math.max(160, Math.min(rect.width - 200, ev.clientX - rect.left))
        tree.style.flexBasis = treeWidth + "px"
    }
    const onUp = () => {
        splitter.classList.remove("dragging")
        window.removeEventListener("mousemove", onMove)
        window.removeEventListener("mouseup", onUp)
        persist()
    }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
})

let toastTimer: number | undefined
function toast(message: string): void {
    toastEl.textContent = message
    toastEl.classList.add("visible")
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => toastEl.classList.remove("visible"), 4000)
}

// -------------------------------------------------------------------------------------------------
// Banner
// -------------------------------------------------------------------------------------------------

function renderBanner(): void {
    banner.replaceChildren()
    banner.className = ""
    if (!snapshot) return
    const errors = snapshot.diagnostics.filter((d) => d.severity === "error")
    let text: string | undefined
    let warning = false
    if (snapshot.fatal) {
        text = `Cannot parse the file (line ${snapshot.fatal.line}, column ${snapshot.fatal.column}): ${snapshot.fatal.message}\nEditing is disabled until the XML is fixed.`
    } else if (errors.length) {
        const first = errors[0]
        text = `${errors.length} problem${errors.length > 1 ? "s" : ""} found while loading (line ${first.line}: ${first.message}).\nEditing is disabled to avoid losing unsupported content; see the Problems view.`
    } else if (snapshot.diagnostics.length) {
        text = `${snapshot.diagnostics.length} warning${snapshot.diagnostics.length > 1 ? "s" : ""} while loading; see the Problems view.`
        warning = true
    }
    if (!text) return
    banner.className = "visible" + (warning ? " warning" : "")
    const open = el("button", { text: "Open as Text" })
    open.addEventListener("click", () => post({ type: "openText" }))
    banner.append(el("span", { class: "message", text }), open)
}

// -------------------------------------------------------------------------------------------------
// Tree
// -------------------------------------------------------------------------------------------------

function indexNodes(): void {
    nodesById.clear()
    parentOf.clear()
    const visit = (node: TreeNode, parent: TreeNode | null) => {
        nodesById.set(node.id, node)
        parentOf.set(node.id, parent)
        for (const c of node.children) visit(c, node)
    }
    for (const r of snapshot?.roots ?? []) visit(r, null)
}

interface Row {
    node: TreeNode
    depth: number
}

function visibleRows(): Row[] {
    const rows: Row[] = []
    if (!snapshot) return rows
    let matches: Set<string> | null = null
    if (filter) {
        matches = new Set()
        const visit = (node: TreeNode): boolean => {
            let hit = node.label.toLowerCase().includes(filter) || node.eClass.toLowerCase() === filter
            for (const c of node.children) if (visit(c)) hit = true
            if (hit) matches!.add(node.id)
            return hit
        }
        for (const r of snapshot.roots) visit(r)
    }
    const walk = (node: TreeNode, depth: number) => {
        if (matches && !matches.has(node.id)) return
        rows.push({ node, depth })
        const open = matches ? true : expanded.has(node.id)
        if (open) for (const c of node.children) walk(c, depth + 1)
    }
    for (const r of snapshot.roots) walk(r, 0)
    return rows
}

function renderTree(): void {
    const scrollTop = tree.scrollTop
    tree.replaceChildren()
    if (!snapshot) return
    if (!snapshot.roots.length) {
        renderEmptyTree()
        return
    }
    const fragment = document.createDocumentFragment()
    for (const { node, depth } of visibleRows()) {
        const hasChildren = node.children.length > 0
        const row = el(
            "div",
            {
                class:
                    "row" +
                    (node.id === selectedId ? " selected" : "") +
                    (hasChildren && (filter || expanded.has(node.id)) ? " expanded" : "") +
                    (node.abstract ? " abstract" : ""),
                role: "treeitem",
                "data-id": node.id,
                title: node.detail ? `${node.eClass} ${node.detail}` : node.eClass
            },
            el("span", { class: "twistie" + (hasChildren ? "" : " empty") }),
            icon(node.icon),
            el("span", { class: "label", text: node.label || `<${node.eClass}>` }),
            node.detail ? el("span", { class: "detail", text: node.detail }) : null
        )
        row.style.paddingLeft = 4 + depth * 16 + "px"
        fragment.append(row)
    }
    tree.append(fragment)
    tree.scrollTop = scrollTop
}

function renderEmptyTree(): void {
    const box = el("div", { class: "empty-model" }, el("p", { text: "This model is empty." }))
    if (!readOnly && snapshot) {
        const select = el("select", { "aria-label": "Root element type" })
        for (const o of snapshot.rootOptions) select.append(el("option", { value: `${o.nsURI}|${o.eClass}`, text: o.eClass }))
        const create = el("button", { class: "primary", text: "Create root element" })
        create.addEventListener("click", () => {
            const [nsURI, eClass] = select.value.split("|")
            focusNameOnNextProps = true
            edit({ type: "create", parentId: null, nsURI, eClass })
        })
        box.append(el("div", { class: "many" }, select, create))
    }
    tree.append(box)
}

function rowOf(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element ? (target.closest(".row") as HTMLElement | null) : null
}

tree.addEventListener("click", (e) => {
    const row = rowOf(e.target)
    if (!row) return
    const id = row.dataset.id!
    const twistie = (e.target as Element).closest(".twistie")
    if (twistie) {
        toggle(id)
    } else if (e.ctrlKey || e.metaKey) {
        const typeId = nodesById.get(id)?.typeId
        if (typeId) goTo(typeId)
        else select(id)
    } else {
        select(id)
    }
})
tree.addEventListener("dblclick", (e) => {
    const row = rowOf(e.target)
    if (row) toggle(row.dataset.id!)
})
tree.addEventListener("contextmenu", (e) => {
    e.preventDefault()
    const row = rowOf(e.target)
    if (row) select(row.dataset.id!)
    else if (snapshot?.roots.length) return
    openContextMenu(e.clientX, e.clientY, row ? row.dataset.id! : null)
})
tree.addEventListener("keydown", (e) => {
    const rows = visibleRows()
    const index = rows.findIndex((r) => r.node.id === selectedId)
    const moveTo = (i: number) => {
        if (!rows.length) return
        const next = rows[Math.max(0, Math.min(rows.length - 1, i))]
        select(next.node.id)
        tree.querySelector(`.row[data-id="${next.node.id}"]`)?.scrollIntoView({ block: "nearest" })
    }
    const node = selectedId ? nodesById.get(selectedId) : undefined
    switch (e.key) {
        case "ArrowDown":
            e.preventDefault()
            if (e.ctrlKey && selectedId) edit({ type: "move", id: selectedId, delta: 1 })
            else moveTo(index + 1)
            break
        case "ArrowUp":
            e.preventDefault()
            if (e.ctrlKey && selectedId) edit({ type: "move", id: selectedId, delta: -1 })
            else moveTo(index - 1)
            break
        case "ArrowRight":
            e.preventDefault()
            if (node?.children.length) {
                if (expanded.has(node.id)) moveTo(index + 1)
                else toggle(node.id)
            }
            break
        case "ArrowLeft":
            e.preventDefault()
            if (node && expanded.has(node.id) && node.children.length) toggle(node.id)
            else if (node) {
                const parent = parentOf.get(node.id)
                if (parent) moveTo(rows.findIndex((r) => r.node.id === parent.id))
            }
            break
        case "Home":
            e.preventDefault()
            moveTo(0)
            break
        case "End":
            e.preventDefault()
            moveTo(rows.length - 1)
            break
        case "Enter":
            e.preventDefault()
            focusFirstProperty()
            break
        case "F2":
            e.preventDefault()
            focusNameProperty()
            break
        case "Delete":
        case "Backspace":
            if (selectedId) {
                e.preventDefault()
                edit({ type: "delete", id: selectedId })
            }
            break
        case "ContextMenu":
        case "F10": {
            if (!e.shiftKey && e.key === "F10") break
            e.preventDefault()
            const row = selectedId ? tree.querySelector<HTMLElement>(`.row[data-id="${selectedId}"]`) : null
            const rect = row?.getBoundingClientRect() ?? tree.getBoundingClientRect()
            openContextMenu(rect.left + 40, rect.bottom, selectedId)
            break
        }
    }
})

function toggle(id: string): void {
    if (expanded.has(id)) expanded.delete(id)
    else expanded.add(id)
    renderTree()
    persist()
}

function reveal(id: string): void {
    let p = parentOf.get(id)
    while (p) {
        expanded.add(p.id)
        p = parentOf.get(p.id) ?? null
    }
}

/** Selects `id` in the tree, expanding its ancestors and scrolling it into view (external objects are ignored). */
function goTo(id: string): void {
    if (!nodesById.has(id)) return
    reveal(id)
    renderTree()
    select(id)
    const row = tree.querySelector(`.row[data-id="${CSS.escape(id)}"]`)
    row?.scrollIntoView({ block: "nearest" })
    tree.focus()
}

function select(id: string | null): void {
    if (selectedId !== id) {
        selectedId = id
        for (const row of tree.querySelectorAll(".row")) row.classList.toggle("selected", (row as HTMLElement).dataset.id === id)
        persist()
    }
    post({ type: "select", id })
}

// -------------------------------------------------------------------------------------------------
// Context menu
// -------------------------------------------------------------------------------------------------

let menu: HTMLElement | null = null

function closeMenu(): void {
    menu?.remove()
    menu = null
}
window.addEventListener("mousedown", (e) => {
    if (menu && !menu.contains(e.target as Node)) closeMenu()
})
window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu()
})
window.addEventListener("blur", closeMenu)
tree.addEventListener("scroll", closeMenu)

interface MenuEntry {
    label: string
    icon?: string
    disabled?: boolean
    action?: () => void
    submenu?: { group: string; entries: MenuEntry[] }[]
}

function groupOptions(options: ChildOption[], onPick: (o: ChildOption) => void): { group: string; entries: MenuEntry[] }[] {
    const groups = new Map<string, MenuEntry[]>()
    for (const o of options) {
        const list = groups.get(o.feature) ?? []
        list.push({ label: o.label, icon: iconForClass(o.eClass), action: () => onPick(o) })
        groups.set(o.feature, list)
    }
    return [...groups].map(([group, entries]) => ({ group, entries }))
}

function iconForClass(eClass: string): string {
    const map: Record<string, string> = {
        EPackage: "package",
        EClass: "class",
        EAttribute: "attribute",
        EReference: "reference",
        EOperation: "operation",
        EParameter: "parameter",
        EEnum: "enum",
        EEnumLiteral: "literal",
        EDataType: "datatype",
        EAnnotation: "annotation",
        EStringToStringMapEntry: "entry",
        ETypeParameter: "typeparam",
        EGenericType: "generic"
    }
    return map[eClass] ?? "object"
}

function openContextMenu(x: number, y: number, id: string | null): void {
    closeMenu()
    if (!snapshot) return
    const entries: MenuEntry[] = []
    const node = id ? nodesById.get(id) : undefined
    if (node) {
        const childOptions = snapshot.childOptions[node.eClass] ?? []
        entries.push({
            label: "New Child",
            disabled: readOnly || !childOptions.length,
            submenu: groupOptions(childOptions, (o) => {
                expanded.add(node.id)
                focusNameOnNextProps = true
                edit({ type: "create", parentId: node.id, feature: o.feature, nsURI: o.nsURI, eClass: o.eClass })
            })
        })
        const parent = parentOf.get(node.id)
        const siblingOptions = parent ? (snapshot.childOptions[parent.eClass] ?? []) : snapshot.rootOptions
        entries.push({
            label: "New Sibling",
            disabled: readOnly || !siblingOptions.length,
            submenu: groupOptions(siblingOptions, (o) => {
                const siblings = parent ? parent.children : snapshot!.roots
                const position = siblings.indexOf(node)
                const sameFeature = o.feature === (node.feature ?? "")
                focusNameOnNextProps = true
                edit({
                    type: "create",
                    parentId: parent ? parent.id : null,
                    feature: o.feature || undefined,
                    nsURI: o.nsURI,
                    eClass: o.eClass,
                    index: sameFeature && position >= 0 ? position + 1 : undefined
                })
            })
        })
        entries.push({ label: "-" })
        entries.push({ label: "Move Up", disabled: readOnly, action: () => edit({ type: "move", id: node.id, delta: -1 }) })
        entries.push({ label: "Move Down", disabled: readOnly, action: () => edit({ type: "move", id: node.id, delta: 1 }) })
        entries.push({ label: "-" })
        entries.push({ label: "Delete", disabled: readOnly, action: () => edit({ type: "delete", id: node.id }) })
    } else {
        entries.push({
            label: "New Root",
            disabled: readOnly,
            submenu: [
                {
                    group: "",
                    entries: snapshot.rootOptions.map((o) => ({
                        label: o.label,
                        icon: iconForClass(o.eClass),
                        action: () => {
                            focusNameOnNextProps = true
                            edit({ type: "create", parentId: null, nsURI: o.nsURI, eClass: o.eClass })
                        }
                    }))
                }
            ]
        })
    }

    menu = el("div", { id: "menu", role: "menu" })
    for (const entry of entries) menu.append(renderMenuEntry(entry))
    document.body.append(menu)
    const rect = menu.getBoundingClientRect()
    menu.style.left = Math.max(0, Math.min(window.innerWidth - rect.width - 2, x)) + "px"
    menu.style.top = Math.max(0, Math.min(window.innerHeight - rect.height - 2, y)) + "px"
}

function renderMenuEntry(entry: MenuEntry): HTMLElement {
    if (entry.label === "-") return el("div", { class: "separator" })
    const item = el("div", { class: "item" + (entry.disabled ? " disabled" : "") + (entry.submenu ? " submenu" : ""), role: "menuitem" })
    if (entry.icon) item.append(icon(entry.icon))
    item.append(el("span", { text: entry.label }))
    if (entry.disabled) return item
    if (entry.submenu) {
        const sub = el("div", { class: "sub" })
        for (const group of entry.submenu) {
            if (group.group) sub.append(el("div", { class: "group", text: group.group }))
            for (const e of group.entries) sub.append(renderMenuEntry(e))
        }
        item.append(sub)
        const open = () => {
            for (const other of menu?.querySelectorAll(":scope > .item.open") ?? []) other.classList.remove("open")
            item.classList.add("open")
            const r = sub.getBoundingClientRect()
            if (r.right > window.innerWidth) sub.style.left = -r.width + "px"
            if (r.bottom > window.innerHeight) sub.style.top = window.innerHeight - r.bottom - 5 + "px"
        }
        item.addEventListener("mouseenter", open)
        item.addEventListener("click", (e) => {
            if (e.target instanceof Element && sub.contains(e.target)) return
            open()
        })
    } else if (entry.action) {
        item.addEventListener("click", (e) => {
            e.stopPropagation()
            closeMenu()
            entry.action!()
        })
    }
    return item
}

// -------------------------------------------------------------------------------------------------
// Properties
// -------------------------------------------------------------------------------------------------

function renderProperties(): void {
    props.replaceChildren()
    if (!properties) {
        props.append(el("div", { class: "placeholder", text: snapshot?.roots.length ? "Select an element to edit its properties." : "" }))
        return
    }
    const p = properties
    props.append(
        el("h3", {}, icon(p.icon), el("span", { text: p.label || `<${p.eClass}>` })),
        el("div", { class: "fragment", text: `${p.eClass} • ${readableFragment(p.fragment)}` })
    )
    const table = el("div", { class: "prop-table" })
    const attributes = p.props.filter((d) => d.kind === "attribute")
    const references = p.props.filter((d) => d.kind === "reference")
    const addRows = (title: string, descriptors: PropertyDescriptor[]) => {
        if (!descriptors.length) return
        table.append(el("div", { class: "section", text: title }))
        for (const d of descriptors) {
            const label = el("label", { text: d.label, title: `${d.feature} : ${d.typeName}${d.many ? "[]" : ""}` })
            const editor = renderEditor(p.id, d)
            if (editor.id) label.setAttribute("for", editor.id)
            table.append(label, editor)
        }
    }
    addRows("Attributes", attributes)
    addRows("References", references)
    props.append(table)
    if (focusNameOnNextProps) {
        focusNameOnNextProps = false
        focusNameProperty()
    }
}

function renderEditor(id: string, d: PropertyDescriptor): HTMLElement {
    const disabled = readOnly || !d.changeable
    const domId = `prop-${d.feature}`
    const commitText = (value: string) => edit({ type: "set", id, feature: d.feature, value: value === "" ? null : value })

    if (d.kind === "reference") return d.many ? renderManyReference(id, d, disabled) : renderSingleReference(id, d, disabled, domId)

    if (d.many) {
        const values = (d.value as (string | number | boolean)[]) ?? []
        const area = el("textarea", { id: domId, rows: "3", disabled, placeholder: "one value per line" }) as HTMLTextAreaElement
        area.value = values.map(String).join("\n")
        area.addEventListener("change", () =>
            edit({
                type: "setMany",
                id,
                feature: d.feature,
                values: area.value
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean)
            })
        )
        return area
    }

    switch (d.input) {
        case "boolean": {
            const box = el("input", { type: "checkbox", id: domId, disabled }) as HTMLInputElement
            box.checked = d.value === true
            box.addEventListener("change", () => edit({ type: "set", id, feature: d.feature, value: box.checked ? "true" : "false" }))
            return el("div", {}, box)
        }
        case "enum": {
            const select = el("select", { id: domId, disabled }) as HTMLSelectElement
            select.append(el("option", { value: "", text: "(default)" }))
            for (const l of d.literals ?? []) select.append(el("option", { value: l, text: l }))
            select.value = d.value == null ? "" : String(d.value)
            select.addEventListener("change", () => commitText(select.value))
            return select
        }
        case "number": {
            const input = el("input", { type: "number", step: "any", id: domId, disabled }) as HTMLInputElement
            input.value = d.value == null ? "" : String(d.value)
            attachTextCommit(input, commitText)
            return input
        }
        default: {
            const input = el("input", { type: "text", id: domId, disabled, spellcheck: "false" }) as HTMLInputElement
            input.value = d.value == null ? "" : String(d.value)
            attachTextCommit(input, commitText)
            return input
        }
    }
}

function attachTextCommit(input: HTMLInputElement, commit: (value: string) => void): void {
    const original = input.value
    let committed = original
    input.addEventListener("change", () => {
        if (input.value !== committed) {
            committed = input.value
            commit(input.value)
        }
    })
    input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            input.value = committed
            e.stopPropagation()
        } else if (e.key === "Enter") {
            input.blur()
            tree.focus()
        }
    })
}

function candidateOptions(d: PropertyDescriptor, exclude: Set<string>): HTMLElement[] {
    const local = (d.candidates ?? []).filter((c) => !c.id.startsWith("uri:") && !exclude.has(c.id))
    const external = (d.candidates ?? []).filter((c) => c.id.startsWith("uri:") && !exclude.has(c.id))
    const groups: HTMLElement[] = []
    const build = (label: string, refs: Ref[]) => {
        if (!refs.length) return
        const group = el("optgroup", { label })
        for (const c of refs) group.append(el("option", { value: c.id, text: c.label, title: readableFragment(c.detail) }))
        groups.push(group)
    }
    build("This model", local)
    build("External", external)
    return groups
}

function renderSingleReference(id: string, d: PropertyDescriptor, disabled: boolean, domId: string): HTMLElement {
    const select = el("select", { id: domId, disabled }) as HTMLSelectElement
    select.append(el("option", { value: "", text: "(none)" }))
    const current = d.value as Ref | null
    const known = new Set((d.candidates ?? []).map((c) => c.id))
    if (current && !known.has(current.id)) select.append(el("option", { value: current.id, text: current.label, title: readableFragment(current.detail) }))
    select.append(...candidateOptions(d, new Set()))
    select.value = current ? current.id : ""
    select.addEventListener("change", () => edit({ type: "setRef", id, feature: d.feature, target: select.value || null }))
    if (!current || !isLocal(current)) return select
    const jump = el("button", { class: "jump", title: `Go to ${current.label} (Ctrl+Click)`, text: "→", "aria-label": `Go to ${current.label}` })
    jump.addEventListener("click", () => goTo(current.id))
    select.addEventListener("mousedown", (e) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            goTo(current.id)
        }
    })
    return el("div", { class: "with-jump" }, select, jump)
}

function isLocal(ref: Ref): boolean {
    return !ref.id.startsWith("uri:")
}

function jumpTitle(ref: Ref): string | undefined {
    const detail = readableFragment(ref.detail)
    return isLocal(ref) ? (detail ? `${detail}\nCtrl+Click to go to the declaration` : "Ctrl+Click to go to the declaration") : detail
}

function renderManyReference(id: string, d: PropertyDescriptor, disabled: boolean): HTMLElement {
    const values = (d.value as Ref[]) ?? []
    const container = el("div", { class: "many" })
    const chips = el("div", { class: "chips" })
    const commit = (next: Ref[]) => edit({ type: "setRefs", id, feature: d.feature, targets: next.map((r) => r.id) })
    values.forEach((ref, i) => {
        const chip = el("span", { class: "chip" + (isLocal(ref) ? " local" : ""), title: jumpTitle(ref) }, el("span", { text: ref.label }))
        if (isLocal(ref)) {
            chip.addEventListener("click", (e) => {
                if ((e.ctrlKey || e.metaKey) && !(e.target as Element).closest("button")) goTo(ref.id)
            })
        }
        if (!disabled) {
            if (i > 0) {
                const up = el("button", { class: "move", title: "Move up", text: "▲" })
                up.addEventListener("click", () => {
                    const next = [...values]
                    ;[next[i - 1], next[i]] = [next[i], next[i - 1]]
                    commit(next)
                })
                chip.append(up)
            }
            const remove = el("button", { title: "Remove", text: "×" })
            remove.addEventListener("click", () => commit(values.filter((_, j) => j !== i)))
            chip.append(remove)
        }
        chips.append(chip)
    })
    container.append(chips)
    if (!disabled) {
        const add = el("select", { "aria-label": `Add ${d.label}` }) as HTMLSelectElement
        add.append(el("option", { value: "", text: "Add…" }))
        add.append(...candidateOptions(d, new Set(values.map((v) => v.id))))
        add.addEventListener("change", () => {
            const picked = (d.candidates ?? []).find((c) => c.id === add.value)
            if (picked) commit([...values, picked])
            add.value = ""
        })
        container.append(add)
    }
    return container
}

/** Updates editors in place when the same object is refreshed, so a field being typed in keeps its focus. */
function patchProperties(next: ObjectProperties): boolean {
    if (!properties || properties.id !== next.id) return false
    const sameShape =
        properties.props.length === next.props.length &&
        properties.props.every((p, i) => p.feature === next.props[i].feature && p.input === next.props[i].input && p.many === next.props[i].many)
    if (!sameShape) return false
    const active = document.activeElement
    for (const d of next.props) {
        if (d.kind === "reference" || d.many) return false // simpler to rebuild
        const input = document.getElementById(`prop-${d.feature}`) as HTMLInputElement | HTMLSelectElement | null
        if (!input || input === active) continue
        if (d.input === "boolean") (input as HTMLInputElement).checked = d.value === true
        else input.value = d.value == null ? "" : String(d.value)
    }
    const header = props.querySelector("h3 span")
    if (header) header.textContent = next.label || `<${next.eClass}>`
    const fragment = props.querySelector(".fragment")
    if (fragment) fragment.textContent = `${next.eClass} • ${readableFragment(next.fragment)}`
    properties = next
    return true
}

function focusNameProperty(): void {
    const input = document.getElementById("prop-name") as HTMLInputElement | null
    if (input) {
        input.focus()
        input.select()
    } else focusFirstProperty()
}

function focusFirstProperty(): void {
    const first = props.querySelector<HTMLElement>("input, select, textarea")
    first?.focus()
}

// -------------------------------------------------------------------------------------------------
// Messages from the extension host
// -------------------------------------------------------------------------------------------------

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
    const message = event.data
    switch (message.type) {
        case "model": {
            snapshot = message.snapshot
            readOnly = !!snapshot.fatal || snapshot.diagnostics.some((d) => d.severity === "error")
            indexNodes()
            if (firstModel) {
                firstModel = false
                const state = vscode.getState()
                if (state) {
                    expanded = new Set(state.expanded.filter((id) => nodesById.has(id)))
                    selectedId = state.selected && nodesById.has(state.selected) ? state.selected : null
                    treeWidth = state.treeWidth
                    if (treeWidth) tree.style.flexBasis = treeWidth + "px"
                }
                if (!state || !state.expanded.length) {
                    for (const r of snapshot.roots) {
                        expanded.add(r.id)
                        for (const c of r.children) if (c.children.length) expanded.add(c.id)
                    }
                }
            }
            for (const id of [...expanded]) if (!nodesById.has(id)) expanded.delete(id)
            if (message.selectId !== undefined) {
                selectedId = message.selectId && nodesById.has(message.selectId) ? message.selectId : null
                if (selectedId) reveal(selectedId)
            } else if (selectedId && !nodesById.has(selectedId)) {
                selectedId = null
                properties = null
                renderProperties()
            }
            renderBanner()
            renderTree()
            persist()
            if (selectedId && message.selectId === undefined) post({ type: "select", id: selectedId })
            if (!selectedId) {
                properties = null
                renderProperties()
            }
            break
        }
        case "properties": {
            if (message.object && message.object.id !== selectedId) break
            if (message.object && patchProperties(message.object)) break
            properties = message.object
            renderProperties()
            break
        }
        case "error":
            toast(message.message)
            break
    }
})

renderProperties()
post({ type: "ready" })

/**
 * The URI fragment of an object percent-encodes the source of annotations and other keys, wrapped in
 * `%...%` (e.g. `//Root/%http:%2F%2Fexample.org%`); show the escapes decoded, keeping the delimiters.
 */
function readableFragment(fragment: string | undefined): string | undefined {
    return fragment?.replace(/%[0-9A-Fa-f]{2}/g, (escape) => {
        try {
            return decodeURIComponent(escape)
        } catch {
            return escape
        }
    })
}
