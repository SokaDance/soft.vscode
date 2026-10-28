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
    packagesCollapsed?: boolean
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
    vscode.setState({ expanded: [...expanded], selected: selectedId, treeWidth: treeWidth, packagesCollapsed })
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
const packagesPanel = el("div", { id: "packages" })
const left = el("div", { id: "left" }, tree, packagesPanel)
const splitter = el("div", { id: "splitter" })
const props = el("div", { id: "props" })
const main = el("div", { id: "main" }, left, splitter, props)
let packagesCollapsed = false
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
        renderProperties() // refresh the highlighted attributes
    }, 120)
})
filterInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        filterInput.value = ""
        filter = ""
        renderTree()
        renderProperties()
    } else if (e.key === "Enter" || e.key === "ArrowDown") {
        // apply the pending filter now, then go to the first match
        e.preventDefault()
        window.clearTimeout(filterTimer)
        filter = filterInput.value.trim().toLowerCase()
        renderTree()
        const id = filter ? firstMatch() : undefined
        if (id) goTo(id)
        else tree.focus()
    }
})

let treeWidth: number | undefined
splitter.addEventListener("mousedown", (e) => {
    e.preventDefault()
    splitter.classList.add("dragging")
    const onMove = (ev: MouseEvent) => {
        const rect = main.getBoundingClientRect()
        treeWidth = Math.max(160, Math.min(rect.width - 200, ev.clientX - rect.left))
        left.style.flexBasis = treeWidth + "px"
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
    } else if (snapshot.readOnlyReason) {
        text = snapshot.readOnlyReason
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

/** Attribute values of `node` containing the filter, as [feature, value] pairs. */
function valueMatches(node: TreeNode): [string, string][] {
    if (!filter || !node.values) return []
    return Object.entries(node.values).filter(([, v]) => v.toLowerCase().includes(filter))
}

/** True when `node` itself matches the filter: its label, its class name or one of its attribute values. */
function selfMatches(node: TreeNode): boolean {
    return node.label.toLowerCase().includes(filter) || node.eClass.toLowerCase() === filter || valueMatches(node).length > 0
}

function visibleRows(): Row[] {
    const rows: Row[] = []
    if (!snapshot) return rows
    let matches: Set<string> | null = null
    if (filter) {
        matches = new Set()
        const visit = (node: TreeNode): boolean => {
            let hit = selfMatches(node)
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
                    (node.abstract ? " abstract" : "") +
                    (node.typeId ? " linkable" : ""),
                role: "treeitem",
                "data-id": node.id,
                title: node.detail ? `${node.eClass} ${node.detail}` : node.eClass
            },
            el("span", { class: "twistie" + (hasChildren ? "" : " empty") }),
            icon(node.icon),
            highlighted("label", node.label || `<${node.eClass}>`),
            node.detail ? highlighted("detail", node.detail) : null,
            valueSnippet(node)
        )
        row.style.paddingLeft = 4 + depth * 16 + "px"
        fragment.append(row)
    }
    tree.append(fragment)
    tree.scrollTop = scrollTop
}

// -------------------------------------------------------------------------------------------------
// External packages (collapsible panel under the tree)
// -------------------------------------------------------------------------------------------------

function renderPackages(): void {
    packagesPanel.replaceChildren()
    if (!snapshot) return
    const list = snapshot.externalPackages
    const locked = snapshot.readOnlyReason
    const header = el(
        "div",
        { class: "header", role: "button", tabindex: "0", title: packagesCollapsed ? "Show the external packages" : "Hide the external packages" },
        el("span", { class: "twistie" + (packagesCollapsed ? "" : " open") }),
        el("span", { class: "title", text: "External packages" }),
        el("span", { class: "count", text: String(list.length) })
    )
    const add = el("button", {
        class: "add",
        text: "+",
        "aria-label": "Add package",
        title: locked ?? "Add an .ecore file whose elements can be referenced",
        disabled: !!locked
    })
    add.addEventListener("click", (e) => {
        e.stopPropagation()
        post({ type: "addPackage" })
    })
    header.append(add)
    const toggle = () => {
        packagesCollapsed = !packagesCollapsed
        persist()
        renderPackages()
    }
    header.addEventListener("click", toggle)
    header.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            toggle()
        }
    })
    packagesPanel.append(header)
    if (packagesCollapsed) return
    const body = el("div", { class: "list" })
    if (!list.length) body.append(el("div", { class: "placeholder", text: "No external package." }))
    for (const p of list) {
        const blocked = p.referenced ? `Cannot remove: ${p.label} is referenced by this file` : locked
        const remove = el("button", {
            class: "remove",
            text: "×",
            "aria-label": `Remove ${p.label}`,
            title: blocked ?? `Remove ${p.label} from the external packages`,
            disabled: !!blocked
        })
        if (!blocked) remove.addEventListener("click", () => post({ type: "removePackage", uri: p.uri }))
        const row = el(
            "div",
            { class: "pkg" + (p.missing ? " missing" : ""), title: p.path },
            icon("package"),
            el("span", { class: "name", text: p.label }),
            el("span", { class: "path", text: p.path }),
            remove
        )
        body.append(row)
    }
    packagesPanel.append(body)
}

/** For a node matched through its attribute values (not its label): "feature: …value…" with the match marked. */
function valueSnippet(node: TreeNode): HTMLElement | null {
    // nothing to add when the match is already visible in the label or the detail
    if (!filter || node.label.toLowerCase().includes(filter) || node.detail?.toLowerCase().includes(filter)) return null
    const found = valueMatches(node)
    if (!found.length) return null
    const [feature, value] = found[0]
    const at = value.toLowerCase().indexOf(filter)
    const from = Math.max(0, at - 12)
    const to = Math.min(value.length, at + filter.length + 24)
    const text = (from > 0 ? "…" : "") + value.slice(from, to).replace(/\s+/g, " ") + (to < value.length ? "…" : "")
    const span = el("span", { class: "match", title: found.map(([f, v]) => `${f}: ${v}`).join("\n") }, el("span", { class: "feature", text: feature + ": " }))
    span.append(highlighted("value", text))
    if (found.length > 1) span.append(el("span", { class: "more", text: ` +${found.length - 1}` }))
    return span
}

/** First node, in tree order, that matches the filter by itself. */
function firstMatch(): string | undefined {
    for (const { node } of visibleRows()) if (selfMatches(node)) return node.id
    return undefined
}

/** A span showing `text`, with every occurrence of the filter (case insensitive) wrapped in <mark>. */
function highlighted(cls: string, text: string): HTMLElement {
    const span = el("span", { class: cls })
    if (!filter) {
        span.textContent = text
        return span
    }
    const lower = text.toLowerCase()
    let from = 0
    for (let at = lower.indexOf(filter); at >= 0; at = lower.indexOf(filter, from)) {
        if (at > from) span.append(text.slice(from, at))
        span.append(el("mark", { text: text.slice(at, at + filter.length) }))
        from = at + filter.length
    }
    if (from < text.length) span.append(text.slice(from))
    return span
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

/** Selects `id` in the tree, expanding its ancestors and scrolling it into view; an external object is opened in its own editor. */
function goTo(id: string): void {
    if (id.startsWith("uri:")) {
        post({ type: "openExternal", uri: id.slice(4) })
        return
    }
    if (!nodesById.has(id)) return
    reveal(id)
    renderTree()
    select(id)
    showRow(id)
    tree.focus()
}

/** Scrolls the row of `id` into view and flashes it, so a jump from elsewhere is easy to follow. */
function showRow(id: string): void {
    const row = tree.querySelector<HTMLElement>(`.row[data-id="${CSS.escape(id)}"]`)
    if (!row) return
    row.scrollIntoView({ block: "nearest" })
    row.classList.remove("flash")
    void row.offsetWidth // restart the animation when the same row is flashed twice
    row.classList.add("flash")
    row.addEventListener("animationend", () => row.classList.remove("flash"), { once: true })
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

// While Ctrl (or Cmd) is held, elements that lead to a declaration are shown as links (see body.ctrl in the CSS).
function trackModifier(e: KeyboardEvent | MouseEvent): void {
    document.body.classList.toggle("ctrl", e.ctrlKey || e.metaKey)
}
window.addEventListener("keydown", trackModifier)
window.addEventListener("keyup", trackModifier)
window.addEventListener("mousemove", trackModifier)
window.addEventListener("blur", () => document.body.classList.remove("ctrl"))

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
            // the same values as the tree filter: attributes set on the object (not their defaults)
            const value = nodesById.get(p.id)?.values?.[d.feature]
            if (filter && value?.toLowerCase().includes(filter)) label.classList.add("match")
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
    if (!current) return select
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

/** True when the Ctrl (or Cmd) modifier of a go-to-declaration click is held. */
function isModified(e: MouseEvent): boolean {
    return e.ctrlKey || e.metaKey
}

// Ctrl+click on a reference chip navigates to the declaration. The listener captures on the panel, so it runs
// before the remove/move buttons of the chip and swallows the event whatever part of the chip was hit.
for (const type of ["mousedown", "click"] as const) {
    props.addEventListener(
        type,
        (e) => {
            const target = e.target as Element
            const chip = target.closest<HTMLElement>(".chip[data-ref]")
            if (!chip || !isModified(e) || e.button !== 0) return
            e.preventDefault()
            e.stopPropagation()
            if (type === "click") goTo(chip.dataset.ref!)
        },
        true
    )
}

function jumpTitle(ref: Ref): string {
    const detail = readableFragment(ref.detail)
    return detail ? `${detail}\nCtrl+Click to go to the declaration` : "Ctrl+Click to go to the declaration"
}

function renderManyReference(id: string, d: PropertyDescriptor, disabled: boolean): HTMLElement {
    const values = (d.value as Ref[]) ?? []
    const container = el("div", { class: "many" })
    const chips = el("div", { class: "chips" })
    const commit = (next: Ref[]) => edit({ type: "setRefs", id, feature: d.feature, targets: next.map((r) => r.id) })
    values.forEach((ref, i) => {
        // a modified click anywhere on the chip navigates: handled by the capturing listener on the panel
        const chip = el("span", { class: "chip", title: jumpTitle(ref), "data-ref": ref.id }, el("span", { text: ref.label }))
        if (!disabled) {
            if (i > 0) {
                const up = el("button", { class: "move", title: "Move up", text: "▲" })
                up.addEventListener("click", (e) => {
                    if (isModified(e)) return
                    const next = [...values]
                    ;[next[i - 1], next[i]] = [next[i], next[i - 1]]
                    commit(next)
                })
                chip.append(up)
            }
            const remove = el("button", { title: "Remove", text: "×" })
            remove.addEventListener("click", (e) => {
                if (isModified(e)) return
                commit(values.filter((_, j) => j !== i))
            })
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
            readOnly = !!snapshot.readOnlyReason || !!snapshot.fatal || snapshot.diagnostics.some((d) => d.severity === "error")
            indexNodes()
            if (firstModel) {
                firstModel = false
                const state = vscode.getState()
                if (state) {
                    expanded = new Set(state.expanded.filter((id) => nodesById.has(id)))
                    selectedId = state.selected && nodesById.has(state.selected) ? state.selected : null
                    treeWidth = state.treeWidth
                    if (treeWidth) left.style.flexBasis = treeWidth + "px"
                    packagesCollapsed = !!state.packagesCollapsed
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
            renderPackages()
            persist()
            if (selectedId && message.selectId !== undefined) {
                // selection chosen by the host (go to declaration, new element): make sure it is visible
                showRow(selectedId)
            }
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
