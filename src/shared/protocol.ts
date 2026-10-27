// *****************************************************************************
// Copyright(c) 2026 MASA Group
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// *****************************************************************************

/** Messages exchanged between the extension host and the editor webview. */

export interface Ref {
    /** Local object id, or "uri:<absolute uri>" for objects living outside the edited document. */
    id: string
    label: string
    /** Tooltip / disambiguation text (fragment path or resource name). */
    detail?: string
}

export interface TreeNode {
    id: string
    eClass: string
    icon: string
    label: string
    detail?: string
    abstract?: boolean
    /** Name of the containment feature holding this node (undefined for roots). */
    feature?: string
    /** Id of the declaration this node points to (eType of a typed element, first super type of a class), when it lives in this document. */
    typeId?: string
    children: TreeNode[]
}

export interface ChildOption {
    feature: string
    nsURI: string
    eClass: string
    label: string
}

export interface ModelDiagnostic {
    message: string
    line: number
    column: number
    severity: "error" | "warning"
}

export interface ModelSnapshot {
    roots: TreeNode[]
    /** Available "New Child" entries keyed by the eClass name of the parent. */
    childOptions: Record<string, ChildOption[]>
    /** Available root objects when the document is empty. */
    rootOptions: ChildOption[]
    diagnostics: ModelDiagnostic[]
    /** Set when the text could not be parsed at all: editing is disabled. */
    fatal?: ModelDiagnostic
}

export type PropertyInput = "text" | "number" | "boolean" | "enum" | "reference"

export interface PropertyDescriptor {
    feature: string
    label: string
    kind: "attribute" | "reference"
    many: boolean
    changeable: boolean
    input: PropertyInput
    typeName: string
    /** Enum literals (input == "enum"). */
    literals?: string[]
    /** Reference candidates (input == "reference"). */
    candidates?: Ref[]
    /** Attribute: string | number | boolean | null, or an array of those when many. Reference: Ref | null, or Ref[] when many. */
    value: unknown
}

export interface ObjectProperties {
    id: string
    eClass: string
    label: string
    icon: string
    fragment: string
    props: PropertyDescriptor[]
}

export type EditCommand =
    | { type: "set"; id: string; feature: string; value: string | null }
    | { type: "setMany"; id: string; feature: string; values: string[] }
    | { type: "setRef"; id: string; feature: string; target: string | null }
    | { type: "setRefs"; id: string; feature: string; targets: string[] }
    | { type: "create"; parentId: string | null; feature?: string; nsURI: string; eClass: string; index?: number }
    | { type: "delete"; id: string }
    | { type: "move"; id: string; delta: number }

export type HostMessage =
    | { type: "model"; snapshot: ModelSnapshot; selectId?: string | null }
    | { type: "properties"; object: ObjectProperties | null }
    | { type: "error"; message: string }

export type WebviewMessage =
    | { type: "ready" }
    | { type: "select"; id: string | null }
    | { type: "edit"; command: EditCommand }
    | { type: "openText" }
