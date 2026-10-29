// *****************************************************************************
// Copyright(c) 2026 MASA Group
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// *****************************************************************************

/** One containment step from a parent to a child: the feature holding it and its index in that feature. */
export interface ContainmentStep {
    feature: string
    index: number
}

/** Position of an element's tag name in the XMI text. */
export interface TextSpan {
    offset: number
    length: number
}

interface Element {
    name: string
    /** Offset of the tag name (just after "<"). */
    offset: number
    children: Element[]
}

/**
 * Finds the start tag of the element reached from root number `rootIndex` by `steps`.
 *
 * XMI writes the objects of a containment feature as child elements named after the feature, in
 * list order, so the n-th object of a feature is the n-th child element with that name. With several
 * roots, the document wraps them in an `xmi:XMI` element.
 */
export function locateElement(text: string, rootIndex: number, steps: ContainmentStep[]): TextSpan | undefined {
    const top = parseElements(text)
    const roots = top.length === 1 && localName(top[0].name) === "XMI" ? top[0].children : top
    let element = roots[rootIndex]
    for (const step of steps) {
        if (!element) return undefined
        element = element.children.filter((c) => localName(c.name) === step.feature)[step.index]
    }
    return element ? { offset: element.offset, length: element.name.length } : undefined
}

function localName(name: string): string {
    const ndx = name.indexOf(":")
    return ndx >= 0 ? name.slice(ndx + 1) : name
}

/** A tolerant scan of the element structure: tags only, no attribute or text decoding. */
function parseElements(text: string): Element[] {
    const top: Element[] = []
    const stack: Element[] = []
    const n = text.length
    let i = 0
    const skipTo = (from: number, end: string) => {
        const e = text.indexOf(end, from)
        return e < 0 ? n : e + end.length
    }
    while (i < n) {
        const lt = text.indexOf("<", i)
        if (lt < 0) break
        if (text.startsWith("<!--", lt)) {
            i = skipTo(lt + 4, "-->")
        } else if (text.startsWith("<![CDATA[", lt)) {
            i = skipTo(lt + 9, "]]>")
        } else if (text.startsWith("<?", lt)) {
            i = skipTo(lt + 2, "?>")
        } else if (text.startsWith("<!", lt)) {
            i = skipTo(lt + 2, ">")
        } else if (text[lt + 1] === "/") {
            stack.pop()
            i = skipTo(lt + 2, ">")
        } else {
            let j = lt + 1
            while (j < n && !/[\s/>]/.test(text[j])) j++
            const element: Element = { name: text.slice(lt + 1, j), offset: lt + 1, children: [] }
            let quote: string | null = null
            while (j < n) {
                const c = text[j]
                if (quote) {
                    if (c === quote) quote = null
                } else if (c === '"' || c === "'") {
                    quote = c
                } else if (c === ">") {
                    break
                }
                j++
            }
            const parent = stack[stack.length - 1]
            if (parent) parent.children.push(element)
            else top.push(element)
            if (text[j - 1] !== "/") stack.push(element)
            i = j + 1
        }
    }
    return top
}
